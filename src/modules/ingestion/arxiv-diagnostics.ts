import { AppError } from "../../lib/errors";
import { safeTransportCode } from "./http";
import type { ArxivFailureDiagnostic } from "./types";

const REQUEST_FAILURE_CATEGORIES = new Set<ArxivFailureDiagnostic["failureCategory"]>([
  "rate_limit",
  "timeout",
  "network",
  "server_error",
  "http_error"
]);

export function classifyArxivFailure(error: unknown): ArxivFailureDiagnostic {
  if (error instanceof AppError && error.code === "ARXIV_SCOPE_REQUIRED") {
    return {
      source: "arxiv",
      failureCode: "ARXIV_SCOPE_REQUIRED",
      stage: "configuration",
      failureCategory: "configuration_error",
      retryable: false
    };
  }

  if (error instanceof AppError && error.code === "ARXIV_API_ERROR") {
    const configuredCategory = error.details?.failureCategory;
    const failureCategory =
      typeof configuredCategory === "string" &&
      REQUEST_FAILURE_CATEGORIES.has(configuredCategory as ArxivFailureDiagnostic["failureCategory"])
        ? configuredCategory as ArxivFailureDiagnostic["failureCategory"]
        : "unknown";

    return {
      source: "arxiv",
      failureCode: "ARXIV_API_ERROR",
      stage: "request",
      failureCategory,
      retryable:
        failureCategory === "rate_limit" ||
        failureCategory === "timeout" ||
        failureCategory === "network" ||
        failureCategory === "server_error",
      ...safeRequestDetails(error.details)
    };
  }

  return {
    source: "arxiv",
    failureCode: "ARXIV_UNEXPECTED_ERROR",
    stage: "ingestion",
    failureCategory: "unknown",
    retryable: false
  };
}

function safeRequestDetails(details: Record<string, unknown> | undefined): Partial<ArxivFailureDiagnostic> {
  if (!details) return {};
  const result: Partial<ArxivFailureDiagnostic> = {};
  // Never spread upstream errors, configured scopes, URLs, headers, or bodies.
  if (details.endpointHost === "export.arxiv.org") result.endpointHost = "export.arxiv.org";
  const bounds = {
    categoryIndex: [1, 10_000], page: [1, 10_000], start: [0, 1_000_000], attempts: [1, 100],
    elapsedMs: [0, 86_400_000], attemptElapsedMs: [0, 86_400_000], timeoutMs: [1, 86_400_000],
    httpStatus: [100, 599]
  } as const;
  for (const key of Object.keys(bounds) as Array<keyof typeof bounds>) {
    const value = details[key];
    const [minimum, maximum] = bounds[key];
    if (typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum) {
      result[key] = value;
    }
  }
  if (details.requestPhase === "headers" || details.requestPhase === "body") {
    result.requestPhase = details.requestPhase;
  }
  const transportCode = safeTransportCode(details.transportCode);
  if (transportCode) result.transportCode = transportCode;
  return result;
}

export function arxivFailureMessage(diagnostic: ArxivFailureDiagnostic): string {
  if (diagnostic.failureCode === "ARXIV_SCOPE_REQUIRED") {
    return "arXiv category scope configuration is missing";
  }
  if (diagnostic.failureCode === "ARXIV_API_ERROR") {
    return "arXiv request failed";
  }
  return "arXiv ingestion failed";
}
