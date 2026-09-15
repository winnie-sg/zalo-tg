import { Zalo, LoginQRCallbackEventType } from 'zca-js';
import type { LoginQRCallback } from 'zca-js';
import { existsSync, readFileSync, statSync } from 'fs';
import { imageSizeFromFile } from '../utils/media.js';
import qrcode from 'qrcode-terminal';
import { config } from '../config.js';
import { writePrivateJsonFileSync } from '../utils/privateFile.js';
import { createSharedTempPath, prepareSharedTempFile } from '../utils/sharedTemp.js';
import type { ZaloAPI } from './types.js';
import { terminal } from '../utils/terminal.js';

let _api: ZaloAPI | null = null;
let _activeQRAbort: (() => void) | null = null;

/** Abort the currently active Web QR login, if any. */
export function cancelActiveQRLogin(): boolean {
  const abort = _activeQRAbort;
  if (!abort) return false;
  _activeQRAbort = null;
  abort();
  return true;
}

// ── imageMetadataGetter ───────────────────────────────────────────────────────
// Required by zca-js for uploadAttachment (images/GIFs).
const ZALO_OPTIONS = {
  logging:      false,
  checkUpdate:  false,
  selfListen:   true,
  imageMetadataGetter: async (filePath: string) => {
    try {
      const { width, height } = await imageSizeFromFile(filePath);
      const { size } = statSync(filePath);
      return { width: width ?? 0, height: height ?? 0, size };
    } catch {
      return null;
    }
  },
} as const;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface QRLoginHooks {
  /** Called when a new QR image file is ready at `imagePath`. */
  onQRReady?: (imagePath: string, code: string) => Promise<void>;
  /** Called when the current QR expired and a new one is being generated. */
  onExpired?: () => Promise<void>;
  /** Called when the user scanned the QR on their phone. */
  onScanned?: (displayName: string) => Promise<void>;
  /** Called when the user declined the login on their phone. */
  onDeclined?: () => Promise<void>;
  /** Called after credentials have been saved and login is complete. */
  onSuccess?: () => Promise<void>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function saveCredentials(data: { cookie: unknown; imei: string; userAgent: string }): void {
  try {
    writePrivateJsonFileSync(config.zalo.credentialsPath, {
      imei: data.imei,
      cookie: data.cookie,
      userAgent: data.userAgent,
    });
    console.log(`[Zalo] Credentials saved → ${config.zalo.credentialsPath}`);
  } catch (err) {
    console.error('[Zalo] Failed to save credentials:', err);
  }
}

/**
 * Core QR login flow.
 * - Always prints QR to terminal.
 * - Calls optional `hooks` so callers (e.g. Telegram handler) can forward
 *   the QR image or status messages elsewhere.
 */
async function runQRLogin(
  zalo: InstanceType<typeof Zalo>,
  hooks: QRLoginHooks = {},
): Promise<ZaloAPI> {
  let expiredCount = 0;
  let qrDeliveryError: unknown;
  const qrImagePath = createSharedTempPath('zalo-tg', 'zalo-qr', '.png');
  const callback: LoginQRCallback = (event) => {
    switch (event.type) {

      case LoginQRCallbackEventType.QRCodeGenerated: {
        const { code } = event.data;
        _activeQRAbort = event.actions.abort;

        // Save QR image first, then notify hooks
        const savePromise = event.actions.saveToFile(qrImagePath)
          .then(async () => {
            // Print to terminal
            await new Promise<void>((res) => {
              qrcode.generate(code, { small: true }, (qrStr) => {
                prepareSharedTempFile(qrImagePath);
                terminal.qr(qrImagePath);
                console.log(qrStr);
                res();
              });
            });
            // Notify external hook (e.g. send to Telegram)
            await hooks.onQRReady?.(qrImagePath, code);
          })
          .catch((err: unknown) => {
            qrDeliveryError = err;
            console.error('[Zalo] QR delivery failed:', err);
            // A login cannot succeed if the user never receives the QR. Abort so
            // Telegram can report the error and the in-progress lock is cleared.
            event.actions.abort();
          });

        void savePromise;
        break;
      }

      case LoginQRCallbackEventType.QRCodeExpired: {
        console.log('\n[Zalo] QR hết hạn, đang tạo mã mới...');
        void hooks.onExpired?.().catch((e: unknown) => console.error(e));
        expiredCount += 1;
        // Avoid leaving /login locked forever when nobody can scan the QR.
        // Two retries give the user roughly five minutes in total.
        if (expiredCount <= 2) event.actions.retry();
        else event.actions.abort();
        break;
      }

      case LoginQRCallbackEventType.QRCodeScanned: {
        const name = event.data.display_name;
        terminal.status('zalo login', `QR scanned by "${name}"`, 'success');
        void hooks.onScanned?.(name).catch((e: unknown) => console.error(e));
        break;
      }

      case LoginQRCallbackEventType.QRCodeDeclined: {
        console.error('\n[Zalo] Đăng nhập bị từ chối.');
        void hooks.onDeclined?.().catch((e: unknown) => console.error(e));
        event.actions.abort();
        break;
      }

      case LoginQRCallbackEventType.GotLoginInfo: {
        saveCredentials(event.data);
        void hooks.onSuccess?.().catch((e: unknown) => console.error(e));
        break;
      }
    }
  };

  let api: Awaited<ReturnType<typeof zalo.loginQR>>;
  try {
    api = await zalo.loginQR({ qrPath: qrImagePath }, callback);
  } catch (err) {
    if (qrDeliveryError) {
      const detail = qrDeliveryError instanceof Error
        ? qrDeliveryError.message
        : String(qrDeliveryError);
      throw new Error(`Không thể gửi ảnh QR lên Telegram: ${detail}`, { cause: qrDeliveryError });
    }
    throw err;
  } finally {
    _activeQRAbort = null;
  }
  if (!api) throw new Error('[Zalo] QR login failed – no API returned.');
  terminal.status('zalo login', 'authenticated successfully', 'success');
  return api as ZaloAPI;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Return (and lazily initialise) the Zalo API singleton.
 * Only uses saved credentials — does NOT fall back to QR login.
 * If credentials are missing or invalid, throws so the caller can notify
 * the user (e.g. via Telegram) to run /login.
 */
/** Clear the cached API instance so the next `getZaloApi()` call re-authenticates. */
export function resetZaloApi(): void {
  _api = null;
}

export async function getZaloApi(): Promise<ZaloAPI> {
  if (_api) return _api;

  if (!existsSync(config.zalo.credentialsPath)) {
    throw new Error('Chưa có file credentials.json — hãy gửi /login trong Telegram để đăng nhập lần đầu.');
  }

  const zalo = new Zalo(ZALO_OPTIONS);

  const credentials = JSON.parse(
    readFileSync(config.zalo.credentialsPath, 'utf8'),
  ) as { imei: string; cookie: unknown; userAgent: string };

  terminal.status('zalo login', 'loading saved credentials…', 'info');
  _api = (await zalo.login(credentials as Parameters<typeof zalo.login>[0])) as ZaloAPI;
  terminal.status('zalo login', 'saved session authenticated', 'success');

  return _api as ZaloAPI;
}

/**
 * Trigger a fresh QR login (e.g. from /login Telegram command).
 * Resets the cached API so the next `getZaloApi()` call will re-initialise.
 * Accepts optional hooks so the caller can forward QR images / status updates.
 */
export async function triggerQRLogin(hooks: QRLoginHooks = {}): Promise<ZaloAPI> {
  _api = null;
  const zalo = new Zalo(ZALO_OPTIONS);
  _api = await runQRLogin(zalo, hooks);
  return _api;
}
