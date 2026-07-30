export type FetchWithRetryOptions = {
  timeoutMs?: number;
  maxRetries?: number;
  retryableStatusCodes?: number[];
  backoffMs?: number;
  respectRetryAfter?: boolean;
  retryAfterCapMs?: number;
  wait?: (milliseconds: number) => Promise<void>;
};

export type SourceHttpFailureKind = "timeout" | "network";

export class SourceHttpError extends Error {
  constructor(
    readonly kind: SourceHttpFailureKind,
    message: string,
    readonly attempts: number,
    cause?: unknown
  ) {
    super(message, { cause });
    this.name = "SourceHttpError";
  }
}

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRYABLE_STATUS_CODES = [408, 429, 500, 502, 503, 504];
const DEFAULT_BACKOFF_MS = 250;
const DEFAULT_RETRY_AFTER_CAP_MS = 120_000;

export async function fetchWithRetry(
  input: string,
  init?: RequestInit,
  options?: FetchWithRetryOptions
): Promise<Response> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryableStatusCodes = options?.retryableStatusCodes ?? DEFAULT_RETRYABLE_STATUS_CODES;
  const backoffMs = options?.backoffMs ?? DEFAULT_BACKOFF_MS;
  const respectRetryAfter = options?.respectRetryAfter ?? false;
  const retryAfterCapMs = options?.retryAfterCapMs ?? DEFAULT_RETRY_AFTER_CAP_MS;
  const waitFor = options?.wait ?? wait;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(input, {
        ...init,
        signal: controller.signal
      });
    } catch (error) {
      lastError = error;

      if (attempt >= maxRetries) {
        throw toSourceHttpError(error, attempt + 1);
      }

      await waitFor(backoffMs * (attempt + 1));
      continue;
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok && retryableStatusCodes.includes(response.status) && attempt < maxRetries) {
      const retryAfterMs = respectRetryAfter
        ? parseRetryAfterMs(response.headers?.get("Retry-After"))
        : undefined;
      const delay = retryAfterMs === undefined
        ? backoffMs * (attempt + 1)
        : Math.min(retryAfterMs, Math.max(0, retryAfterCapMs));
      await waitFor(delay);
      continue;
    }

    return response;
  }

  throw toSourceHttpError(lastError, maxRetries + 1);
}

export function parseRetryAfterMs(value: string | null | undefined, nowMs = Date.now()): number | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (/^\d+$/.test(normalized)) return Number(normalized) * 1000;
  const retryAt = Date.parse(normalized);
  if (!Number.isFinite(retryAt)) return undefined;
  return Math.max(0, retryAt - nowMs);
}

function toSourceHttpError(error: unknown, attempts: number): SourceHttpError {
  if (error instanceof SourceHttpError) return error;
  const timeout = error instanceof Error && error.name === "AbortError";
  return new SourceHttpError(
    timeout ? "timeout" : "network",
    timeout
      ? `Source request timed out after ${attempts} attempt${attempts === 1 ? "" : "s"}`
      : error instanceof Error
        ? error.message
        : "Unknown source network failure",
    attempts,
    error
  );
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
