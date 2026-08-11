import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

function requireTelegramGroupId(): number {
  const raw = requireEnv('TG_GROUP_ID');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value >= 0) {
    throw new Error('TG_GROUP_ID must be a negative safe integer (Telegram supergroup ID)');
  }
  return value;
}

function resolvePath(envVal: string | undefined, defaultRelative: string): string {
  const raw = envVal ?? defaultRelative;
  // Already absolute → use as-is, otherwise resolve from project root
  return path.isAbsolute(raw) ? raw : path.resolve(PROJECT_ROOT, raw);
}

function envFlag(key: string, defaultValue = false): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}


function localBotApiServer(): string | null {
  if (!envFlag('LOCAL_BOT_API')) return null;
  const raw = requireEnv('TG_LOCAL_SERVER').replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('TG_LOCAL_SERVER must be a valid http(s) URL when LOCAL_BOT_API is enabled');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('TG_LOCAL_SERVER must use http or https');
  }
  return raw;
}

export const config = {
  telegram: {
    token:       requireEnv('TG_TOKEN'),
    groupId:     requireTelegramGroupId(),
    /** URL của local Bot API server, ví dụ: http://localhost:8081.
     *  Chỉ dùng khi LOCAL_BOT_API=1 và TG_LOCAL_SERVER được set.
     *  Nếu không → dùng official api.telegram.org. */
    localServer: localBotApiServer(),
  },
  zalo: {
    credentialsPath: resolvePath(process.env.ZALO_CREDENTIALS_PATH, 'credentials.json'),
    skipMutedGroups: envFlag('ZALO_SKIP_MUTED_GROUPS'),
    // Mirror Zalo's "mute notifications" → deliver those threads silently on
    // Telegram (messages still arrive, just no ping). On by default; set
    // ZALO_MUTE_SILENT=0 to always notify.
    muteSilentMirror: envFlag('ZALO_MUTE_SILENT', true),
    excludedGroups: (process.env.ZALO_EXCLUDED_GROUPS ?? '').split(',').map(s => s.trim()).filter(Boolean),
  },
  dataDir: resolvePath(process.env.DATA_DIR, 'data'),
} as const;
