import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";

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

export function parseRecommendationLimit(value) {
  const normalized = value?.trim();
  if (!normalized) return 20;
  if (!/^\d+$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 30 ? parsed : null;
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

export function inspectRuntimeEnvironment(env) {
  const checks = [];
  const deployment = resolveDeploymentMode(env);
  if (!deployment.mode) {
    checks.push(result("error", "deployment_mode", deployment.error));
    return { mode: null, checks };
  }

  const { mode } = deployment;
  checks.push(result("ready", "deployment_mode", `Deployment mode is ${mode}.`));

  const recommendationLimit = parseRecommendationLimit(env.DAILY_RECOMMENDATION_LIMIT);
  checks.push(recommendationLimit === null
    ? result("error", "daily_recommendation_limit", "DAILY_RECOMMENDATION_LIMIT must be an integer between 1 and 30.")
    : result("ready", "daily_recommendation_limit", `Daily recommendation selection limit is ${recommendationLimit}.`));

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
