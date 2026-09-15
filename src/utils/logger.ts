import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const priorities: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const configuredLevel = (): LogLevel => {
  const value = process.env.LOG_LEVEL?.trim().toLowerCase();
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error' ? value : 'info';
};

function logRoot(): string {
  return path.resolve(process.env.LOG_DIR?.trim() || 'logs');
}

function dayFolder(now: Date): string {
  return [String(now.getDate()).padStart(2, '0'), String(now.getMonth() + 1).padStart(2, '0'), now.getFullYear()].join('-');
}

function redact(value: string): string {
  return value
    .replace(/(authorization|cookie|token|password|secret|signkey|imei)\s*([=:])\s*([^\s,;]+)/gi, '$1$2[REDACTED]')
    .replace(/https?:\/\/[^\s"']+/gi, '[URL]')
    .replace(/\b(content|caption|text|message|question)\s*([=:])\s*("[^"]*"|'[^']*')/gi, '$1$2[REDACTED]');
}

function render(value: unknown): string {
  if (value instanceof Error) return redact(`${value.name}: ${value.message}`);
  if (typeof value === 'string') return redact(value);
  try {
    return redact(JSON.stringify(value, (key, child) => /token|cookie|authorization|password|secret|content|caption|text|message|question/i.test(key) ? '[REDACTED]' : child));
  } catch {
    return '[Unserializable value]';
  }
}

interface LogEntry {
  target: string;
  line: string;
}

let _queue: LogEntry[] = [];
let _flushTimer: NodeJS.Timeout | null = null;
let _isFlushing = false;
let _flushPromise: Promise<void> | null = null;
let warned = false;

async function _flushInternal(): Promise<void> {
  if (_queue.length === 0) return;
  const batch = _queue;
  _queue = [];

  // Group by target file for bulk write
  const grouped = new Map<string, string[]>();
  for (const item of batch) {
    let arr = grouped.get(item.target);
    if (!arr) {
      arr = [];
      grouped.set(item.target, arr);
    }
    arr.push(item.line);
  }

  for (const [target, lines] of grouped) {
    try {
      await mkdir(path.dirname(target), { recursive: true });
      await appendFile(target, lines.join(''), 'utf8');
    } catch {
      if (!warned) {
        warned = true;
        process.stderr.write('[Logger] File logging unavailable; bridge continues.\n');
      }
    }
  }
}

export async function flush(): Promise<void> {
  if (_flushTimer) {
    clearTimeout(_flushTimer);
    _flushTimer = null;
  }
  if (_isFlushing && _flushPromise) {
    await _flushPromise;
  }
  _isFlushing = true;
  _flushPromise = _flushInternal();
  try {
    await _flushPromise;
  } finally {
    _isFlushing = false;
    _flushPromise = null;
  }
}

export function log(level: LogLevel, ...values: unknown[]): void {
  if (priorities[level] < priorities[configuredLevel()]) return;
  const now = new Date();
  const target = path.join(logRoot(), dayFolder(now), `${level}.log`);
  const line = `${now.toISOString()} ${values.map(render).join(' ')}\n`;
  _queue.push({ target, line });

  // Flush immediately if queue is large, otherwise debounce 500ms
  if (_queue.length >= 50) {
    void flush();
  } else if (!_flushTimer) {
    _flushTimer = setTimeout(() => {
      _flushTimer = null;
      void flush();
    }, 500);
    _flushTimer.unref?.();
  }
}

export const logger = {
  debug: (...values: unknown[]) => log('debug', ...values),
  info: (...values: unknown[]) => log('info', ...values),
  warn: (...values: unknown[]) => log('warn', ...values),
  error: (...values: unknown[]) => log('error', ...values),
  fromConsole(method: 'log' | 'warn' | 'error', values: unknown[]): void {
    log(method === 'log' ? 'info' : method, ...values);
  },
  flush: () => flush(),
};
