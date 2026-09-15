/**
 * Retry wrapper for Zalo API (zca-js) calls.
 *
 * zca-js uses Node's native fetch internally. On flaky networks the fetch
 * throws one of:
 *   TypeError: fetch failed                    ← wraps one of the below
 *   AggregateError [ETIMEDOUT]
 *   Error [ECONNRESET]
 *   Error [ENOTFOUND]
 *   Error [ECONNREFUSED]
 *   Error [ECONNABORTED]
 *
 * These are ALL transient — the message itself is fine, the network just
 * had a brief hiccup. Retrying with exponential backoff fixes the problem.
 *
 * Permanent Zalo API errors (code 114, -216, etc.) are intentionally NOT
 * retried — they indicate a semantic failure that a retry won't fix.
 */

const TRANSIENT_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ENOTFOUND',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

const MAX_RETRIES = 4;
// Delays in ms: 1 s, 2 s, 4 s, 8 s
const BACKOFF_MS  = [1_000, 2_000, 4_000, 8_000] as const;

/** Returns true if the error (or any of its nested causes) is a transient network error. */
function isTransient(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false;
  const e = err as Record<string, unknown>;

  // Direct error code (e.g. Error [ETIMEDOUT])
  if (typeof e.code === 'string' && TRANSIENT_CODES.has(e.code)) return true;

  // Message check for common transient network failure phrasings.
  // "socket hang up" / "terminated" come from node-fetch/undici (Telegram),
  // "fetch failed" from native fetch (zca-js), "eai_again" is flaky DNS.
  if (typeof e.message === 'string') {
    const msg = e.message.toLowerCase();
    if (msg.includes('fetch failed')   || msg.includes('etimedout') ||
        msg.includes('econnreset')     || msg.includes('enotfound') ||
        msg.includes('network')        || msg.includes('timeout')   ||
        msg.includes('socket hang up') || msg.includes('terminated') ||
        msg.includes('eai_again')) {
      return true;
    }
  }

  // Unwrap AggregateError (cause is an iterable of Errors)
  if (e.cause instanceof AggregateError) {
    for (const sub of (e.cause as AggregateError).errors ?? []) {
      if (isTransient(sub)) return true;
    }
  }

  // Unwrap single cause (e.g. TypeError wrapping an ETIMEDOUT)
  if (e.cause != null && isTransient(e.cause)) return true;

  // AggregateError .errors array (when the error itself is the AggregateError)
  if (Array.isArray(e.errors)) {
    for (const sub of e.errors as unknown[]) {
      if (isTransient(sub)) return true;
    }
  }

  return false;
}

/** Exported so callers can check if a caught error is a transient network error. */
export { isTransient as isTransientNetworkError };

/**
 * Run `fn` and retry up to MAX_RETRIES times if a transient network error
 * is thrown. Non-transient errors (Zalo API codes, auth failures, etc.)
 * are re-thrown immediately without retrying.
 */
export async function withZaloRetry<T>(
  fn:    () => Promise<T>,
  label: string,
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransient(err) || attempt >= MAX_RETRIES) throw err;

      const delay = BACKOFF_MS[attempt] ?? BACKOFF_MS[BACKOFF_MS.length - 1]!;
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[ZaloRetry] ${label}: transient error (attempt ${attempt + 1}/${MAX_RETRIES}), ` +
        `retrying in ${delay / 1000}s — ${errMsg}`,
      );
      await new Promise(r => setTimeout(r, delay));
      attempt++;
    }
  }
}

/**
 * Proxy that routes every method call on a Zalo API object through
 * `withZaloRetry`. Drop-in replacement for the raw `api` reference:
 *
 *   const api = zaloApiWithRetry(currentApi);
 *
 * All api.sendMessage / api.uploadAttachment / api.sendVoice / … calls
 * are then automatically retried on transient network errors.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function zaloApiWithRetry(api: any): any {
  return new Proxy(api as Record<string, unknown>, {
    get(target, prop: string) {
      const orig = target[prop];
      if (typeof orig !== 'function') return orig;
      return (...args: unknown[]) =>
        withZaloRetry(
          () => (orig as (...a: unknown[]) => Promise<unknown>).apply(target, args),
          String(prop),
        );
    },
  });
}
