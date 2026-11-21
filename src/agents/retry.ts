/** True for errors worth retrying: transient server overload / rate limiting. */
export function isTransientApiError(err: unknown): boolean {
  const status = (err as { status?: number } | undefined)?.status;
  return status === 429 || status === 503 || status === 529;
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
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** attempt));
    }
  }
  throw lastErr;
}

/** An error carrying an HTTP status, so isTransientApiError can see it. */
export class HttpStatusError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
