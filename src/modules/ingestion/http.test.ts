import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchTextWithRetry, fetchWithRetry, parseRetryAfterMs, SourceHttpError } from "./http";

describe("fetchWithRetry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("retries retryable statuses and returns the successful response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200
      } as Response);

    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const response = await fetchWithRetry("https://example.org", undefined, {
      maxRetries: 2,
      backoffMs: 0
    });

    expect(response.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("preserves the original network error by default after exhausted retries", async () => {
    const networkError = new Error("network down");
    const fetchMock = vi.fn().mockRejectedValue(networkError);
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await expect(
      fetchWithRetry("https://example.org", undefined, {
        maxRetries: 1,
        backoffMs: 0
      })
    ).rejects.toBe(networkError);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("classifies exhausted network errors only when explicitly enabled", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await expect(fetchWithRetry("https://example.org", undefined, {
      maxRetries: 1,
      backoffMs: 0,
      classifyFailures: true
    })).rejects.toMatchObject({
      name: "SourceHttpError",
      kind: "network",
      attempts: 2,
      message: "network down"
    } satisfies Partial<SourceHttpError>);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("honors and caps Retry-After for retryable responses", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("busy", {
        status: 429,
        headers: { "Retry-After": "30" }
      }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const waits: number[] = [];
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const response = await fetchWithRetry("https://example.org", undefined, {
      maxRetries: 1,
      respectRetryAfter: true,
      retryAfterCapMs: 5_000,
      wait: async (milliseconds) => {
        waits.push(milliseconds);
      }
    });

    expect(response.ok).toBe(true);
    expect(waits).toEqual([5_000]);
  });

  it("keeps the default backoff when Retry-After support is not enabled", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("busy", {
        status: 429,
        headers: { "Retry-After": "30" }
      }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const waits: number[] = [];
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const response = await fetchWithRetry("https://example.org", undefined, {
      maxRetries: 1,
      backoffMs: 125,
      retryAfterCapMs: 5_000,
      wait: async (milliseconds) => {
        waits.push(milliseconds);
      }
    });

    expect(response.ok).toBe(true);
    expect(waits).toEqual([125]);
  });

  it("classifies exhausted AbortError failures as timeouts", async () => {
    const timeout = new Error("aborted");
    timeout.name = "AbortError";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(timeout) as unknown as typeof fetch);

    await expect(fetchWithRetry("https://example.org", undefined, {
      maxRetries: 0,
      classifyFailures: true
    })).rejects.toMatchObject({
      kind: "timeout",
      attempts: 1
    });
  });

  it("parses Retry-After seconds and HTTP dates", () => {
    expect(parseRetryAfterMs("3", 0)).toBe(3_000);
    expect(parseRetryAfterMs("Thu, 01 Jan 1970 00:00:05 GMT", 1_000)).toBe(4_000);
    expect(parseRetryAfterMs("invalid", 0)).toBeUndefined();
  });
});

describe("bounded text requests", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("times out stalled headers, logs all attempts, and excludes retry sleep from attempt duration", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const onAttempt = vi.fn();
    const result = fetchTextWithRetry("https://example.invalid", undefined, {
      timeoutMs: 100, backoffMs: 50, classifyFailures: true, onAttempt
    });
    const check = expect(result).rejects.toMatchObject({
      kind: "timeout", attempts: 3,
      diagnostic: { attempt: 3, elapsedMs: 100, requestPhase: "headers", outcome: "timeout" }
    });
    await vi.runAllTimersAsync();
    await check;
    expect(onAttempt.mock.calls.map(([value]) => value.elapsedMs)).toEqual([100, 100, 100]);
    expect(Date.now()).toBe(450);
  });

  it("bounds and retries body reads after successful headers", async () => {
    const signals: AbortSignal[] = [];
    vi.stubGlobal("fetch", vi.fn((_url, init) => {
      signals.push(init.signal);
      return Promise.resolve({ ok: true, status: 200, text: () => new Promise(() => {}) } as Response);
    }));
    const onAttempt = vi.fn();
    const result = fetchTextWithRetry("https://example.invalid", undefined, {
      timeoutMs: 100, backoffMs: 0, maxRetries: 1, classifyFailures: true, onAttempt
    });
    const check = expect(result).rejects.toMatchObject({
      kind: "timeout", attempts: 2,
      diagnostic: { requestPhase: "body", httpStatus: 200, outcome: "timeout" }
    });
    await vi.runAllTimersAsync();
    await check;
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(onAttempt).toHaveBeenCalledTimes(2);
  });

  it("cancels error bodies before retrying and keeps HTTP 408 distinguishable from local timeouts", async () => {
    const cancelled = vi.fn();
    const busy = new Response(new ReadableStream({ cancel: cancelled }), { status: 408 });
    const fetchMock = vi.fn().mockResolvedValueOnce(busy).mockResolvedValueOnce(new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const onAttempt = vi.fn();
    const result = fetchTextWithRetry("https://example.invalid", undefined, { backoffMs: 0, onAttempt });
    await vi.runAllTimersAsync();
    expect((await result).text).toBe("ok");
    expect(cancelled).toHaveBeenCalledOnce();
    expect(onAttempt.mock.calls[0][0]).toMatchObject({ outcome: "http", httpStatus: 408 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains only an allow-listed transport code and excludes upstream messages", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(
      new Error("secret upstream content", { cause: { code: "ENOTFOUND", address: "private" } })
    ));
    const onAttempt = vi.fn();
    const result = fetchTextWithRetry("https://example.invalid", undefined, {
      maxRetries: 0, classifyFailures: true, onAttempt
    });
    await expect(result).rejects.toMatchObject({ kind: "network" });
    expect(onAttempt.mock.calls[0][0]).toMatchObject({ transportCode: "ENOTFOUND", outcome: "network" });
    expect(JSON.stringify(onAttempt.mock.calls)).not.toMatch(/secret|private|example/);
  });
});
