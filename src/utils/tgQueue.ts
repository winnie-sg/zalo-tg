/**
 * Rate-limit-aware concurrent queue for Telegram API calls.
 *
 * Allows up to CONCURRENCY calls in-flight simultaneously for low latency.
 * On 429 Too Many Requests: the failing call is re-queued after retry_after,
 * and all subsequent calls wait out the same pause window.
 * On transient network errors (socket hang up, ETIMEDOUT, …): the call is
 * retried inline with exponential backoff before giving up.
 */

import { isTransientNetworkError } from './zaloRetry.js';

interface QueueItem {
  fn: () => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject:  (e: unknown) => void;
  retries: number;
  priority: 'high' | 'normal';
}

const MAX_RETRIES  = 5;
const CONCURRENCY  = 5;   // max simultaneous in-flight TG calls
const MAX_TRANSIENT_RETRIES = 4;
const TRANSIENT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000] as const;

const _highQueue: QueueItem[] = [];
const _normalQueue: QueueItem[] = [];
let   _active    = 0;
let   _pauseUntil = 0; // epoch ms — global back-off on 429
let   _pauseTimer: ReturnType<typeof setTimeout> | null = null;

function is429(err: unknown): number | null {
  if (
    err != null &&
    typeof err === 'object' &&
    'response' in err &&
    (err as { response: { error_code?: number; parameters?: { retry_after?: number } } })
      .response?.error_code === 429
  ) {
    return (
      (err as { response: { parameters?: { retry_after?: number } } })
        .response?.parameters?.retry_after ?? 30
    );
  }
  return null;
}

function scheduleNext(): void {
  const now = Date.now();
  if (_pauseUntil > now) {
    if (!_pauseTimer) {
      _pauseTimer = setTimeout(() => {
        _pauseTimer = null;
        scheduleNext();
      }, _pauseUntil - now);
    }
    return;
  }

  while (_active < CONCURRENCY && (_highQueue.length > 0 || _normalQueue.length > 0)) {
    const item = (_highQueue.length > 0 ? _highQueue.shift() : _normalQueue.shift())!;
    _active++;
    void runOne(item);
  }
}

/** Run item.fn(), retrying transient network errors inline with backoff. */
async function runWithTransientRetry(fn: () => Promise<unknown>): Promise<unknown> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      // 429 is handled by the outer re-queue logic, not here
      if (is429(err) !== null || !isTransientNetworkError(err) || attempt >= MAX_TRANSIENT_RETRIES) {
        throw err;
      }
      const delay = TRANSIENT_BACKOFF_MS[attempt] ?? TRANSIENT_BACKOFF_MS[TRANSIENT_BACKOFF_MS.length - 1]!;
      console.warn(`[TGQueue] transient network error — retry #${attempt + 1} after ${delay / 1000}s`);
      await new Promise(r => setTimeout(r, delay));
      attempt++;
    }
  }
}

async function runOne(item: QueueItem): Promise<void> {
  try {
    // Honour the global pause window before firing
    const wait = _pauseUntil - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));

    const result = await runWithTransientRetry(item.fn);
    item.resolve(result);
  } catch (err) {
    const retryAfter = is429(err);
    if (retryAfter !== null && item.retries < MAX_RETRIES) {
      const delay = (retryAfter + 1) * 1000;
      console.warn(`[TGQueue] 429 — retry #${item.retries + 1} after ${retryAfter}s`);
      _pauseUntil = Math.max(_pauseUntil, Date.now() + delay);
      // Re-queue at high priority so it goes first once the pause window clears
      _highQueue.unshift({ ...item, retries: item.retries + 1 });
      if (!_pauseTimer) {
        _pauseTimer = setTimeout(() => {
          _pauseTimer = null;
          scheduleNext();
        }, delay);
      }
    } else {
      item.reject(err);
    }
  } finally {
    _active--;
    scheduleNext();
  }
}

/** Enqueue a Telegram API call. Returns a promise that resolves/rejects when done. */
export function tgQueue<T>(fn: () => Promise<T>, priority: 'high' | 'normal' = 'normal'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const item: QueueItem = {
      fn: fn as () => Promise<unknown>,
      resolve: resolve as (v: unknown) => void,
      reject,
      retries: 0,
      priority,
    };
    if (priority === 'high') {
      _highQueue.push(item);
    } else {
      _normalQueue.push(item);
    }
    scheduleNext();
  });
}
