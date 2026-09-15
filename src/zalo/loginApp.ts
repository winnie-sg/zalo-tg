/**
 * loginApp.ts
 * ──────────
 * QR login via Zalo PC-App API (wpa.zaloapp.com) — TypeScript remake of zalo_caller.py.
 *
 * Flow:
 *   1. reqqr        → get base64 QR image + poll URL
 *   2. poll         → wait for user to scan QR on phone
 *   3. getLoginInfo → get session cookies + imei + uid
 *   4. zalo.login() → hydrate zca-js with those credentials
 *
 * After success, the returned ZaloAPI can be used exactly like the web QR login result.
 */

import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import axios, { type AxiosInstance } from 'axios';
import { Zalo } from 'zca-js';
import { imageSizeFromFile } from '../utils/media.js';
import { statSync } from 'node:fs';
import { config } from '../config.js';
import { writePrivateJsonFileSync } from '../utils/privateFile.js';
import { createSharedTempPath, prepareSharedTempFile } from '../utils/sharedTemp.js';
import type { ZaloAPI } from './types.js';
import type { QRLoginHooks } from './client.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const AUTH_DOMAIN = 'https://wpa.zaloapp.com';
const API_TYPE    = 30;   // PC client
const API_VERSION = 671;
const PC_UA       = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ZaloPC/23.12.1 Chrome/102.0.5005.167 Electron/19.1.9 Safari/537.36';

// ── Crypto helpers ────────────────────────────────────────────────────────────

function encodeAes(plaintext: string, zpwEnk: string): string {
  const key    = Buffer.from(zpwEnk, 'base64');
  const iv     = Buffer.alloc(16, 0);
  const algo   = key.length === 16 ? 'aes-128-cbc' : key.length === 24 ? 'aes-192-cbc' : 'aes-256-cbc';
  const cipher = crypto.createCipheriv(algo, key, iv);
  // PKCS7 padding is the default for AES-CBC in Node crypto
  return Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]).toString('base64');
}

function signKey(endpointName: string, params: Record<string, unknown>): string {
  const sorted = Object.keys(params).sort();
  const seed   = 'zsecure' + endpointName + sorted.map(k => String(params[k])).join('');
  return crypto.createHash('md5').update(seed, 'utf8').digest('hex');
}

/**
 * Build query-string params for PRE-login endpoints (reqqr, getLoginInfo).
 * Adds `type`, `client_version`, and computes `signkey`.
 */
function authParams(body: Record<string, unknown>, endpoint: string): Record<string, string> {
  const p: Record<string, unknown> = { ...body, type: API_TYPE, client_version: API_VERSION };
  p['signkey'] = signKey(endpoint, p);
  return Object.fromEntries(Object.entries(p).map(([k, v]) => [k, String(v)]));
}

// ── Minimal cookie jar (collect Set-Cookie, resend on next request) ────────────

interface JarCookie {
  name:     string;
  value:    string;
  domain:   string;
  path:     string;
  secure:   boolean;
  httpOnly: boolean;
  maxAge?:  number;
  sameSite: string;
  creation: string;
  lastAccessed: string;
}

class CookieJar {
  private store: Map<string, JarCookie> = new Map();

  /** Parse and store cookies from a Set-Cookie header array. */
  ingest(setCookieHeaders: string[], originUrl: string): void {
    const originHost = new URL(originUrl).hostname;
    for (const raw of setCookieHeaders) {
      const parts = raw.split(';').map(s => s.trim());
      const firstEq = parts[0]!.indexOf('=');
      if (firstEq < 0) continue;
      const name  = parts[0]!.slice(0, firstEq).trim();
      const value = parts[0]!.slice(firstEq + 1).trim();
      let domain   = originHost;
      let cookPath = '/';
      let secure   = false;
      let httpOnly = false;
      let maxAge: number | undefined;
      let sameSite = 'lax';
      for (const attr of parts.slice(1)) {
        const lower = attr.toLowerCase();
        if (lower.startsWith('domain='))   domain   = attr.slice(7).replace(/^\./, '');
        else if (lower.startsWith('path=')) cookPath = attr.slice(5);
        else if (lower.startsWith('max-age=')) maxAge = parseInt(attr.slice(8)) || undefined;
        else if (lower.startsWith('samesite=')) sameSite = attr.slice(9).toLowerCase();
        else if (lower === 'secure')   secure   = true;
        else if (lower === 'httponly') httpOnly = true;
      }
      const now = new Date().toISOString();
      this.store.set(`${domain}::${name}`, {
        name, value, domain, path: cookPath,
        secure, httpOnly, maxAge, sameSite,
        creation: now, lastAccessed: now,
      });
    }
  }

  /** Build a Cookie header string for the given URL. */
  headerFor(url: string): string {
    const { hostname, protocol } = new URL(url);
    const isSecure = protocol === 'https:';
    const parts: string[] = [];
    for (const c of this.store.values()) {
      if (!hostname.endsWith(c.domain) && hostname !== c.domain) continue;
      if (c.secure && !isSecure) continue;
      parts.push(`${c.name}=${c.value}`);
    }
    return parts.join('; ');
  }

  /**
   * Serialize all cookies to the format zca-js expects in credentials.json:
   * array of { key, value, domain, path, secure, httpOnly, maxAge?, sameSite, creation, lastAccessed }
   * (zca-js uses tough-cookie internally; this is the serialised MemoryCookieStore format.)
   */
  toZcaFormat(): Record<string, unknown>[] {
    return Array.from(this.store.values()).map(c => ({
      key:         c.name,
      value:       c.value,
      // zca-js calls wpa.chat.zalo.me — cookies issued by wpa.zaloapp.com
      // must be remapped so tough-cookie sends them to that domain.
      domain:      c.domain.includes('zaloapp.com') ? 'chat.zalo.me' : c.domain,
      path:        c.path,
      secure:      c.secure,
      httpOnly:    c.httpOnly,
      hostOnly:    false,
      creation:    c.creation,
      lastAccessed: c.lastAccessed,
      ...(c.maxAge !== undefined ? { maxAge: c.maxAge } : {}),
      sameSite:    c.sameSite,
    }));
  }

  /** Raw name/value pairs for direct PC App API calls (original zaloapp.com domain). */
  toRawPairs(): Array<{ name: string; value: string; domain: string }> {
    return Array.from(this.store.values()).map(c => ({ name: c.name, value: c.value, domain: c.domain }));
  }

  size(): number { return this.store.size; }
}

// ── HTTP session ───────────────────────────────────────────────────────────────

function createSession(jar: CookieJar): AxiosInstance {
  const ax = axios.create({
    headers: { 'User-Agent': PC_UA, 'Accept': 'application/json' },
    timeout: 20_000,
    // Do not follow redirects blindly — we want to capture Set-Cookie at each hop
    maxRedirects: 5,
  });

  // Attach cookies on every request
  ax.interceptors.request.use(req => {
    const url = (req.baseURL ?? '') + (req.url ?? '');
    const cookieHeader = jar.headerFor(url);
    if (cookieHeader) req.headers['Cookie'] = cookieHeader;
    return req;
  });

  // Collect Set-Cookie from every response
  ax.interceptors.response.use(res => {
    const url   = res.config.url ?? '';
    const raw   = res.headers['set-cookie'];
    const setCookies = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    if (setCookies.length > 0) jar.ingest(setCookies, url);
    return res;
  });

  return ax;
}

// ── QR image ──────────────────────────────────────────────────────────────────

let activeAppLoginController: AbortController | null = null;

/** Abort the currently active PC-App QR polling flow, if any. */
export function cancelActiveAppLogin(): boolean {
  if (!activeAppLoginController) return false;
  activeAppLoginController.abort();
  activeAppLoginController = null;
  return true;
}

// ── Main login flow ────────────────────────────────────────────────────────────

export interface AppLoginHooks extends QRLoginHooks {
  /** Additional hook: raw login_data from getLoginInfo (for debugging) */
  onLoginData?: (data: Record<string, unknown>) => Promise<void>;
}

/**
 * Full PC-App QR login flow. Returns a live ZaloAPI instance on success.
 *
 * @param hooks  Optional callbacks (forward QR image / status to Telegram).
 */
export async function triggerAppLogin(hooks: AppLoginHooks = {}): Promise<ZaloAPI> {
  const loginController = new AbortController();
  activeAppLoginController?.abort();
  activeAppLoginController = loginController;
  const ensureActive = (): void => {
    if (loginController.signal.aborted) throw new Error('App QR login cancelled');
  };

  try {
  const jar     = new CookieJar();
  const session = createSession(jar);
  const imei    = crypto.randomUUID() + '-' + crypto.createHash('md5').update(PC_UA).digest('hex');
  const host    = os.hostname() || 'ZaloPCClient';

  // ── Step 1: Request QR ──────────────────────────────────────────────────────
  console.log('[AppLogin] Requesting QR from Zalo PC API...');

  const reqParams = authParams({
    language:      'vi',
    client_time:   String(Math.floor(Date.now() / 1000)),
    imei,
    computer_name: host,
    logged_uids:   '[]',
  }, 'reqqr');

  const fullUrl = AUTH_DOMAIN + '/api/login/reqqr?' + new URLSearchParams(reqParams).toString();
  console.log('[AppLogin] GET', fullUrl.replace(/signkey=[^&]+/, 'signkey=REDACTED'));

  let r1Body: Record<string, unknown>;
  try {
    const r1Res = await fetch(fullUrl, {
      headers: { 'User-Agent': PC_UA, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!r1Res.ok) throw new Error(`HTTP ${r1Res.status}`);
    r1Body = await r1Res.json() as Record<string, unknown>;
  } catch (e: unknown) {
    throw new Error(`[AppLogin] reqqr network error: ${e instanceof Error ? e.message : String(e)}`);
  }

  console.log('[AppLogin] reqqr response:', JSON.stringify(r1Body).slice(0, 300));

  if (r1Body.error_code !== 0) {
    throw new Error(`[AppLogin] reqqr failed [${String(r1Body.error_code)}]: ${String(r1Body.error_message ?? JSON.stringify(r1Body))}`);
  }

  const inner     = (r1Body.data as Record<string, unknown> | undefined) ?? {};
  const base64Qr  = String(inner.base64_qr ?? '');
  const tokenId   = String(inner.token_id ?? '');
  const pollUrl   = String(inner.chk_wait_cfirm ?? '');

  if (!base64Qr && !tokenId) {
    throw new Error('[AppLogin] No QR data in reqqr response: ' + JSON.stringify(inner));
  }

  // Save QR image (prefer base64 PNG from server, fall back to generated).
  // Use a fresh, writable path per login so stale/root-owned Docker files under
  // /tmp from older runs cannot break non-root containers with EACCES.
  const qrImgPath = createSharedTempPath('zalo-tg-app', 'zalo-app-qr', '.png');
  if (base64Qr) {
    writeFileSync(qrImgPath, Buffer.from(base64Qr, 'base64'));
  } else {
    // Generate QR PNG from token_id using the qrcode npm package
    const qrcode = await import('qrcode');
    await qrcode.toFile(qrImgPath, tokenId, { width: 400, margin: 2 });
  }
  prepareSharedTempFile(qrImgPath);

  // Notify hook (e.g. send photo to Telegram)
  // Do not continue polling when Telegram failed to receive the QR. Let the
  // command handler report the error and release its in-progress lock.
  await hooks.onQRReady?.(qrImgPath, tokenId);
  ensureActive();

  // ── Step 2: Poll for scan ────────────────────────────────────────────────────
  if (!pollUrl) throw new Error('[AppLogin] No poll URL returned from reqqr');

  console.log('[AppLogin] Polling for QR scan...');
  let confirmed = false;
  for (let i = 0; i < 90 && !confirmed; i++) {
    await new Promise(r => setTimeout(r, 2000));
    ensureActive();
    try {
      const pr = await session.get<{ error_code?: number; errorCode?: number }>(pollUrl, {
        timeout: 10_000,
        signal: loginController.signal,
      });
      const ec = pr.data.error_code ?? pr.data.errorCode ?? -1;
      if (ec === 0) { confirmed = true; break; }
    } catch { /* network hiccup — keep polling */ }
  }

  if (!confirmed) throw new Error('[AppLogin] QR timeout: not scanned within 3 minutes');
  await hooks.onScanned?.('Zalo').catch(console.error);

  // ── Step 3: getLoginInfo ──────────────────────────────────────────────────────
  console.log('[AppLogin] Getting login info...');
  const r4 = await session.get<{
    error_code: number;
    error_message?: string;
    data?: Record<string, unknown>;
  }>(AUTH_DOMAIN + '/api/login/getLoginInfo', {
    signal: loginController.signal,
    params: authParams({
      imei,
      computer_name: host,
      language:      'vi',
      ts:            String(Date.now()),
    }, 'getlogininfo'),
  });

  if (r4.data.error_code !== 0) {
    throw new Error(`[AppLogin] getLoginInfo failed [${r4.data.error_code}]: ${r4.data.error_message ?? JSON.stringify(r4.data)}`);
  }

  const loginData = r4.data.data ?? {};
  const uid       = String(loginData['uid'] ?? '');
  const displayName: string = (() => {
    const n = loginData['send2me_name'] ?? loginData['name'] ?? loginData['zaloName'] ?? uid;
    if (typeof n === 'object' && n !== null) {
      const obj = n as Record<string, string>;
      return obj['VI'] ?? obj['EN'] ?? uid;
    }
    return String(n);
  })();

  await hooks.onLoginData?.(loginData).catch(console.error);
  console.log(`[AppLogin] Got credentials for ${displayName} (uid=${uid}), cookies: ${jar.size()}`);

  // ── Step 4: Hydrate zca-js ────────────────────────────────────────────────────
  const cookies = jar.toZcaFormat();
  const credentials = { imei, cookie: cookies, userAgent: PC_UA };

  // Persist so the bridge can auto-login on next restart. Session files are
  // authentication material, so keep them owner-readable only where supported.
  writePrivateJsonFileSync(config.zalo.credentialsPath, credentials);
  console.log(`[AppLogin] Credentials saved → ${config.zalo.credentialsPath}`);

  // Save app-session.json with zpw_enk + raw zaloapp.com cookies for direct PC App API calls
  const zpwEnk = String(loginData['zpw_enk'] ?? '');
  const dkey   = String(loginData['dkey'] ?? '');
  if (zpwEnk) {
    const appSessionPath = path.join(path.dirname(config.zalo.credentialsPath), 'app-session.json');
    writePrivateJsonFileSync(appSessionPath, {
      zpw_enk: zpwEnk,
      dkey: dkey || undefined,
      imei,
      cookies: jar.toRawPairs(),
    });
    console.log(`[AppLogin] App session saved → ${appSessionPath}`);
  }

  const zalo = new Zalo({
    logging:     false,
    checkUpdate: false,
    selfListen:  true,
    imageMetadataGetter: async (filePath: string) => {
      try {
        const { width, height } = await imageSizeFromFile(filePath);
        const { size } = statSync(filePath);
        return { width: width ?? 0, height: height ?? 0, size };
      } catch { return null; }
    },
  });

  const api = await zalo.login(credentials as Parameters<typeof zalo.login>[0]) as ZaloAPI;
  console.log('[AppLogin] zca-js login successful ✓');
  await hooks.onSuccess?.().catch(console.error);
  return api;
  } finally {
    if (activeAppLoginController === loginController) activeAppLoginController = null;
  }
}
