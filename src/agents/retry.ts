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
  const retries = opts.retries ?? 4;
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
      const hinted = (err as { retryAfterMs?: number } | undefined)?.retryAfterMs ?? 0;
      const delayMs = Math.max(baseDelayMs * 2 ** attempt, hinted);
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
