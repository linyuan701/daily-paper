import {
  DEEPSEEK_BASE_URL,
  DEEPSEEK_MODEL,
  NVIDIA_NIM_BASE_URL,
  NVIDIA_NIM_MODEL,
  type LlmProvider
} from "./llm";

export class EnvValidationError extends Error {
  missingKeys: string[];
  issues: string[];

  constructor(missingKeys: string[], issues: string[] = []) {
    const messages = [];
    if (missingKeys.length > 0) {
      messages.push(`Missing required environment variables: ${missingKeys.join(", ")}`);
    }
    messages.push(...issues);
    super(messages.join("; ") || "Invalid environment configuration");
    this.name = "EnvValidationError";
    this.missingKeys = missingKeys;
    this.issues = issues;
  }
}

export type DeploymentMode = "local" | "cloud";

export type DeploymentCapabilities = {
  sqlite: boolean;
  postgresql: boolean;
  windowsScheduler: boolean;
  zoteroLocal: boolean;
  obsidianFilesystem: boolean;
  desktopNotification: boolean;
};

type EnvironmentInput = Readonly<Record<string, string | undefined>>;

export type AppEnv = {
  DEPLOYMENT_MODE: DeploymentMode;
  CAPABILITIES: DeploymentCapabilities;
  DATABASE_URL: string;
  ZOTERO_KEY?: string;
  ZOTERO_ID?: string;
  ZOTERO_TRANSPORT: "local" | "web" | "auto";
  ZOTERO_LOCAL_API_URL: string;
  LLM_PROVIDER?: LlmProvider;
  LLM_API_KEY?: string;
  LLM_BASE_URL?: string;
  /** @deprecated Use LLM_BASE_URL. */
  LLM_API_BASE_URL?: string;
  LLM_MODEL?: string;
  LLM_TIMEOUT_MS: number;
  LLM_MAX_RETRIES: number;
  LLM_CONCURRENCY: number;
  LLM_LABEL_CANDIDATE_LIMIT: number;
  EMBEDDING_API_KEY?: string;
  EMBEDDING_API_BASE_URL?: string;
  EMBEDDING_MODEL?: string;
  EASYSCHOLAR_API_KEY?: string;
  EASYSCHOLAR_API_URL?: string;
  JOURNAL_ENRICHMENT_CACHE_TTL_HOURS: number;
  ARXIV_CATEGORY_SCOPES: string[];
  ARXIV_MAX_PAGES: number;
  ARXIV_RETRY_BACKOFF_MS: number;
  ARXIV_RETRY_AFTER_CAP_MS: number;
  BIORXIV_SUBJECT_SCOPES: string[];
  PUBMED_QUERY_SCOPE?: string;
  JOURNAL_FEED_URLS: string[];
  SOURCE_HTTP_TIMEOUT_MS: number;
  DAILY_MIN_CANDIDATE_POOL: number;
  DAILY_ROLLING_LOOKBACK_DAYS: number;
  DAILY_RUN_STALE_AFTER_MINUTES: number;
};

let cachedEnv: AppEnv | null = null;

function parseList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

export function loadEnv(rawEnv: EnvironmentInput = process.env): AppEnv {
  const requiredKeys = ["DATABASE_URL"] as const;
  const missing = requiredKeys.filter((key) => {
    const value = rawEnv[key];
    return value === undefined || value.trim() === "";
  });

  if (missing.length > 0) {
    throw new EnvValidationError([...missing]);
  }

  const issues: string[] = [];
  const deploymentMode = parseDeploymentMode(rawEnv.DEPLOYMENT_MODE, issues);
  const databaseUrl = rawEnv.DATABASE_URL?.trim() ?? "";
  const zoteroTransport = parseZoteroTransport(rawEnv.ZOTERO_TRANSPORT, issues);

  if (deploymentMode === "local" && !databaseUrl.startsWith("file:")) {
    issues.push("Local Mode requires DATABASE_URL to use Prisma's file: SQLite format");
  }
  if (
    deploymentMode === "cloud" &&
    !/^postgres(?:ql)?:\/\//i.test(databaseUrl)
  ) {
    issues.push("Cloud Mode requires DATABASE_URL to use postgresql: or postgres:");
  }

  const zoteroKey = rawEnv.ZOTERO_KEY?.trim() || undefined;
  const zoteroId = rawEnv.ZOTERO_ID?.trim() || undefined;
  const llmProvider = parseLlmProvider(rawEnv.LLM_PROVIDER, issues);
  validateLlmBaseUrl(rawEnv.LLM_BASE_URL, "LLM_BASE_URL", issues);
  validateLlmBaseUrl(rawEnv.LLM_API_BASE_URL, "LLM_API_BASE_URL", issues);
  const llmBaseUrl = normalizeBaseUrl(
    rawEnv.LLM_BASE_URL?.trim() || rawEnv.LLM_API_BASE_URL?.trim() || undefined
  );
  const llmModel = rawEnv.LLM_MODEL?.trim() || undefined;
  const inheritLegacyLlmEmbeddingConfig =
    llmProvider === undefined || llmProvider === "openai-compatible";
  if (zoteroTransport === "web" && (!zoteroKey || !zoteroId)) {
    issues.push("ZOTERO_TRANSPORT=web requires ZOTERO_KEY and ZOTERO_ID");
  }
  if (deploymentMode === "cloud") {
    if (zoteroTransport !== "web") {
      issues.push("Cloud Mode requires ZOTERO_TRANSPORT=web");
    }
    validateCloudLocalCapabilities(rawEnv, issues);
  }

  const resolvedLlmBaseUrl = llmProvider === "nvidia"
    ? llmBaseUrl ?? NVIDIA_NIM_BASE_URL
    : llmProvider === "deepseek"
      ? llmBaseUrl ?? DEEPSEEK_BASE_URL
      : llmBaseUrl;
  const resolvedLlmModel = llmProvider === "nvidia"
    ? llmModel ?? NVIDIA_NIM_MODEL
    : llmProvider === "deepseek"
      ? llmModel ?? DEEPSEEK_MODEL
      : llmModel;

  if (llmProvider === "nvidia") {
    if (resolvedLlmBaseUrl !== NVIDIA_NIM_BASE_URL) {
      issues.push("LLM_PROVIDER=nvidia requires the NVIDIA NIM hosted LLM_BASE_URL");
    }
    if (resolvedLlmModel !== NVIDIA_NIM_MODEL) {
      issues.push(`LLM_PROVIDER=nvidia requires LLM_MODEL=${NVIDIA_NIM_MODEL}`);
    }
  }
  if (llmProvider === "deepseek") {
    if (resolvedLlmBaseUrl !== DEEPSEEK_BASE_URL) {
      issues.push("LLM_PROVIDER=deepseek requires the official DeepSeek LLM_BASE_URL");
    }
    if (resolvedLlmModel !== DEEPSEEK_MODEL) {
      issues.push(`LLM_PROVIDER=deepseek requires LLM_MODEL=${DEEPSEEK_MODEL}`);
    }
  }

  if (issues.length > 0) {
    throw new EnvValidationError([], issues);
  }

  return {
    DEPLOYMENT_MODE: deploymentMode,
    CAPABILITIES: getDeploymentCapabilities(deploymentMode),
    DATABASE_URL: databaseUrl,
    ZOTERO_KEY: zoteroKey,
    ZOTERO_ID: zoteroId,
    ZOTERO_TRANSPORT: zoteroTransport,
    ZOTERO_LOCAL_API_URL: rawEnv.ZOTERO_LOCAL_API_URL?.trim() || "http://127.0.0.1:23119/api",
    LLM_PROVIDER: llmProvider,
    LLM_API_KEY: rawEnv.LLM_API_KEY?.trim() || undefined,
    LLM_BASE_URL: resolvedLlmBaseUrl,
    LLM_API_BASE_URL: resolvedLlmBaseUrl,
    LLM_MODEL: resolvedLlmModel,
    LLM_TIMEOUT_MS: parsePositiveInteger(rawEnv.LLM_TIMEOUT_MS, 30_000),
    LLM_MAX_RETRIES: parseNonNegativeInteger(rawEnv.LLM_MAX_RETRIES, 2),
    LLM_CONCURRENCY: parsePositiveInteger(rawEnv.LLM_CONCURRENCY, 4),
    LLM_LABEL_CANDIDATE_LIMIT: parsePositiveInteger(rawEnv.LLM_LABEL_CANDIDATE_LIMIT, 300),
    EMBEDDING_API_KEY: rawEnv.EMBEDDING_API_KEY?.trim() || (
      inheritLegacyLlmEmbeddingConfig ? rawEnv.LLM_API_KEY?.trim() : undefined
    ) || undefined,
    EMBEDDING_API_BASE_URL: rawEnv.EMBEDDING_API_BASE_URL?.trim() || (
      inheritLegacyLlmEmbeddingConfig ? rawEnv.LLM_API_BASE_URL?.trim() : undefined
    ) || undefined,
    EMBEDDING_MODEL: rawEnv.EMBEDDING_MODEL?.trim() || undefined,
    EASYSCHOLAR_API_KEY: rawEnv.EASYSCHOLAR_API_KEY,
    EASYSCHOLAR_API_URL: rawEnv.EASYSCHOLAR_API_URL,
    JOURNAL_ENRICHMENT_CACHE_TTL_HOURS: parsePositiveInteger(
      rawEnv.JOURNAL_ENRICHMENT_CACHE_TTL_HOURS,
      24 * 30
    ),
    ARXIV_CATEGORY_SCOPES: parseList(rawEnv.ARXIV_CATEGORY_SCOPES),
    ARXIV_MAX_PAGES: parsePositiveInteger(rawEnv.ARXIV_MAX_PAGES, 3),
    ARXIV_RETRY_BACKOFF_MS: parsePositiveInteger(rawEnv.ARXIV_RETRY_BACKOFF_MS, 15_000),
    ARXIV_RETRY_AFTER_CAP_MS: parsePositiveInteger(rawEnv.ARXIV_RETRY_AFTER_CAP_MS, 120_000),
    BIORXIV_SUBJECT_SCOPES: parseList(rawEnv.BIORXIV_SUBJECT_SCOPES),
    PUBMED_QUERY_SCOPE: rawEnv.PUBMED_QUERY_SCOPE,
    JOURNAL_FEED_URLS: parseList(rawEnv.JOURNAL_FEED_URLS),
    SOURCE_HTTP_TIMEOUT_MS: parsePositiveInteger(rawEnv.SOURCE_HTTP_TIMEOUT_MS, 20_000),
    DAILY_MIN_CANDIDATE_POOL: parseNonNegativeInteger(rawEnv.DAILY_MIN_CANDIDATE_POOL, 50),
    DAILY_ROLLING_LOOKBACK_DAYS: parseNonNegativeInteger(rawEnv.DAILY_ROLLING_LOOKBACK_DAYS, 3),
    DAILY_RUN_STALE_AFTER_MINUTES: parsePositiveInteger(rawEnv.DAILY_RUN_STALE_AFTER_MINUTES, 180)
  };
}

function parseDeploymentMode(value: string | undefined, issues: string[]): DeploymentMode {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "local") return "local";
  if (normalized === "cloud") return "cloud";
  issues.push("DEPLOYMENT_MODE must be local or cloud");
  return "local";
}

function parseZoteroTransport(
  value: string | undefined,
  issues: string[]
): "local" | "web" | "auto" {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "auto") return "auto";
  if (normalized === "local" || normalized === "web") return normalized;
  issues.push("ZOTERO_TRANSPORT must be local, web, or auto");
  return "auto";
}

function parseLlmProvider(value: string | undefined, issues: string[]): LlmProvider | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (
    normalized === "deepseek" ||
    normalized === "nvidia" ||
    normalized === "openai-compatible"
  ) return normalized;
  issues.push("LLM_PROVIDER must be deepseek, nvidia, or openai-compatible");
  return undefined;
}

function normalizeBaseUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.replace(/\/+$/, "") || undefined;
}

function validateLlmBaseUrl(
  value: string | undefined,
  key: "LLM_BASE_URL" | "LLM_API_BASE_URL",
  issues: string[]
): void {
  const trimmed = value?.trim();
  if (!trimmed) return;

  try {
    const parsed = new URL(trimmed);
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.username ||
      parsed.password ||
      trimmed.includes("?") ||
      trimmed.includes("#")
    ) {
      throw new Error("unsafe URL");
    }
  } catch {
    issues.push(`${key} must be an HTTP(S) URL without credentials, query parameters, or fragments`);
  }
}

function validateCloudLocalCapabilities(rawEnv: EnvironmentInput, issues: string[]): void {
  const obsidianEnabled = parseOptionalBoolean(rawEnv.OBSIDIAN_ENABLED, "OBSIDIAN_ENABLED", issues);
  const effectiveObsidianEnabled = obsidianEnabled ?? Boolean(rawEnv.OBSIDIAN_VAULT_PATH?.trim());
  const desktopEnabled = parseOptionalBoolean(
    rawEnv.SCHEDULER_DESKTOP_NOTIFICATION_ENABLED,
    "SCHEDULER_DESKTOP_NOTIFICATION_ENABLED",
    issues
  );

  if (effectiveObsidianEnabled) {
    issues.push("Cloud Mode does not support direct Obsidian filesystem access");
  }
  if (desktopEnabled === true) {
    issues.push("Cloud Mode does not support Windows desktop notifications");
  }
}

function parseOptionalBoolean(
  value: string | undefined,
  key: string,
  issues: string[]
): boolean | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  issues.push(`${key} must be true or false`);
  return undefined;
}

export function getDeploymentCapabilities(mode: DeploymentMode): DeploymentCapabilities {
  const local = mode === "local";
  return {
    sqlite: local,
    postgresql: !local,
    windowsScheduler: local,
    zoteroLocal: local,
    obsidianFilesystem: local,
    desktopNotification: local
  };
}

function parseNonNegativeInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function getEnv(): AppEnv {
  if (cachedEnv) {
    return cachedEnv;
  }
  cachedEnv = loadEnv();
  return cachedEnv;
}
