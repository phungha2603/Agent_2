const TRANSIENT_NETWORK_CODES = new Set(["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ENOTFOUND"]);

/**
 * True for errors worth retrying: transient server overload/rate limiting,
 * or a lower-level network blip (connection timeout, DNS hiccup, reset)
 * from fetch itself rather than a response from the server at all —
 * Node's fetch wraps those as TypeError("fetch failed") with a `cause`.
 */
export function isTransientApiError(err: unknown): boolean {
  const status = (err as { status?: number } | undefined)?.status;
  if (status === 429 || status === 503 || status === 529) return true;

  if (err instanceof TypeError && /fetch failed/i.test(err.message)) return true;

  const cause = (err as { cause?: unknown } | undefined)?.cause as
    | { code?: string; errors?: { code?: string }[] }
    | undefined;
  if (cause?.code && TRANSIENT_NETWORK_CODES.has(cause.code)) return true;
  if (cause?.errors?.some((e) => e.code && TRANSIENT_NETWORK_CODES.has(e.code))) return true;

  return false;
}

/** Retries `fn` with exponential backoff while `shouldRetry` says so. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { retries?: number; shouldRetry?: (err: unknown) => boolean; baseDelayMs?: number } = {},
): Promise<T> {
  const retries = opts.retries ?? 8;
  const shouldRetry = opts.shouldRetry ?? isTransientApiError;
  const baseDelayMs = opts.baseDelayMs ?? 2000;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === retries || !shouldRetry(err)) throw err;
      // A rate-limit response often names exactly how long to wait
      // (e.g. Gemini's RetryInfo.retryDelay) — that's authoritative and
      // can be longer than our own backoff schedule, so honor it instead
      // of retrying too early into the same still-closed window.
      // +3s buffer: a rate-limit window reported as clear at exactly T
      // can still reject a request that lands right at T, since the
      // server's clock and ours aren't perfectly in sync.
      const hinted = (err as { retryAfterMs?: number } | undefined)?.retryAfterMs;
      const delayMs = hinted ? hinted + 3000 : baseDelayMs * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastErr;
}

/** An error carrying an HTTP status, so isTransientApiError can see it. */
export class HttpStatusError extends Error {
  status: number;
  /** Milliseconds the server explicitly asked callers to wait before retrying, if it said so. */
  retryAfterMs?: number;
  constructor(status: number, message: string, retryAfterMs?: number) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Rotates through a pool of API keys, remembering which one is "current" across calls. */
export interface KeyPool {
  readonly size: number;
  current(): string;
  /** Advances to the next key (wraps around) — call this after a 429 on the current one. */
  rotate(): void;
}

export function createKeyPool(keys: string[]): KeyPool {
  if (keys.length === 0) throw new Error("createKeyPool requires at least one key");
  let i = 0;
  return {
    get size() {
      return keys.length;
    },
    current() {
      return keys[i];
    },
    rotate() {
      i = (i + 1) % keys.length;
    },
  };
}

/**
 * Runs `fn` with the pool's current key. On a 429 it rotates to the next key
 * and retries immediately (no backoff — a sibling key's quota is unrelated),
 * up to once per key in the pool. If every key is rate-limited, rethrows the
 * last error so the caller's own retry/backoff (e.g. withRetry) takes over.
 */
export async function withKeyRotation<T>(pool: KeyPool, fn: (apiKey: string) => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < pool.size; i++) {
    const apiKey = pool.current();
    try {
      return await fn(apiKey);
    } catch (err) {
      lastErr = err;
      if ((err as { status?: number } | undefined)?.status === 429 && pool.size > 1) {
        pool.rotate();
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}
