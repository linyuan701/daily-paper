import { afterEach, describe, expect, it, vi } from "vitest";

import { AppError } from "../../lib/errors";
import * as sourceHttp from "./http";
import { ARXIV_USER_AGENT, ArxivSourceAdapter } from "./arxiv-adapter";

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

  it("uses the configured maximum page count", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => wrapFeed(buildEntries(100, 3000))
    } as Response);
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const adapter = new ArxivSourceAdapter({
      categoryScopes: ["q-bio.GN"],
      maxPages: 1
    });
    const records = await adapter.fetchCandidatesForDay({
      runDate: new Date("2026-03-07T00:00:00Z"),
      dayStart: new Date("2026-03-07T00:00:00Z"),
      dayEnd: new Date("2026-03-07T23:59:59.999Z")
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(records).toHaveLength(100);
  });

  it("explicitly enables Retry-After handling for arXiv requests", async () => {
    const fetchWithRetry = vi.spyOn(sourceHttp, "fetchWithRetry").mockResolvedValue(
      new Response(wrapFeed(buildEntries(1, 4000)), { status: 200 })
    );
    const adapter = new ArxivSourceAdapter({
      categoryScopes: ["q-bio.GN"],
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
        respectRetryAfter: true,
        retryAfterCapMs: 5_000
      })
    );
  });

  it("classifies exhausted network failures without attributing them to ranking", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection refused")) as unknown as typeof fetch);
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
        failureCategory: "network",
        attempts: 3,
        endpointHost: "export.arxiv.org"
      }
    });
  });

  it("fails when category scopes are missing", async () => {
    const adapter = new ArxivSourceAdapter({ categoryScopes: [] });

    await expect(
      adapter.fetchCandidatesForDay({
        runDate: new Date(),
        dayStart: new Date(),
        dayEnd: new Date()
      })
    ).rejects.toBeInstanceOf(AppError);
  });
});

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
