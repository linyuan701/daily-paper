import { AppError } from "../../lib/errors";
import {
  DEEPSEEK_BASE_URL,
  DEEPSEEK_MODEL,
  NVIDIA_NIM_BASE_URL,
  NVIDIA_NIM_MODEL,
  type LlmProvider
} from "../../lib/config/llm";
import type { CandidateGeneratedOutput, CandidateOutputProvider } from "./types";

type GenericLlmProviderOptions = {
  provider?: LlmProvider;
  apiKey: string;
  apiBaseUrl: string;
  model?: string;
  timeoutMs?: number;
  maxRetries?: number;
  concurrency?: number;
};

export class UnavailableCandidateOutputProvider implements CandidateOutputProvider {
  readonly name = "unavailable";

  constructor(private readonly reason = "Candidate output provider is not configured") {}

  getHealth() {
    return { name: this.name, status: "unavailable" as const, reason: this.reason };
  }

  async generateLabels(): Promise<CandidateGeneratedOutput["labels"]> {
    return this.unavailable();
  }

  async generateSummary(): Promise<CandidateGeneratedOutput["summary"]> {
    return this.unavailable();
  }

  async generateOutput(): Promise<CandidateGeneratedOutput> {
    return this.unavailable();
  }

  private unavailable(): never {
    throw new AppError("CANDIDATE_OUTPUT_UNAVAILABLE", this.reason, 503);
  }
}

export class GenericLlmCandidateOutputProvider implements CandidateOutputProvider {
  readonly name: "deepseek-official" | "generic-llm" | "nvidia-nim";
  private readonly provider: LlmProvider;
  private readonly endpoint: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly concurrency: number;

  constructor(private readonly options: GenericLlmProviderOptions) {
    this.provider = options.provider ?? "openai-compatible";
    this.name = this.provider === "nvidia"
      ? "nvidia-nim"
      : this.provider === "deepseek"
        ? "deepseek-official"
        : "generic-llm";
    this.endpoint = options.apiBaseUrl.replace(/\/+$/, "");
    this.model = options.model ?? (
      this.provider === "nvidia"
        ? NVIDIA_NIM_MODEL
        : this.provider === "deepseek"
          ? DEEPSEEK_MODEL
          : "gpt-4o-mini"
    );
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = normalizeMaxRetries(options.maxRetries);
    this.concurrency = options.concurrency ?? 4;
  }

  getHealth() {
    return {
      name: this.name,
      status: "ready" as const,
      model: this.model,
      endpoint: this.endpoint,
      timeoutMs: this.timeoutMs,
      maxRetries: this.maxRetries,
      concurrency: this.concurrency
    };
  }

  async generateOutput(input: {
    candidateId: string;
    runId: string;
    canonicalKey: string;
    title?: string;
    abstractNote?: string;
    journalName?: string;
    doi?: string;
    sourceProvenance: Array<{ source: "biorxiv" | "arxiv" | "pubmed" | "journal"; externalId: string }>;
  }): Promise<CandidateGeneratedOutput> {
    const parsed = await this.requestJson(buildOutputPrompt(input));
    return normalizeGeneratedOutput(parsed);
  }

  async generateLabels(input: Parameters<CandidateOutputProvider["generateLabels"]>[0]) {
    const parsed = await this.requestJson(buildLabelsPrompt(input));
    return normalizeLabels(parsed);
  }

  async generateLabelsBatch(
    inputs: Parameters<NonNullable<CandidateOutputProvider["generateLabelsBatch"]>>[0]
  ) {
    const parsed = await this.requestJson(buildLabelBatchPrompt(inputs));
    return normalizeLabelBatch(parsed, inputs.map((input) => input.candidateId));
  }

  async generateSummary(input: Parameters<CandidateOutputProvider["generateSummary"]>[0]) {
    const parsed = await this.requestJson(buildSummaryPrompt(input));
    return normalizeSummary(parsed);
  }

  private async requestJson(prompt: string): Promise<unknown> {
    const body = {
      model: this.model,
      messages: [
        {
          role: "system",
          content:
            "Return only valid JSON. Keep wording concise, factual, and suitable for later user editing."
        },
        { role: "user", content: prompt }
      ],
      temperature: 0.2,
      stream: false,
      response_format: { type: "json_object" },
      ...(this.provider === "nvidia"
        ? { chat_template_kwargs: { thinking: false } }
        : this.provider === "deepseek"
          ? { thinking: { type: "disabled" } }
          : {})
    };
    const response = await fetchLlmCompletion(
      `${this.endpoint}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.options.apiKey}`
        },
        body: JSON.stringify(body)
      },
      {
        timeoutMs: this.timeoutMs,
        maxRetries: this.maxRetries
      }
    );

    const payload = await response.json().catch(() => {
      throw providerSchemaError("response", "must be valid JSON");
    });
    const content = extractProviderContent(payload);
    if (!content || typeof content !== "string") {
      throw new AppError(
        "CANDIDATE_OUTPUT_PROVIDER_ERROR",
        "Candidate output generation response is missing content",
        502
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new AppError(
        "CANDIDATE_OUTPUT_PROVIDER_ERROR",
        "Candidate output generation did not return valid JSON",
        502
      );
    }

    return parsed;
  }
}

export function createCandidateOutputProvider(input: {
  provider?: LlmProvider;
  apiKey?: string;
  apiBaseUrl?: string;
  model?: string;
  timeoutMs?: number;
  maxRetries?: number;
  concurrency?: number;
}): CandidateOutputProvider {
  const provider = input.provider ?? "openai-compatible";
  const apiKey = input.apiKey?.trim();
  const apiBaseUrl = input.apiBaseUrl?.trim() || (
    provider === "nvidia"
      ? NVIDIA_NIM_BASE_URL
      : provider === "deepseek"
        ? DEEPSEEK_BASE_URL
        : undefined
  );
  const model = input.model?.trim();

  if (!apiKey || !apiBaseUrl) {
    const missing = [
      ...(!apiKey ? ["LLM_API_KEY"] : []),
      ...(!apiBaseUrl ? ["LLM_BASE_URL"] : [])
    ];
    return new UnavailableCandidateOutputProvider(
      `LLM configuration is missing: ${missing.join(", ")}.`
    );
  }

  if (
    provider === "nvidia" &&
    (apiBaseUrl.replace(/\/+$/, "") !== NVIDIA_NIM_BASE_URL || (model && model !== NVIDIA_NIM_MODEL))
  ) {
    return new UnavailableCandidateOutputProvider("NVIDIA NIM configuration is invalid.");
  }
  if (
    provider === "deepseek" &&
    (apiBaseUrl.replace(/\/+$/, "") !== DEEPSEEK_BASE_URL || (model && model !== DEEPSEEK_MODEL))
  ) {
    return new UnavailableCandidateOutputProvider("DeepSeek official configuration is invalid.");
  }

  return new GenericLlmCandidateOutputProvider({
    provider,
    apiKey,
    apiBaseUrl,
    model: model || undefined,
    timeoutMs: input.timeoutMs,
    maxRetries: input.maxRetries,
    concurrency: input.concurrency
  });
}

type LlmRequestOptions = {
  timeoutMs: number;
  maxRetries: number;
};

const RETRYABLE_LLM_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const GATEWAY_RETRY_STATUS_MIN = 520;
const GATEWAY_RETRY_STATUS_MAX = 529;
const MAX_LLM_RETRIES = 5;
const LLM_RETRY_BACKOFF_MS = 250;

async function fetchLlmCompletion(
  endpoint: string,
  init: RequestInit,
  options: LlmRequestOptions
): Promise<Response> {
  for (let attempt = 0; attempt <= options.maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    let response: Response;

    try {
      response = await fetch(endpoint, { ...init, signal: controller.signal });
    } catch (error) {
      clearTimeout(timeout);
      if (controller.signal.aborted || isAbortError(error)) {
        throw providerRequestError("timeout", attempt + 1, options);
      }
      throw providerRequestError("network", attempt + 1, options);
    }
    clearTimeout(timeout);

    if (response.status === 200) {
      return response;
    }

    await discardResponseBody(response);
    if (isRetryableLlmStatus(response.status) && attempt < options.maxRetries) {
      await waitForRetry(LLM_RETRY_BACKOFF_MS * (attempt + 1));
      continue;
    }

    throw providerStatusError(response.status, attempt + 1, options);
  }

  throw providerRequestError("retry_exhausted", options.maxRetries + 1, options);
}

function providerStatusError(status: number, attempts: number, options: LlmRequestOptions) {
  const classification =
    status === 202
      ? "pending_response"
      : status === 401
        ? "authentication_failed"
        : status === 402
          ? "insufficient_balance"
          : status === 403
            ? "authorization_failed"
            : status === 408
              ? "request_timeout_status"
              : status === 429
                ? "rate_limited"
                : isRetryableLlmStatus(status)
                  ? "upstream_unavailable"
                  : status >= 400 && status < 500
                    ? "request_rejected"
                    : "unexpected_status";

  return new AppError(
    "CANDIDATE_OUTPUT_PROVIDER_HTTP_ERROR",
    `Candidate output provider request failed (${classification}).`,
    502,
    {
      classification,
      status,
      attempts,
      timeoutMs: options.timeoutMs,
      maxRetries: options.maxRetries
    }
  );
}

function providerRequestError(
  classification: "timeout" | "network" | "retry_exhausted",
  attempts: number,
  options: LlmRequestOptions
) {
  return new AppError(
    "CANDIDATE_OUTPUT_PROVIDER_REQUEST_FAILED",
    `Candidate output provider request failed (${classification}).`,
    502,
    {
      classification,
      attempts,
      timeoutMs: options.timeoutMs,
      maxRetries: options.maxRetries
    }
  );
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function waitForRetry(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function isRetryableLlmStatus(status: number) {
  return RETRYABLE_LLM_STATUS_CODES.has(status) || (
    status >= GATEWAY_RETRY_STATUS_MIN && status <= GATEWAY_RETRY_STATUS_MAX
  );
}

async function discardResponseBody(response: Response) {
  try {
    await response.body?.cancel();
  } catch {
    // The response is discarded before a retry or failure; never surface provider body details.
  }
}

function normalizeMaxRetries(value?: number) {
  if (value === undefined) return 2;
  if (!Number.isInteger(value) || value < 0) return 0;
  return Math.min(value, MAX_LLM_RETRIES);
}

function buildContext(input: {
  title?: string;
  abstractNote?: string;
  journalName?: string;
  doi?: string;
  sourceProvenance: Array<{ source: "biorxiv" | "arxiv" | "pubmed" | "journal"; externalId: string }>;
}) {
  return {
    title: input.title ?? "",
    abstract: input.abstractNote ?? "",
    journal: input.journalName ?? "",
    doi: input.doi ?? "",
    sources: input.sourceProvenance
  };
}

function buildOutputPrompt(input: Parameters<CandidateOutputProvider["generateOutput"]>[0]) {
  const context = buildContext(input);

  return `
Generate structured JSON with this exact shape:
{
  "summary": {
    "researchQuestion": "string",
    "method": "string",
    "mainFinding": "string",
    "relevanceToUser": "string"
  },
  "labels": {
    "contentRecallLabel": "string",
    "researchType": {
      "category": "method|biology|resource|benchmark",
      "primaryKeyword": "string",
      "secondaryKeyword": "string"
    }
  }
}

Write every non-empty summary field in concise Simplified Chinese. Scientific names, gene symbols,
method names, and standard abbreviations may remain in English, but the surrounding explanation must be Chinese.
Use only the supplied title, abstract, and metadata. This is not a full-text review: do not invent sample sizes,
methods, results, or limitations that are absent from the input. In relevanceToUser, describe only the paper's
potential reading or reuse value based on its content; do not claim knowledge of the user's profile or ranking
signals. Recommendation reasons are produced separately from persisted rerank evidence, not by this output.
Labels may remain in the language most appropriate for ranking. Use empty strings only for individual
unsupported fields. Do not return every summary or label field empty.
Input:
${JSON.stringify(context)}
`.trim();
}

function buildLabelsPrompt(input: Parameters<CandidateOutputProvider["generateLabels"]>[0]) {
  return `
Generate lightweight ranking labels as JSON with this exact shape:
{
  "contentRecallLabel": "string",
  "researchType": {
    "category": "method|biology|resource|benchmark",
    "primaryKeyword": "string",
    "secondaryKeyword": "string"
  }
}

Use empty strings only for individual unsupported fields. Do not return all label fields empty. Do not generate a summary.
Input:
${JSON.stringify(buildContext(input))}
`.trim();
}

function buildLabelBatchPrompt(
  inputs: Parameters<NonNullable<CandidateOutputProvider["generateLabelsBatch"]>>[0]
) {
  return `
Generate lightweight ranking labels for every input item as JSON with this exact shape:
{
  "items": [
    {
      "candidateId": "copy the input candidateId exactly",
      "labels": {
        "contentRecallLabel": "string",
        "researchType": {
          "category": "method|biology|resource|benchmark",
          "primaryKeyword": "string",
          "secondaryKeyword": "string"
        }
      }
    }
  ]
}

Return exactly one item for each input candidateId. Do not generate summaries.
Input:
${JSON.stringify(inputs.map((input) => ({
  candidateId: input.candidateId,
  ...buildContext(input)
})))}
`.trim();
}

function buildSummaryPrompt(input: Parameters<CandidateOutputProvider["generateSummary"]>[0]) {
  return `
Generate a concise factual summary as JSON with this exact shape:
{
  "researchQuestion": "string",
  "method": "string",
  "mainFinding": "string",
  "relevanceToUser": "string"
}

Write every non-empty field in concise Simplified Chinese. Scientific names, gene symbols, method names,
and standard abbreviations may remain in English, but the surrounding explanation must be Chinese.
Use only the supplied title, abstract, and metadata. This is not a full-text review: do not invent sample sizes,
methods, results, or limitations that are absent from the input. In relevanceToUser, describe only the paper's
potential reading or reuse value based on its content; do not claim knowledge of the user's profile or ranking
signals. Recommendation reasons are produced separately from persisted rerank evidence.
Use empty strings only for individual unsupported fields. Populate at least two supported summary fields.
Do not generate labels.
Input:
${JSON.stringify(buildContext(input))}
`.trim();
}

function normalizeGeneratedOutput(value: unknown): CandidateGeneratedOutput {
  const record = requireObject(value, "output", ["summary", "labels"]);
  return {
    summary: normalizeSummary(record.summary),
    labels: normalizeLabels(record.labels)
  };
}

function normalizeSummary(value: unknown): CandidateGeneratedOutput["summary"] {
  const summaryRecord = requireObject(value, "summary", [
    "researchQuestion",
    "method",
    "mainFinding",
    "relevanceToUser"
  ]);
  const summary = {
    researchQuestion: requireString(summaryRecord.researchQuestion, "summary.researchQuestion"),
    method: requireString(summaryRecord.method, "summary.method"),
    mainFinding: requireString(summaryRecord.mainFinding, "summary.mainFinding"),
    relevanceToUser: requireString(summaryRecord.relevanceToUser, "summary.relevanceToUser")
  };
  if (Object.values(summary).filter(Boolean).length < 2) {
    throw providerSchemaError("summary", "must contain at least two non-empty supported fields");
  }
  const nonChineseField = Object.entries(summary).find(
    ([, content]) => content.length > 0 && !containsHan(content)
  );
  if (nonChineseField) {
    throw providerSchemaError(
      `summary.${nonChineseField[0]}`,
      "must contain Simplified Chinese prose; technical names may remain in English"
    );
  }
  return summary;
}

function containsHan(value: string) {
  return /\p{Script=Han}/u.test(value);
}

function normalizeLabels(value: unknown): CandidateGeneratedOutput["labels"] {
  const labelsRecord = requireObject(value, "labels", ["contentRecallLabel", "researchType"]);
  const researchTypeRecord = requireObject(labelsRecord.researchType, "labels.researchType", [
    "category",
    "primaryKeyword",
    "secondaryKeyword"
  ]);

  const category = normalizeCategory(
    requireString(researchTypeRecord.category, "labels.researchType.category")
  );
  const contentRecallLabel = requireString(labelsRecord.contentRecallLabel, "labels.contentRecallLabel");
  const primaryKeyword = requireString(researchTypeRecord.primaryKeyword, "labels.researchType.primaryKeyword");
  const secondaryKeyword = requireString(researchTypeRecord.secondaryKeyword, "labels.researchType.secondaryKeyword");

  if (!contentRecallLabel && !category && !primaryKeyword && !secondaryKeyword) {
    throw providerSchemaError("labels", "must contain at least one non-empty ranking signal");
  }

  return {
    contentRecallLabel: contentRecallLabel || undefined,
    researchType: {
      category,
      primaryKeyword: primaryKeyword || undefined,
      secondaryKeyword: secondaryKeyword || undefined,
      rawText: buildResearchTypeRawText({
        category,
        primaryKeyword: primaryKeyword || undefined,
        secondaryKeyword: secondaryKeyword || undefined
      })
    }
  };
}

function normalizeLabelBatch(value: unknown, expectedCandidateIds: string[]) {
  const batch = requireObject(value, "batch", ["items"]);
  if (!Array.isArray(batch.items)) {
    throw providerSchemaError("batch.items", "must be an array");
  }

  const byCandidateId = new Map<string, CandidateGeneratedOutput["labels"]>();
  for (const [index, item] of batch.items.entries()) {
    const record = requireObject(item, `batch.items[${index}]`, ["candidateId", "labels"]);
    const candidateId = requireNonEmptyString(record.candidateId, `batch.items[${index}].candidateId`);
    if (byCandidateId.has(candidateId)) {
      throw providerSchemaError(`batch.items[${index}].candidateId`, "must be unique");
    }
    byCandidateId.set(candidateId, normalizeLabels(record.labels));
  }

  const expected = new Set(expectedCandidateIds);
  const unexpected = [...byCandidateId.keys()].filter((candidateId) => !expected.has(candidateId));
  const missing = expectedCandidateIds.filter((candidateId) => !byCandidateId.has(candidateId));
  if (unexpected.length > 0 || missing.length > 0) {
    throw providerSchemaError(
      "batch.items",
      `candidateId mismatch; missing=${missing.join(",") || "none"}, unexpected=${unexpected.join(",") || "none"}`
    );
  }

  return expectedCandidateIds.map((candidateId) => ({
    candidateId,
    labels: byCandidateId.get(candidateId)!
  }));
}

function normalizeCategory(value: unknown): "method" | "biology" | "resource" | "benchmark" | undefined {
  const normalized = toStringValue(value)?.toLowerCase();
  if (!normalized) return undefined;
  if (
    normalized === "method" ||
    normalized === "biology" ||
    normalized === "resource" ||
    normalized === "benchmark"
  ) {
    return normalized;
  }
  throw providerSchemaError(
    "labels.researchType.category",
    "must be method, biology, resource, benchmark, or an empty string"
  );
}

function buildResearchTypeRawText(input: {
  category?: "method" | "biology" | "resource" | "benchmark";
  primaryKeyword?: string;
  secondaryKeyword?: string;
}) {
  if (!input.category && !input.primaryKeyword && !input.secondaryKeyword) {
    return undefined;
  }

  const category = input.category ?? "method";
  const primary = input.primaryKeyword ?? "";
  const secondary = input.secondaryKeyword ? `, ${input.secondaryKeyword}` : "";
  return `${category} | ${primary}${secondary}`.trim();
}

function extractProviderContent(value: unknown) {
  const payload = requireLooseObject(value, "response");
  if (!Array.isArray(payload.choices) || payload.choices.length === 0) {
    throw providerSchemaError("response.choices", "must contain at least one choice");
  }
  const choice = requireLooseObject(payload.choices[0], "response.choices[0]");
  inspectFinishReason(choice.finish_reason);
  inspectUsage(payload.usage);
  const message = requireLooseObject(choice.message, "response.choices[0].message");
  inspectIgnoredReasoningField(message.reasoning, "response.choices[0].message.reasoning");
  inspectIgnoredReasoningField(
    message.reasoning_content,
    "response.choices[0].message.reasoning_content"
  );
  return requireNonEmptyString(message.content, "response.choices[0].message.content");
}

function inspectIgnoredReasoningField(value: unknown, path: string) {
  if (value === undefined || value === null || typeof value === "string") return;
  throw providerSchemaError(path, "must be a string, null, or omitted");
}

function inspectFinishReason(value: unknown) {
  if (value === undefined || value === null || value === "stop") return;
  if (typeof value !== "string") {
    throw providerSchemaError("response.choices[0].finish_reason", "must be a string, null, or omitted");
  }
  throw providerSchemaError(
    "response.choices[0].finish_reason",
    "must be stop for a complete structured response"
  );
}

function inspectUsage(value: unknown) {
  if (value === undefined) return;
  const usage = requireLooseObject(value, "response.usage");
  for (const key of ["prompt_tokens", "completion_tokens", "total_tokens"]) {
    const count = usage[key];
    if (count !== undefined && (!Number.isInteger(count) || (count as number) < 0)) {
      throw providerSchemaError(`response.usage.${key}`, "must be a non-negative integer when provided");
    }
  }
}

function requireObject(value: unknown, path: string, expectedKeys: string[]) {
  const record = requireLooseObject(value, path);
  const missing = expectedKeys.filter((key) => !(key in record));
  const unexpected = Object.keys(record).filter((key) => !expectedKeys.includes(key));
  if (missing.length > 0) {
    throw providerSchemaError(path, `is missing required field(s): ${missing.join(", ")}`);
  }
  if (unexpected.length > 0) {
    throw providerSchemaError(path, `contains unexpected field(s): ${unexpected.join(", ")}`);
  }
  return record;
}

function requireLooseObject(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw providerSchemaError(path, "must be an object");
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, path: string) {
  if (typeof value !== "string") throw providerSchemaError(path, "must be a string");
  return value.trim();
}

function requireNonEmptyString(value: unknown, path: string) {
  const result = requireString(value, path);
  if (!result) throw providerSchemaError(path, "must not be empty");
  return result;
}

function providerSchemaError(path: string, message: string) {
  return new AppError(
    "CANDIDATE_OUTPUT_INVALID_SCHEMA",
    `Invalid candidate output provider response at ${path}: ${message}`,
    502,
    { path, issue: message }
  );
}

function toStringValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
