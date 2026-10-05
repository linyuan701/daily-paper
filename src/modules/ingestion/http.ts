export type FetchWithRetryOptions = {
  timeoutMs?: number;
  maxRetries?: number;
  retryableStatusCodes?: number[];
  backoffMs?: number;
  respectRetryAfter?: boolean;
  retryAfterCapMs?: number;
  classifyFailures?: boolean;
  wait?: (milliseconds: number) => Promise<void>;
  scheduleAttempt?: <T>(request: () => Promise<T>) => Promise<T>;
  onAttempt?: (diagnostic: SourceHttpAttemptDiagnostic) => void;
};

export type SourceHttpFailureKind = "timeout" | "network";

export type SourceHttpAttemptDiagnostic = {
  attempt: number;
  elapsedMs: number;
  requestPhase: "headers" | "body";
  outcome: "http" | SourceHttpFailureKind;
  httpStatus?: number;
  transportCode?: string;
};

export class SourceHttpError extends Error {
  constructor(
    readonly kind: SourceHttpFailureKind,
    message: string,
    readonly attempts: number,
    cause?: unknown,
    readonly diagnostic?: SourceHttpAttemptDiagnostic
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
  return (await fetchResultWithRetry(input, init, options, false)).response;
}

/** Read the body inside the attempt deadline and connection slot, unlike a raw Response. */
export async function fetchTextWithRetry(
  input: string,
  init?: RequestInit,
  options?: FetchWithRetryOptions
): Promise<{ response: Response; text: string }> {
  return fetchResultWithRetry(input, init, options, true);
}

async function fetchResultWithRetry(
  input: string,
  init: RequestInit | undefined,
  options: FetchWithRetryOptions | undefined,
  readText: boolean
): Promise<{ response: Response; text: string }> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryableStatusCodes = options?.retryableStatusCodes ?? DEFAULT_RETRYABLE_STATUS_CODES;
  const backoffMs = options?.backoffMs ?? DEFAULT_BACKOFF_MS;
  const respectRetryAfter = options?.respectRetryAfter ?? false;
  const retryAfterCapMs = options?.retryAfterCapMs ?? DEFAULT_RETRY_AFTER_CAP_MS;
  const classifyFailures = options?.classifyFailures ?? false;
  const waitFor = options?.wait ?? wait;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    let result: { response: Response; text: string };
    let diagnostic: SourceHttpAttemptDiagnostic | undefined;
    const request = async () => {
      const controller = new AbortController();
      const startedAt = Date.now();
      let requestPhase: "headers" | "body" = "headers";
      let response: Response | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const deadline = new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(new DOMException("Source request timed out", "AbortError"));
          }, timeoutMs);
        });
        const operation = async () => {
          response = await fetch(input, { ...init, signal: controller.signal });
          if (controller.signal.aborted) {
            // A custom transport can deliver a response after the deadline won.
            // Do not start a late body read or leave that response open.
            await response.body?.cancel();
            throw new DOMException("Source request timed out", "AbortError");
          }
          let text = "";
          if (readText && response.ok) {
            requestPhase = "body";
            text = await response.text();
          } else if (!response.ok && (readText || (retryableStatusCodes.includes(response.status) && attempt < maxRetries))) {
            // Release unsuccessful responses before retrying or yielding the connection slot.
            await response.body?.cancel();
          }
          return { response, text };
        };
        const value = await Promise.race([operation(), deadline]);
        diagnostic = {
          attempt: attempt + 1, elapsedMs: Date.now() - startedAt,
          requestPhase, outcome: "http", httpStatus: value.response.status
        };
        return value;
      } catch (error) {
        diagnostic = {
          attempt: attempt + 1, elapsedMs: Date.now() - startedAt, requestPhase,
          outcome: controller.signal.aborted || isTimeoutError(error) ? "timeout" : "network",
          ...(response ? { httpStatus: response.status } : {}),
          ...transportDiagnostic(error)
        };
        throw error;
      } finally {
        clearTimeout(timeout);
        if (diagnostic) options?.onAttempt?.(diagnostic);
      }
    };
    try {
      result = options?.scheduleAttempt ? await options.scheduleAttempt(request) : await request();
    } catch (error) {
      lastError = error;

      if (attempt >= maxRetries) {
        throw classifyFailures ? toSourceHttpError(error, attempt + 1, diagnostic) : normalizeFetchError(error);
      }

      await waitFor(backoffMs * (attempt + 1));
      continue;
    }

    const { response } = result;
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

    return result;
  }

  throw classifyFailures
    ? toSourceHttpError(lastError, maxRetries + 1)
    : normalizeFetchError(lastError);
}

export function parseRetryAfterMs(value: string | null | undefined, nowMs = Date.now()): number | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (/^\d+$/.test(normalized)) return Number(normalized) * 1000;
  const retryAt = Date.parse(normalized);
  if (!Number.isFinite(retryAt)) return undefined;
  return Math.max(0, retryAt - nowMs);
}

function toSourceHttpError(error: unknown, attempts: number, diagnostic?: SourceHttpAttemptDiagnostic): SourceHttpError {
  if (error instanceof SourceHttpError) return error;
  const timeout = diagnostic?.outcome === "timeout" || isTimeoutError(error);
  return new SourceHttpError(
    timeout ? "timeout" : "network",
    timeout
      ? `Source request timed out after ${attempts} attempt${attempts === 1 ? "" : "s"}`
      : error instanceof Error
        ? error.message
        : "Unknown source network failure",
    attempts,
    error,
    diagnostic
  );
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

const TRANSPORT_CODES = new Set([
  "ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT",
  "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET", "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
]);

export function safeTransportCode(value: unknown): string | undefined {
  return typeof value === "string" && TRANSPORT_CODES.has(value) ? value : undefined;
}

function transportDiagnostic(error: unknown): { transportCode?: string } {
  if (!(error instanceof Error)) return {};
  const cause = error.cause;
  const code = safeTransportCode((error as Error & { code?: unknown }).code) ??
    safeTransportCode(cause && typeof cause === "object" && "code" in cause ? cause.code : undefined);
  return code ? { transportCode: code } : {};
}

function normalizeFetchError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Unknown source fetch failure");
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
