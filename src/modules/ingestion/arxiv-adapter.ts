import { AppError } from "../../lib/errors";
import { fetchWithRetry, SourceHttpError } from "./http";
import type { DailySourceAdapter, DailySourceAdapterCandidate, UtcDayWindow } from "./types";

const ARXIV_API_BASE = "https://export.arxiv.org/api/query";
const ARXIV_PAGE_SIZE = 100;
const DEFAULT_ARXIV_MAX_PAGES = 5;
const DEFAULT_REQUEST_TIMEOUT_MS = 12_000;
const DEFAULT_RETRY_BACKOFF_MS = 250;
const DEFAULT_RETRY_AFTER_CAP_MS = 120_000;
export const ARXIV_USER_AGENT = "DailyPaper/0.3 (scholarly-literature-triage)";

type ArxivEntry = {
  id: string;
  title?: string;
  summary?: string;
  publishedAt?: Date;
  updatedAt?: Date;
  doi?: string;
  category?: string;
  authors: string[];
  rawEntry: string;
};

export class ArxivSourceAdapter implements DailySourceAdapter {
  readonly source = "arxiv" as const;

  private readonly categoryScopes: string[];
  private readonly maxPages: number;
  private readonly timeoutMs: number;
  private readonly retryBackoffMs: number;
  private readonly retryAfterCapMs: number;

  constructor(input: {
    categoryScopes: string[];
    maxPages?: number;
    timeoutMs?: number;
    retryBackoffMs?: number;
    retryAfterCapMs?: number;
  }) {
    this.categoryScopes = input.categoryScopes.map((scope) => scope.trim()).filter(Boolean);
    this.maxPages = positiveInteger(input.maxPages, DEFAULT_ARXIV_MAX_PAGES);
    this.timeoutMs = positiveInteger(input.timeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    this.retryBackoffMs = nonNegativeInteger(input.retryBackoffMs, DEFAULT_RETRY_BACKOFF_MS);
    this.retryAfterCapMs = nonNegativeInteger(input.retryAfterCapMs, DEFAULT_RETRY_AFTER_CAP_MS);
  }

  async fetchCandidatesForDay(_window: UtcDayWindow): Promise<DailySourceAdapterCandidate[]> {
    if (this.categoryScopes.length === 0) {
      throw new AppError(
        "ARXIV_SCOPE_REQUIRED",
        "arXiv ingestion requires at least one configured category scope",
        400
      );
    }

    const byExternalId = new Map<string, DailySourceAdapterCandidate>();

    for (const scope of this.categoryScopes) {
      for (let page = 0; page < this.maxPages; page += 1) {
        const start = page * ARXIV_PAGE_SIZE;
        const feed = await this.fetchFeedForCategory(scope, start, ARXIV_PAGE_SIZE);
        const entries = parseArxivFeed(feed);

        if (entries.length === 0) {
          break;
        }

        for (const entry of entries) {
          const candidate = mapArxivEntry(entry, scope);
          if (!byExternalId.has(candidate.externalId)) {
            byExternalId.set(candidate.externalId, candidate);
          }
        }

        if (entries.length < ARXIV_PAGE_SIZE) {
          break;
        }
      }
    }

    return Array.from(byExternalId.values());
  }

  private async fetchFeedForCategory(category: string, start: number, maxResults: number): Promise<string> {
    const url =
      `${ARXIV_API_BASE}?search_query=cat:${encodeURIComponent(category)}` +
      `&sortBy=submittedDate&sortOrder=descending&start=${start}&max_results=${maxResults}`;

    let response: Response;
    try {
      response = await fetchWithRetry(
        url,
        {
          headers: {
            Accept: "application/atom+xml",
            "User-Agent": ARXIV_USER_AGENT
          }
        },
        {
          timeoutMs: this.timeoutMs,
          backoffMs: this.retryBackoffMs,
          respectRetryAfter: true,
          retryAfterCapMs: this.retryAfterCapMs
        }
      );
    } catch (error) {
      throw new AppError(
        "ARXIV_API_ERROR",
        error instanceof Error ? error.message : "arXiv request failed",
        502,
        {
          failureCategory: error instanceof SourceHttpError ? error.kind : "unknown",
          attempts: error instanceof SourceHttpError ? error.attempts : undefined,
          endpointHost: "export.arxiv.org"
        }
      );
    }

    if (!response.ok) {
      throw new AppError(
        "ARXIV_API_ERROR",
        `arXiv API request failed with status ${response.status}`,
        502,
        {
          failureCategory: response.status === 429
            ? "rate_limited"
            : response.status >= 500
              ? "server_error"
              : "http_error",
          httpStatus: response.status,
          endpointHost: "export.arxiv.org"
        }
      );
    }

    return response.text();
  }
}

function parseArxivFeed(xml: string): ArxivEntry[] {
  const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? [];

  return entries.map((entry) => {
    const id = extractTag(entry, "id") ?? "";
    const title = normalizeWhitespace(extractTag(entry, "title"));
    const summary = normalizeWhitespace(extractTag(entry, "summary"));
    const publishedAt = toDate(extractTag(entry, "published"));
    const updatedAt = toDate(extractTag(entry, "updated"));
    const doi = extractTag(entry, "arxiv:doi");
    const category = extractAttribute(entry, "arxiv:primary_category", "term");
    const authors = extractAllTags(entry, "name")
      .map((author) => normalizeWhitespace(author) ?? "")
      .filter(Boolean);

    return {
      id,
      title,
      summary,
      publishedAt,
      updatedAt,
      doi: sanitizeString(doi),
      category: sanitizeString(category),
      authors,
      rawEntry: entry
    };
  });
}

function mapArxivEntry(entry: ArxivEntry, requestedCategory: string): DailySourceAdapterCandidate {
  const arxivId = parseArxivId(entry.id);

  return {
    externalId: arxivId,
    title: entry.title,
    abstractNote: entry.summary,
    publishedAt: entry.publishedAt,
    indexedAt: entry.updatedAt,
    url: entry.id,
    doi: entry.doi,
    arxivId,
    journalName: undefined,
    authors: entry.authors,
    sourcePayload: {
      requestedCategory,
      category: entry.category,
      rawEntry: entry.rawEntry
    }
  };
}

function extractTag(xml: string, tag: string): string | undefined {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const match = xml.match(regex);
  return match?.[1];
}

function extractAllTags(xml: string, tag: string): string[] {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
  const values: string[] = [];

  for (const match of xml.matchAll(regex)) {
    if (match[1]) {
      values.push(match[1]);
    }
  }

  return values;
}

function extractAttribute(xml: string, tag: string, attribute: string): string | undefined {
  const regex = new RegExp(`<${tag}[^>]*${attribute}="([^"]+)"[^>]*/?>`, "i");
  const match = xml.match(regex);
  return match?.[1];
}

function parseArxivId(idUrl: string): string {
  const trimmed = idUrl.trim();
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
}

function toDate(value: string | undefined): Date | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function normalizeWhitespace(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  return value.replace(/\s+/g, " ").trim() || undefined;
}

function sanitizeString(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value >= 0 ? value : fallback;
}
