import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchWithRetry, parseRetryAfterMs, SourceHttpError } from "./http";

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

  it("throws after exhausted retries for network errors", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await expect(
      fetchWithRetry("https://example.org", undefined, {
        maxRetries: 1,
        backoffMs: 0
      })
    ).rejects.toMatchObject({
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
      maxRetries: 0
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
