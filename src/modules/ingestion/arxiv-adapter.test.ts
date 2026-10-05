import { afterEach, describe, expect, it, vi } from "vitest";

import * as sourceHttp from "./http";
import { ARXIV_USER_AGENT, ArxivSourceAdapter } from "./arxiv-adapter";

// Queue timing and cross-instance serialization are exercised separately with fake clocks.
vi.mock("./arxiv-request-scheduler", () => ({
  scheduleArxivRequest: (request: () => Promise<unknown>) => request()
}));
vi.mock("../../lib/logging", () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));

describe("ArxivSourceAdapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("fetches scoped arXiv feed and maps entries", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
        <entry>
          <id>http://arxiv.org/abs/2603.12345v1</id>
          <updated>2026-03-07T01:00:00Z</updated>
          <published>2026-03-07T00:30:00Z</published>
          <title>  Scoped arXiv paper  </title>
          <summary>  abstract text  </summary>
          <author><name>Alice</name></author>
          <author><name>Bob</name></author>
          <arxiv:primary_category term="q-bio.GN" />
          <arxiv:doi>10.1000/test</arxiv:doi>
        </entry>
      </feed>`;

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => xml
    } as Response);
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const adapter = new ArxivSourceAdapter({
      categoryScopes: ["q-bio.GN"]
    });

    const records = await adapter.fetchCandidatesForDay({
      runDate: new Date("2026-03-07T00:00:00Z"),
      dayStart: new Date("2026-03-07T00:00:00Z"),
      dayEnd: new Date("2026-03-07T23:59:59.999Z")
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("search_query=cat:q-bio.GN"),
      expect.any(Object)
    );
    expect(fetchMock.mock.calls[0]?.[0]).toContain("start=0");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: {
        Accept: "application/atom+xml",
        "User-Agent": ARXIV_USER_AGENT
      }
    });
    expect(records).toHaveLength(1);
    expect(records[0].arxivId).toBe("2603.12345v1");
    expect(records[0].doi).toBe("10.1000/test");
    expect(records[0].authors).toEqual(["Alice", "Bob"]);
  });

  it("accepts the approved four-scope production shape", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(
      new Response(wrapFeed(""), { status: 200 })
    ));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const scopes = ["q-bio.GN", "q-bio.MN", "q-bio.PE", "q-bio.QM"];
    const adapter = new ArxivSourceAdapter({ categoryScopes: scopes });

    await adapter.fetchCandidatesForDay({
      runDate: new Date("2026-03-07T00:00:00Z"),
      dayStart: new Date("2026-03-07T00:00:00Z"),
      dayEnd: new Date("2026-03-07T23:59:59.999Z")
    });

    expect(fetchMock).toHaveBeenCalledTimes(scopes.length);
    expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).searchParams.get("search_query")))
      .toEqual(scopes.map((scope) => `cat:${scope}`));
  });

  it("supports pagination beyond the first page", async () => {
    const firstPage = wrapFeed(buildEntries(100, 1000));
    const secondPage = wrapFeed(buildEntries(1, 2000));

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () => firstPage
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        text: async () => secondPage
      } as Response);

    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const adapter = new ArxivSourceAdapter({ categoryScopes: ["q-bio.GN"] });
    const records = await adapter.fetchCandidatesForDay({
      runDate: new Date("2026-03-07T00:00:00Z"),
      dayStart: new Date("2026-03-07T00:00:00Z"),
      dayEnd: new Date("2026-03-07T23:59:59.999Z")
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toContain("start=100");
    expect(records).toHaveLength(101);
  });

  it("honors the configured pagination ceiling", async () => {
    const fetchMock = vi.fn().mockImplementation((input: string) => {
      const start = Number(new URL(input).searchParams.get("start") ?? 0);
      return Promise.resolve({
        ok: true,
        status: 200,
        text: async () => wrapFeed(buildEntries(100, 3000 + start))
      } as Response);
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const adapter = new ArxivSourceAdapter({
      categoryScopes: ["q-bio.GN"],
      maxPages: 3
    });
    const records = await adapter.fetchCandidatesForDay({
      runDate: new Date("2026-03-07T00:00:00Z"),
      dayStart: new Date("2026-03-07T00:00:00Z"),
      dayEnd: new Date("2026-03-07T23:59:59.999Z")
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2]?.[0]).toContain("start=200");
    expect(records).toHaveLength(300);
  });

  it("explicitly enables Retry-After handling for arXiv requests", async () => {
    const fetchWithRetry = vi.spyOn(sourceHttp, "fetchTextWithRetry").mockResolvedValue({
      response: new Response(null, { status: 200 }), text: wrapFeed(buildEntries(1, 4000))
    });
    const adapter = new ArxivSourceAdapter({
      categoryScopes: ["q-bio.GN"],
      timeoutMs: 1_234,
      retryBackoffMs: 456,
      retryAfterCapMs: 5_000
    });

    await adapter.fetchCandidatesForDay({
      runDate: new Date("2026-03-07T00:00:00Z"),
      dayStart: new Date("2026-03-07T00:00:00Z"),
      dayEnd: new Date("2026-03-07T23:59:59.999Z")
    });

    expect(fetchWithRetry).toHaveBeenCalledWith(
      expect.stringContaining("export.arxiv.org/api/query"),
      expect.any(Object),
      expect.objectContaining({
        timeoutMs: 1_234,
        backoffMs: 456,
        respectRetryAfter: true,
        retryAfterCapMs: 5_000,
        classifyFailures: true
      })
    );
  });

  it.each([
    [429, "rate_limit"],
    [408, "timeout"],
    [503, "server_error"],
    [400, "http_error"]
  ] as const)("classifies final HTTP %i responses as %s", async (status, failureCategory) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("failed", { status })) as unknown as typeof fetch);
    const adapter = new ArxivSourceAdapter({
      categoryScopes: ["q-bio.GN"],
      retryBackoffMs: 0
    });

    await expect(adapter.fetchCandidatesForDay({
      runDate: new Date("2026-03-07T00:00:00Z"),
      dayStart: new Date("2026-03-07T00:00:00Z"),
      dayEnd: new Date("2026-03-07T23:59:59.999Z")
    })).rejects.toMatchObject({
      code: "ARXIV_API_ERROR",
      details: {
        failureCategory,
        httpStatus: status,
        endpointHost: "export.arxiv.org"
      }
    });
  });

  it.each([
    ["network", new Error("connection refused")],
    ["timeout", Object.assign(new Error("aborted"), { name: "AbortError" })]
  ] as const)("classifies exhausted %s failures without attributing them to ranking", async (failureCategory, error) => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(error) as unknown as typeof fetch);
    const adapter = new ArxivSourceAdapter({
      categoryScopes: ["q-bio.GN"],
      retryBackoffMs: 0
    });

    await expect(adapter.fetchCandidatesForDay({
      runDate: new Date("2026-03-07T00:00:00Z"),
      dayStart: new Date("2026-03-07T00:00:00Z"),
      dayEnd: new Date("2026-03-07T23:59:59.999Z")
    })).rejects.toMatchObject({
      code: "ARXIV_API_ERROR",
      details: {
        failureCategory,
        attempts: 3,
        endpointHost: "export.arxiv.org"
      }
    });
  });

  it.each([
    ["missing", []],
    ["blank", ["", "   ", "\t"]]
  ])("fails before any arXiv fetch when category scopes are %s", async (_case, categoryScopes) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const adapter = new ArxivSourceAdapter({ categoryScopes });

    await expect(
      adapter.fetchCandidatesForDay({
        runDate: new Date(),
        dayStart: new Date(),
        dayEnd: new Date()
      })
    ).rejects.toMatchObject({
      code: "ARXIV_SCOPE_REQUIRED",
      details: { failureCategory: "configuration_error" }
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retries the failed page without discarding earlier pages when recovery succeeds", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(wrapFeed(buildEntries(100, 1000))))
      .mockRejectedValueOnce(Object.assign(new Error("fixture timeout"), { name: "AbortError" }))
      .mockResolvedValueOnce(new Response(wrapFeed(buildEntries(1, 2000))));
    vi.stubGlobal("fetch", fetchMock);
    const records = await new ArxivSourceAdapter({ categoryScopes: ["q-bio.GN"], retryBackoffMs: 0 })
      .fetchCandidatesForDay(testWindow());
    expect(records).toHaveLength(101);
    expect(fetchMock.mock.calls.map(([url]) => new URL(url).searchParams.get("start")))
      .toEqual(["0", "100", "100"]);
  });

  it("reports the exact failed page and attempts without treating incomplete data as success", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(wrapFeed(buildEntries(100, 1000))))
      .mockRejectedValue(Object.assign(new Error("private upstream message"), { name: "AbortError" })));
    await expect(new ArxivSourceAdapter({ categoryScopes: ["q-bio.GN"], retryBackoffMs: 0 })
      .fetchCandidatesForDay(testWindow())).rejects.toMatchObject({
        code: "ARXIV_API_ERROR", message: "arXiv request failed",
        details: {
          categoryIndex: 1, page: 2, start: 100, attempts: 3,
          requestPhase: "headers", failureCategory: "timeout", timeoutMs: 12000,
          elapsedMs: expect.any(Number), attemptElapsedMs: expect.any(Number)
        }
      });
  });
});

function testWindow() {
  return {
    runDate: new Date("2026-03-07T00:00:00Z"),
    dayStart: new Date("2026-03-07T00:00:00Z"),
    dayEnd: new Date("2026-03-07T23:59:59.999Z")
  };
}

function buildEntries(count: number, seed: number): string {
  const entries: string[] = [];

  for (let index = 0; index < count; index += 1) {
    const id = seed + index;
    entries.push(`
      <entry>
        <id>http://arxiv.org/abs/2603.${id}v1</id>
        <updated>2026-03-07T01:00:00Z</updated>
        <published>2026-03-07T00:30:00Z</published>
        <title>Paper ${id}</title>
        <summary>Summary ${id}</summary>
        <author><name>Author ${id}</name></author>
        <arxiv:primary_category term="q-bio.GN" />
      </entry>
    `);
  }

  return entries.join("\n");
}

function wrapFeed(entries: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
    <feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
      ${entries}
    </feed>`;
}
