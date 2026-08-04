import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";

const NVIDIA_NIM_BASE_URL = "https://integrate.api.nvidia.com/v1";
const NVIDIA_NIM_MODEL = "deepseek-ai/deepseek-v4-flash";
const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEEPSEEK_MODEL = "deepseek-v4-flash";

function result(level, code, message) {
  return { level, code, message };
}

export function hasValue(env, key) {
  return Boolean(env[key]?.trim());
}

export function parseBoolean(value) {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  if (!normalized) return undefined;
  return null;
}

export function resolveDeploymentMode(env) {
  const configured = env.DEPLOYMENT_MODE?.trim().toLowerCase();
  if (!configured) return { mode: "local" };
  if (configured === "local" || configured === "cloud") return { mode: configured };
  return {
    mode: null,
    error: "DEPLOYMENT_MODE must be local or cloud."
  };
}

function normalizeBaseUrl(value) {
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

function inspectLlmEnvironment(env, mode) {
  const checks = [];
  const provider = env.LLM_PROVIDER?.trim().toLowerCase() || undefined;
  const canonicalBaseUrl = normalizeBaseUrl(env.LLM_BASE_URL);
  const legacyBaseUrl = normalizeBaseUrl(env.LLM_API_BASE_URL);
  const baseUrl = canonicalBaseUrl ?? legacyBaseUrl;
  const model = env.LLM_MODEL?.trim() || undefined;
  const hasKey = hasValue(env, "LLM_API_KEY");
  const configured = Boolean(provider || hasKey || baseUrl);

  for (const key of ["LLM_BASE_URL", "LLM_API_BASE_URL"]) {
    if (hasValue(env, key) && !isSafeBaseUrl(env[key])) {
      checks.push(result("error", "llm_base_url", `${key} must be an HTTP(S) URL without credentials, query parameters, or fragments.`));
    }
  }
  if (checks.length > 0) return checks;

  if (
    provider &&
    provider !== "deepseek" &&
    provider !== "nvidia" &&
    provider !== "openai-compatible"
  ) {
    return [result("error", "llm_provider", "LLM_PROVIDER must be deepseek, nvidia, or openai-compatible.")];
  }
  if (!configured) return checks;

  if (provider === "nvidia") {
    const effectiveBaseUrl = baseUrl ?? NVIDIA_NIM_BASE_URL;
    const effectiveModel = model ?? NVIDIA_NIM_MODEL;
    if (effectiveBaseUrl !== NVIDIA_NIM_BASE_URL) {
      checks.push(result("error", "llm_base_url", "LLM_PROVIDER=nvidia requires the hosted NVIDIA NIM LLM_BASE_URL."));
    }
    if (effectiveModel !== NVIDIA_NIM_MODEL) {
      checks.push(result("error", "llm_model", `LLM_PROVIDER=nvidia requires LLM_MODEL=${NVIDIA_NIM_MODEL}.`));
    }
    if (!hasKey) {
      checks.push(mode === "cloud"
        ? result("error", "llm_api_key", "Cloud mode LLM configuration is missing: LLM_API_KEY.")
        : result("warn", "llm_api_key", "LLM_API_KEY is not configured; local LLM generation remains optional."));
    }
    if (checks.every((item) => item.level !== "error") && hasKey) {
      checks.push(result("ready", "llm", "NVIDIA LLM configuration is complete."));
    }
    return checks;
  }

  if (provider === "deepseek") {
    const effectiveBaseUrl = baseUrl ?? DEEPSEEK_BASE_URL;
    const effectiveModel = model ?? DEEPSEEK_MODEL;
    if (effectiveBaseUrl !== DEEPSEEK_BASE_URL) {
      checks.push(result("error", "llm_base_url", "LLM_PROVIDER=deepseek requires the official DeepSeek LLM_BASE_URL."));
    }
    if (effectiveModel !== DEEPSEEK_MODEL) {
      checks.push(result("error", "llm_model", `LLM_PROVIDER=deepseek requires LLM_MODEL=${DEEPSEEK_MODEL}.`));
    }
    if (!hasKey) {
      checks.push(mode === "cloud"
        ? result("error", "llm_api_key", "Cloud mode LLM configuration is missing: LLM_API_KEY.")
        : result("warn", "llm_api_key", "LLM_API_KEY is not configured; local LLM generation remains optional."));
    }
    if (checks.every((item) => item.level !== "error") && hasKey) {
      checks.push(result("ready", "llm", "DeepSeek official LLM configuration is complete."));
    }
    return checks;
  }

  const missing = [
    !hasKey ? "LLM_API_KEY" : undefined,
    !baseUrl ? "LLM_BASE_URL" : undefined
  ].filter(Boolean);
  if (missing.length > 0) {
    checks.push(result("error", "llm", `${mode === "cloud" ? "Cloud mode LLM" : "LLM"} configuration is missing: ${missing.join(", ")}.`));
  } else {
    checks.push(result("ready", "llm", "OpenAI-compatible LLM configuration is complete."));
  }
  return checks;
}

export function inspectRuntimeEnvironment(env) {
  const checks = [];
  const deployment = resolveDeploymentMode(env);
  if (!deployment.mode) {
    checks.push(result("error", "deployment_mode", deployment.error));
    return { mode: null, checks };
  }

  const { mode } = deployment;
  checks.push(result("ready", "deployment_mode", `Deployment mode is ${mode}.`));

  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    checks.push(result("error", "database_url", "DATABASE_URL is required."));
  } else if (mode === "local" && !databaseUrl.startsWith("file:")) {
    checks.push(result("error", "database_url", "Local mode requires a file: SQLite DATABASE_URL."));
  } else if (mode === "cloud" && !/^postgres(?:ql)?:\/\//i.test(databaseUrl)) {
    checks.push(result("error", "database_url", "Cloud mode requires a postgresql: or postgres: DATABASE_URL."));
  } else {
    checks.push(result("ready", "database_url", `${mode === "local" ? "SQLite" : "PostgreSQL"} database URL format is valid.`));
  }

  checks.push(...inspectLlmEnvironment(env, mode));

  const transport = env.ZOTERO_TRANSPORT?.trim().toLowerCase() || "auto";
  if (!["local", "web", "auto"].includes(transport)) {
    checks.push(result("error", "zotero_transport", "ZOTERO_TRANSPORT must be local, web, or auto."));
  } else if (mode === "local") {
    checks.push(result("ready", "zotero_transport", `Local mode uses Zotero ${transport} transport.`));
    if (transport === "web") {
      checks.push(hasValue(env, "ZOTERO_KEY") && hasValue(env, "ZOTERO_ID")
        ? result("ready", "zotero_web", "Zotero web credentials are complete.")
        : result("error", "zotero_web", "Zotero web transport requires both ZOTERO_KEY and ZOTERO_ID."));
    }
  }

  if (mode === "cloud") {
    checks.push(transport === "web"
      ? result("ready", "zotero_transport", "Cloud mode uses Zotero web transport.")
      : result("error", "zotero_transport", "Cloud mode requires ZOTERO_TRANSPORT=web."));

    checks.push(hasValue(env, "ZOTERO_KEY") && hasValue(env, "ZOTERO_ID")
      ? result("ready", "zotero_web", "Zotero web credentials are complete.")
      : result("error", "zotero_web", "Cloud mode requires both ZOTERO_KEY and ZOTERO_ID."));

    const obsidianFlag = parseBoolean(env.OBSIDIAN_ENABLED);
    const obsidianActive = obsidianFlag === true || (obsidianFlag === undefined && hasValue(env, "OBSIDIAN_VAULT_PATH"));
    if (obsidianFlag === null) {
      checks.push(result("error", "obsidian", "OBSIDIAN_ENABLED must be true or false."));
    } else if (obsidianActive) {
      checks.push(result("error", "obsidian", "Cloud mode does not support active Obsidian filesystem integration."));
    } else if (obsidianFlag === false && hasValue(env, "OBSIDIAN_VAULT_PATH")) {
      checks.push(result("warn", "obsidian", "Obsidian is disabled; the configured vault path will not be used in cloud mode."));
    } else {
      checks.push(result("ready", "obsidian", "Obsidian filesystem integration is disabled for cloud mode."));
    }

    const desktopNotification = parseBoolean(env.SCHEDULER_DESKTOP_NOTIFICATION_ENABLED);
    if (desktopNotification === null) {
      checks.push(result("error", "desktop_notification", "SCHEDULER_DESKTOP_NOTIFICATION_ENABLED must be true or false."));
    } else if (desktopNotification === true) {
      checks.push(result("error", "desktop_notification", "Cloud mode does not support Windows desktop notifications."));
    } else {
      checks.push(result("ready", "desktop_notification", "Windows desktop notifications are disabled for cloud mode."));
    }

  }

  return { mode, checks };
}

export function runCheckEnv({
  environment = process.env,
  logger = console.log,
  errorLogger = console.error
} = {}) {
  const report = inspectRuntimeEnvironment(environment);
  const errors = report.checks.filter((item) => item.level === "error");

  if (errors.length > 0) {
    errorLogger("[env] Environment validation failed:");
    for (const item of errors) errorLogger(`- ${item.message}`);
    errorLogger("Review .env.example and provide the required mode-specific values.");
    return { ...report, exitCode: 1 };
  }

  logger(`[env] Environment is valid for ${report.mode} mode.`);
  return { ...report, exitCode: 0 };
}

function isMainModule() {
  return process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}

if (isMainModule()) {
  dotenv.config();
  const result = runCheckEnv();
  process.exitCode = result.exitCode;
}
