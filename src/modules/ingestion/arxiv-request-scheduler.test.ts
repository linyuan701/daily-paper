import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("arXiv connection scheduling", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); vi.resetModules(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("spaces concurrent callers after the previous body completes and recovers after rejection", async () => {
    const { scheduleArxivRequest } = await import("./arxiv-request-scheduler");
    const starts: number[] = [];
    const first = scheduleArxivRequest(async () => {
      starts.push(Date.now());
      await new Promise((resolve) => setTimeout(resolve, 5000));
      throw new Error("fixture failure");
    });
    const rejected = expect(first).rejects.toThrow("fixture failure");
    const second = scheduleArxivRequest(async () => { starts.push(Date.now()); return "ok"; });
    await vi.advanceTimersByTimeAsync(7999);
    expect(starts).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(await second).toBe("ok");
    expect(starts).toEqual([0, 8000]);
  });

  it("applies the same queue across adapter instances and Retry-After: 0 retries", async () => {
    const { ArxivSourceAdapter } = await import("./arxiv-adapter");
    const starts: number[] = [];
    const fetchMock = vi.fn().mockImplementation(async () => {
      starts.push(Date.now());
      return starts.length === 1
        ? new Response("busy", { status: 429, headers: { "Retry-After": "0" } })
        : new Response("<feed></feed>");
    });
    vi.stubGlobal("fetch", fetchMock);
    const window = { runDate: new Date(0), dayStart: new Date(0), dayEnd: new Date(0) };
    const first = new ArxivSourceAdapter({ categoryScopes: ["q-bio.GN"], retryBackoffMs: 0 })
      .fetchCandidatesForDay(window);
    const second = new ArxivSourceAdapter({ categoryScopes: ["q-bio.MN"] }).fetchCandidatesForDay(window);
    await vi.runAllTimersAsync();
    expect(await first).toEqual([]);
    expect(await second).toEqual([]);
    expect(starts).toEqual([0, 3000, 6000]);
  });
});
