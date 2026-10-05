import { describe, expect, it } from "vitest";

import { AppError } from "../../lib/errors";
import { classifyArxivFailure } from "./arxiv-diagnostics";

describe("classifyArxivFailure", () => {
  it("classifies missing scopes as a non-retryable configuration failure", () => {
    expect(classifyArxivFailure(new AppError(
      "ARXIV_SCOPE_REQUIRED",
      "raw configuration error",
      400,
      { failureCategory: "configuration_error", privateValue: "do-not-expose" }
    ))).toEqual({
      source: "arxiv",
      failureCode: "ARXIV_SCOPE_REQUIRED",
      stage: "configuration",
      failureCategory: "configuration_error",
      retryable: false
    });
  });

  it("returns only allow-listed request diagnostics", () => {
    const diagnostic = classifyArxivFailure(new AppError(
      "ARXIV_API_ERROR",
      "token=do-not-expose",
      502,
      {
        failureCategory: "timeout",
        responseBody: "do-not-expose",
        endpointUrl: "https://example.invalid/?token=do-not-expose"
      }
    ));

    expect(diagnostic).toEqual({
      source: "arxiv",
      failureCode: "ARXIV_API_ERROR",
      stage: "request",
      failureCategory: "timeout",
      retryable: true
    });
    expect(JSON.stringify(diagnostic)).not.toContain("do-not-expose");
  });

  it("keeps bounded request evidence without leaking raw errors or configuration", () => {
    const evidence = {
      endpointHost: "export.arxiv.org", categoryIndex: 2, page: 3, start: 200,
      attempts: 3, elapsedMs: 105000, attemptElapsedMs: 20000, timeoutMs: 20000,
      requestPhase: "body", httpStatus: 200, transportCode: "UND_ERR_BODY_TIMEOUT"
    };
    const diagnostic = classifyArxivFailure(new AppError("ARXIV_API_ERROR", "private", 502, {
      ...evidence, failureCategory: "timeout", category: "private-scope", headers: "private", cause: "private"
    }));
    expect(diagnostic).toEqual({
      source: "arxiv", failureCode: "ARXIV_API_ERROR", stage: "request",
      failureCategory: "timeout", retryable: true, ...evidence
    });
    expect(JSON.stringify(diagnostic)).not.toContain("private");
  });

  it("rejects invalid diagnostic strings, numbers, and hostile endpoint metadata", () => {
    const diagnostic = classifyArxivFailure(new AppError("ARXIV_API_ERROR", "private", 502, {
      failureCategory: "timeout", endpointHost: "private", categoryIndex: "private", page: -1,
      start: Infinity, attempts: 1.5, elapsedMs: NaN, attemptElapsedMs: -2,
      timeoutMs: 90000000, requestPhase: "private", httpStatus: 999, transportCode: "private"
    }));
    expect(diagnostic).toEqual({
      source: "arxiv", failureCode: "ARXIV_API_ERROR", stage: "request", failureCategory: "timeout", retryable: true
    });
  });
});
