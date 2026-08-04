import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseDotenv } from "dotenv";

import {
  hasValue,
  inspectRuntimeEnvironment,
  parseBoolean,
  resolveDeploymentMode
} from "./check-env.mjs";

const NVIDIA_NIM_BASE_URL = "https://integrate.api.nvidia.com/v1";
const NVIDIA_NIM_MODEL = "deepseek-ai/deepseek-v4-flash";
const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEEPSEEK_MODEL = "deepseek-v4-flash";

function check(level, code, message) {
  return { level, code, message };
}

function validatePair(checks, env, code, label, keys) {
  const configured = keys.filter((key) => hasValue(env, key));
  if (configured.length === 0) {
    checks.push(check("warn", code, `${label} is not configured (optional).`));
    return false;
  }
  if (configured.length !== keys.length) {
    checks.push(check("error", code, `${label} must be configured as a complete set.`));
    return false;
  }
  checks.push(check("ready", code, `${label} configuration is complete.`));
  return true;
}

function validateInteger(checks, env, key, code, minimum, maximum, fallback) {
  const raw = env[key]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    checks.push(check("error", code, `${key} must be an integer from ${minimum} to ${maximum}.`));
    return;
  }
  checks.push(check("ready", code, `${key} is in range.`));
}

function normalizedBaseUrl(value) {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/\/+$/, "") : undefined;
}

function isSafeBaseUrl(value) {
  const trimmed = value?.trim();
  if (!trimmed) return true;
  try {
    const parsed = new URL(trimmed);
    return (
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      !parsed.username &&
      !parsed.password &&
      !trimmed.includes("?") &&
      !trimmed.includes("#")
    );
  } catch {
    return false;
  }
}

function validateLlm(checks, env) {
  const rawProvider = env.LLM_PROVIDER?.trim().toLowerCase();
  const provider = rawProvider || undefined;
  const baseUrl = normalizedBaseUrl(env.LLM_BASE_URL) ?? normalizedBaseUrl(env.LLM_API_BASE_URL);
  const model = env.LLM_MODEL?.trim() || undefined;
  const hasKey = hasValue(env, "LLM_API_KEY");

  const unsafeKeys = ["LLM_BASE_URL", "LLM_API_BASE_URL"].filter(
    (key) => hasValue(env, key) && !isSafeBaseUrl(env[key])
  );
  if (unsafeKeys.length > 0) {
    for (const key of unsafeKeys) {
      checks.push(check("error", "llm", `${key} must be an HTTP(S) URL without credentials, query parameters, or fragments.`));
    }
    return;
  }

  if (
    provider &&
    provider !== "deepseek" &&
    provider !== "nvidia" &&
    provider !== "openai-compatible"
  ) {
    checks.push(check("error", "llm", "LLM_PROVIDER must be deepseek, nvidia, or openai-compatible."));
    return;
  }

  if (provider === "nvidia") {
    const effectiveBaseUrl = baseUrl ?? NVIDIA_NIM_BASE_URL;
    const effectiveModel = model ?? NVIDIA_NIM_MODEL;
    let valid = true;
    if (effectiveBaseUrl !== NVIDIA_NIM_BASE_URL) {
      checks.push(check("error", "llm", "NVIDIA LLM requires the hosted NVIDIA NIM base URL."));
      valid = false;
    }
    if (effectiveModel !== NVIDIA_NIM_MODEL) {
      checks.push(check("error", "llm", `NVIDIA LLM requires LLM_MODEL=${NVIDIA_NIM_MODEL}.`));
      valid = false;
    }
    if (!valid) return;
    checks.push(hasKey
      ? check("ready", "llm", "NVIDIA LLM configuration is complete.")
      : check("warn", "llm", "NVIDIA LLM API key is not configured (optional)."));
    return;
  }

  if (provider === "deepseek") {
    const effectiveBaseUrl = baseUrl ?? DEEPSEEK_BASE_URL;
    const effectiveModel = model ?? DEEPSEEK_MODEL;
    let valid = true;
    if (effectiveBaseUrl !== DEEPSEEK_BASE_URL) {
      checks.push(check("error", "llm", "DeepSeek LLM requires the official DeepSeek base URL."));
      valid = false;
    }
    if (effectiveModel !== DEEPSEEK_MODEL) {
      checks.push(check("error", "llm", `DeepSeek LLM requires LLM_MODEL=${DEEPSEEK_MODEL}.`));
      valid = false;
    }
    if (!valid) return;
    checks.push(hasKey
      ? check("ready", "llm", "DeepSeek official LLM configuration is complete.")
      : check("warn", "llm", "DeepSeek API key is not configured (optional)."));
    return;
  }

  if (!hasKey && !baseUrl) {
    checks.push(check("warn", "llm", "LLM provider is not configured (optional)."));
  } else if (!hasKey || !baseUrl) {
    checks.push(check("error", "llm", "LLM provider must include an API key and base URL."));
  } else {
    checks.push(check("ready", "llm", "LLM provider configuration is complete."));
  }
}

export async function inspectProject({
  projectDir = process.cwd(),
  platform = process.platform,
  nodeVersion = process.version,
  environment = process.env
} = {}) {
  const checks = [];

  const nodeMajor = Number(/^v?(\d+)/.exec(nodeVersion)?.[1]);
  checks.push(Number.isInteger(nodeMajor) && nodeMajor >= 22 && nodeMajor < 25
    ? check("ready", "node_version", "Node.js version is supported (>=22 <25).")
    : check("error", "node_version", "Node.js >=22 and <25 is required."));

  let fileEnv = {};
  let envFileFound = false;
  try {
    fileEnv = parseDotenv(await readFile(resolve(projectDir, ".env"), "utf8"));
    envFileFound = true;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      checks.push(check("error", "env_file", ".env could not be read."));
    }
  }

  const env = { ...fileEnv, ...environment };
  const deployment = resolveDeploymentMode(env);
  const mode = deployment.mode;

  if (envFileFound) {
    checks.push(check("ready", "env_file", ".env exists and is readable."));
  } else if (mode === "cloud") {
    checks.push(check("warn", "env_file", ".env is absent; cloud preflight is using injected environment values."));
  } else {
    checks.push(check("error", "env_file", ".env is missing; run npm run setup first."));
  }

  if (mode === "cloud") {
    checks.push(check("ready", "platform", "Cloud preflight is not restricted to Windows."));
  } else {
    checks.push(platform === "win32"
      ? check("ready", "platform", "Windows platform detected.")
      : check("error", "platform", "Local shared setup supports Windows only."));
  }

  const runtimeReport = inspectRuntimeEnvironment(env);
  checks.push(...runtimeReport.checks);

  const databaseUrl = env.DATABASE_URL?.trim();
  if (mode === "local" && /^file:\.\/[\\/]?prisma[\\/]/i.test(databaseUrl ?? "")) {
    const index = checks.findIndex((item) => item.code === "database_url");
    if (index >= 0) checks.splice(index, 1);
    checks.push(check(
      "error",
      "database_url",
      "Relative DATABASE_URL values are resolved from prisma/schema.prisma; use file:./dev.db for prisma/dev.db."
    ));
  }

  if (mode === "local") {
    const zoteroComplete = validatePair(checks, env, "zotero_web", "Zotero web credentials", ["ZOTERO_KEY", "ZOTERO_ID"]);
    if (env.ZOTERO_TRANSPORT?.trim().toLowerCase() === "web" && !zoteroComplete) {
      const index = checks.findIndex((item) => item.code === "zotero_web");
      checks[index] = check("error", "zotero_web", "Zotero web transport requires both ZOTERO_KEY and ZOTERO_ID.");
    }
  }

  validateLlm(checks, env);
  const embeddingRequested = [
    "EMBEDDING_API_KEY",
    "EMBEDDING_API_BASE_URL",
    "EMBEDDING_MODEL"
  ].some((key) => hasValue(env, key));
  if (!embeddingRequested) {
    checks.push(check("warn", "embedding", "Embedding provider is not configured (optional)."));
  } else {
    const llmProvider = env.LLM_PROVIDER?.trim().toLowerCase();
    const mayInheritLegacyLlm = !llmProvider || llmProvider === "openai-compatible";
    const hasEffectiveKey = hasValue(env, "EMBEDDING_API_KEY") || (
      mayInheritLegacyLlm && hasValue(env, "LLM_API_KEY")
    );
    const hasEffectiveBaseUrl = hasValue(env, "EMBEDDING_API_BASE_URL") || (
      mayInheritLegacyLlm && hasValue(env, "LLM_API_BASE_URL")
    );
    if (hasEffectiveKey && hasEffectiveBaseUrl && hasValue(env, "EMBEDDING_MODEL")) {
      checks.push(check("ready", "embedding", "Embedding provider configuration is complete."));
    } else {
      checks.push(check(
        "error",
        "embedding",
        "Embedding requires EMBEDDING_MODEL plus an embedding or LLM API key and base URL."
      ));
    }
  }

  if (mode === "local") {
    const obsidianEnabled = parseBoolean(env.OBSIDIAN_ENABLED);
    if (obsidianEnabled === null) {
      checks.push(check("error", "obsidian", "OBSIDIAN_ENABLED must be true or false."));
    } else if (obsidianEnabled && !hasValue(env, "OBSIDIAN_VAULT_PATH")) {
      checks.push(check("error", "obsidian", "Enabled Obsidian export requires OBSIDIAN_VAULT_PATH."));
    } else if (obsidianEnabled) {
      checks.push(check("ready", "obsidian", "Obsidian export configuration is complete."));
    } else {
      checks.push(check("warn", "obsidian", "Obsidian export is disabled (optional)."));
    }
  }

  const smtpKeys = [
    "NOTIFICATION_SMTP_HOST",
    "NOTIFICATION_SMTP_USER",
    "NOTIFICATION_SMTP_PASS",
    "NOTIFICATION_EMAIL_FROM",
    "NOTIFICATION_EMAIL_TO"
  ];
  const smtpConfigured = smtpKeys.filter((key) => hasValue(env, key));
  if (smtpConfigured.length === 0) {
    checks.push(check("warn", "smtp", "SMTP notification is not configured (optional)."));
  } else if (smtpConfigured.length !== smtpKeys.length) {
    checks.push(check("error", "smtp", "SMTP notification fields must be configured as a complete set."));
  } else {
    const smtpPort = Number(env.NOTIFICATION_SMTP_PORT?.trim() || "465");
    checks.push(Number.isInteger(smtpPort) && smtpPort >= 1 && smtpPort <= 65535
      ? check("ready", "smtp", "SMTP notification configuration is complete.")
      : check("error", "smtp", "NOTIFICATION_SMTP_PORT must be an integer from 1 to 65535."));
  }

  const operationsKeys = [
    "OPERATIONS_GITHUB_OWNER",
    "OPERATIONS_GITHUB_REPO",
    "OPERATIONS_GITHUB_TOKEN",
    "OPERATIONS_GITHUB_REF"
  ];
  const operationsConfigured = operationsKeys.filter((key) => hasValue(env, key));
  if (operationsConfigured.length === 0) {
    checks.push(check("warn", "operations_dispatch", "Operations retry dispatch is not configured (optional)."));
  } else if (operationsConfigured.length !== operationsKeys.length) {
    checks.push(check("error", "operations_dispatch", "Operations retry dispatch fields must be configured as a complete set."));
  } else {
    checks.push(check("ready", "operations_dispatch", "Operations retry dispatch configuration is complete."));
  }

  if (mode === "local") {
    validateInteger(checks, env, "SCHEDULER_DAILY_UTC_HOUR", "scheduler_daily_hour", 0, 23, 0);
    validateInteger(checks, env, "SCHEDULER_MONTHLY_UTC_DAY", "scheduler_monthly_day", 1, 31, 1);
    validateInteger(checks, env, "SCHEDULER_MONTHLY_UTC_HOUR", "scheduler_monthly_hour", 0, 23, 7);
    validateInteger(checks, env, "SCHEDULER_POLL_MS", "scheduler_poll_ms", 1, Number.MAX_SAFE_INTEGER, 60_000);
    validateInteger(checks, env, "SCHEDULER_RETRY_MS", "scheduler_retry_ms", 1, Number.MAX_SAFE_INTEGER, 900_000);
    validateInteger(checks, env, "OBSIDIAN_FEEDBACK_SYNC_MS", "obsidian_feedback_sync_ms", 1, Number.MAX_SAFE_INTEGER, 300_000);
  } else if (mode === "cloud") {
    checks.push(check("ready", "scheduler_loop", "Windows scheduler-loop timing and state settings are inactive in cloud mode."));
  }

  const summary = checks.reduce(
    (counts, item) => ({ ...counts, [item.level]: counts[item.level] + 1 }),
    { ready: 0, warn: 0, error: 0 }
  );
  return { checks, summary };
}

export async function runDoctor(options = {}) {
  const logger = options.logger ?? console.log;
  const report = await inspectProject(options);
  for (const item of report.checks) {
    logger(`[${item.level.toUpperCase()}] ${item.message}`);
  }
  logger(`Summary: ready=${report.summary.ready} warn=${report.summary.warn} error=${report.summary.error}`);
  return { ...report, exitCode: report.summary.error > 0 ? 1 : 0 };
}

function isMainModule() {
  return process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}

if (isMainModule()) {
  const result = await runDoctor();
  process.exitCode = result.exitCode;
}
