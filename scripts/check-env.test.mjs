import assert from "node:assert/strict";
import test from "node:test";

import { inspectRuntimeEnvironment, parseRecommendationLimit, resolveDeploymentMode, runCheckEnv } from "./check-env.mjs";

const validCloudEnv = {
  DEPLOYMENT_MODE: "cloud",
  DATABASE_URL: "postgresql://placeholder:placeholder@example.invalid/daily_paper",
  ZOTERO_TRANSPORT: "web",
  ZOTERO_KEY: "placeholder-key",
  ZOTERO_ID: "placeholder-id",
  OBSIDIAN_ENABLED: "false"
};

test("deployment mode defaults to local and rejects unsupported values", () => {
  assert.deepEqual(resolveDeploymentMode({}), { mode: "local" });
  assert.equal(resolveDeploymentMode({ DEPLOYMENT_MODE: "LOCAL" }).mode, "local");
  assert.equal(resolveDeploymentMode({ DEPLOYMENT_MODE: "server" }).mode, null);
});

test("daily recommendation limit is strict and bounded in preflight", () => {
  assert.equal(parseRecommendationLimit(undefined), 20);
  for (const value of ["1", "20", "30"]) assert.equal(parseRecommendationLimit(value), Number(value));
  for (const value of ["0", "31", "1.5", "paper"]) assert.equal(parseRecommendationLimit(value), null);

  for (const value of ["0", "31", "1.5", "paper"]) {
    const report = inspectRuntimeEnvironment({ DATABASE_URL: "file:./dev.db", DAILY_RECOMMENDATION_LIMIT: value });
    assert.ok(report.checks.some((item) => item.level === "error" && item.code === "daily_recommendation_limit"));
  }
});

test("local environment requires SQLite and remains ready without Zotero web credentials", () => {
  const report = inspectRuntimeEnvironment({ DATABASE_URL: "file:./dev.db" });
  assert.equal(report.mode, "local");
  assert.equal(report.checks.some((item) => item.level === "error"), false);

  const invalid = inspectRuntimeEnvironment({ DATABASE_URL: "postgresql://example.invalid/db" });
  assert.ok(invalid.checks.some((item) => item.level === "error" && item.code === "database_url"));

  const incompleteWeb = inspectRuntimeEnvironment({
    DATABASE_URL: "file:./dev.db",
    ZOTERO_TRANSPORT: "web"
  });
  assert.ok(incompleteWeb.checks.some((item) => item.level === "error" && item.code === "zotero_web"));
});

test("cloud preflight enforces PostgreSQL, Zotero web, and local capability gates", () => {
  const valid = inspectRuntimeEnvironment(validCloudEnv, { blockUnimplementedCloud: false });
  assert.equal(valid.checks.some((item) => item.level === "error"), false);

  const malformedUrl = inspectRuntimeEnvironment({
    ...validCloudEnv,
    DATABASE_URL: "postgresql:not-a-connection-url"
  }, { blockUnimplementedCloud: false });
  assert.ok(malformedUrl.checks.some((item) => item.level === "error" && item.code === "database_url"));

  const invalid = inspectRuntimeEnvironment({
    ...validCloudEnv,
    DATABASE_URL: "file:./dev.db",
    ZOTERO_TRANSPORT: "auto",
    ZOTERO_KEY: "",
    OBSIDIAN_ENABLED: "true",
    SCHEDULER_DESKTOP_NOTIFICATION_ENABLED: "true"
  }, { blockUnimplementedCloud: false });

  for (const code of ["database_url", "zotero_transport", "zotero_web", "obsidian", "desktop_notification"]) {
    assert.ok(invalid.checks.some((item) => item.level === "error" && item.code === code), code);
  }
});

test("cloud missing local-only flags is disabled while a disabled Obsidian path only warns", () => {
  const missingFlags = inspectRuntimeEnvironment(validCloudEnv);
  assert.ok(missingFlags.checks.some((item) => item.level === "ready" && item.code === "desktop_notification"));

  const residualPath = inspectRuntimeEnvironment({
    ...validCloudEnv,
    OBSIDIAN_VAULT_PATH: "C:\\placeholder\\vault"
  });
  assert.ok(residualPath.checks.some((item) => item.level === "warn" && item.code === "obsidian"));
  assert.equal(residualPath.checks.some((item) => item.level === "error" && item.code === "obsidian"), false);
});

test("runtime check accepts the implemented PostgreSQL contract and never prints values", () => {
  const output = [];
  const result = runCheckEnv({
    environment: validCloudEnv,
    logger: (line) => output.push(line),
    errorLogger: (line) => output.push(line)
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.checks.some((item) => item.code === "cloud_schema"), false);
  assert.equal(output.join("\n").includes(validCloudEnv.DATABASE_URL), false);
  assert.equal(output.join("\n").includes(validCloudEnv.ZOTERO_KEY), false);
});
