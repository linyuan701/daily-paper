import assert from "node:assert/strict";
import test from "node:test";

import { inspectRuntimeEnvironment, resolveDeploymentMode, runCheckEnv } from "./check-env.mjs";

const validCloudEnv = {
  DEPLOYMENT_MODE: "cloud",
  DATABASE_URL: "postgresql://placeholder:placeholder@example.invalid/daily_paper",
  ZOTERO_TRANSPORT: "web",
  ZOTERO_KEY: "placeholder-key",
  ZOTERO_ID: "placeholder-id",
  OBSIDIAN_ENABLED: "false"
};

const nvidiaCloudEnv = {
  ...validCloudEnv,
  LLM_PROVIDER: "nvidia",
  LLM_API_KEY: "placeholder-llm-key",
  LLM_BASE_URL: "https://integrate.api.nvidia.com/v1",
  LLM_MODEL: "deepseek-ai/deepseek-v4-flash"
};

const deepseekCloudEnv = {
  ...validCloudEnv,
  LLM_PROVIDER: "deepseek",
  LLM_API_KEY: "placeholder-llm-key",
  LLM_BASE_URL: "https://api.deepseek.com",
  LLM_MODEL: "deepseek-v4-flash"
};

test("deployment mode defaults to local and rejects unsupported values", () => {
  assert.deepEqual(resolveDeploymentMode({}), { mode: "local" });
  assert.equal(resolveDeploymentMode({ DEPLOYMENT_MODE: "LOCAL" }).mode, "local");
  assert.equal(resolveDeploymentMode({ DEPLOYMENT_MODE: "server" }).mode, null);
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

test("local mode keeps NVIDIA generation optional when only the key is absent", () => {
  const report = inspectRuntimeEnvironment({
    DATABASE_URL: "file:./dev.db",
    LLM_PROVIDER: "nvidia",
    LLM_BASE_URL: "https://integrate.api.nvidia.com/v1",
    LLM_MODEL: "deepseek-ai/deepseek-v4-flash"
  });

  assert.equal(report.checks.some((item) => item.level === "error"), false);
  assert.ok(report.checks.some((item) => item.level === "warn" && item.code === "llm_api_key"));
});

test("cloud preflight accepts NVIDIA defaults but requires the runtime key name", () => {
  const defaults = inspectRuntimeEnvironment({
    ...validCloudEnv,
    LLM_PROVIDER: "nvidia",
    LLM_API_KEY: "placeholder-llm-key"
  });
  assert.equal(defaults.checks.some((item) => item.level === "error"), false);
  assert.ok(defaults.checks.some((item) => item.level === "ready" && item.code === "llm"));

  const missingKey = inspectRuntimeEnvironment({
    ...nvidiaCloudEnv,
    LLM_API_KEY: ""
  });
  const errors = missingKey.checks.filter((item) => item.level === "error" && item.code === "llm_api_key");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /LLM_API_KEY/);
  assert.doesNotMatch(errors[0].message, /NVIDIA_API_KEY|placeholder-llm-key/);
});

test("cloud preflight accepts DeepSeek official defaults and requires the runtime key name", () => {
  const defaults = inspectRuntimeEnvironment({
    ...validCloudEnv,
    LLM_PROVIDER: "deepseek",
    LLM_API_KEY: "placeholder-llm-key"
  });
  assert.equal(defaults.checks.some((item) => item.level === "error"), false);
  assert.ok(defaults.checks.some((item) => item.level === "ready" && item.code === "llm"));

  const missingKey = inspectRuntimeEnvironment({
    ...deepseekCloudEnv,
    LLM_API_KEY: ""
  });
  const errors = missingKey.checks.filter((item) => item.level === "error" && item.code === "llm_api_key");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /LLM_API_KEY/);
  assert.doesNotMatch(errors[0].message, /DEEPSEEK_API_KEY|placeholder-llm-key/);
});

test("cloud preflight rejects DeepSeek provider endpoint/model overrides", () => {
  const report = inspectRuntimeEnvironment({
    ...deepseekCloudEnv,
    LLM_BASE_URL: "https://example.invalid/v1",
    LLM_MODEL: "deepseek-ai/deepseek-v4-flash"
  });

  assert.ok(report.checks.some((item) => item.level === "error" && item.code === "llm_base_url"));
  assert.ok(report.checks.some((item) => item.level === "error" && item.code === "llm_model"));
});

test("cloud preflight preserves provider-absent legacy OpenAI-compatible configuration", () => {
  const report = inspectRuntimeEnvironment({
    ...validCloudEnv,
    LLM_API_KEY: "placeholder-legacy-key",
    LLM_API_BASE_URL: "https://legacy-provider.example.invalid/v1",
    LLM_MODEL: "legacy-provider/model"
  });

  assert.equal(report.checks.some((item) => item.level === "error"), false);
  assert.ok(report.checks.some((item) => item.level === "ready" && item.code === "llm"));
});

test("cloud preflight normalizes NVIDIA slashes and gives the canonical name precedence", () => {
  const accepted = inspectRuntimeEnvironment({
    ...nvidiaCloudEnv,
    LLM_BASE_URL: "https://integrate.api.nvidia.com/v1///",
    LLM_API_BASE_URL: "https://legacy.example.invalid/v1"
  });
  assert.equal(accepted.checks.some((item) => item.level === "error"), false);

  const rejected = inspectRuntimeEnvironment({
    ...nvidiaCloudEnv,
    LLM_BASE_URL: "https://canonical-wrong.example.invalid/v1",
    LLM_API_BASE_URL: "https://integrate.api.nvidia.com/v1"
  });
  assert.ok(rejected.checks.some((item) => item.level === "error" && item.code === "llm_base_url"));
});

test("cloud preflight rejects wrong NVIDIA model/base without printing configured values", () => {
  const output = [];
  const secret = "do-not-print-provider-secret";
  const privateBase = "https://private-provider.example.invalid/v1";
  const result = runCheckEnv({
    environment: {
      ...nvidiaCloudEnv,
      LLM_API_KEY: secret,
      LLM_BASE_URL: privateBase,
      LLM_MODEL: "deepseek-v4-flash"
    },
    logger: (line) => output.push(line),
    errorLogger: (line) => output.push(line)
  });

  assert.equal(result.exitCode, 1);
  assert.ok(result.checks.some((item) => item.code === "llm_base_url"));
  assert.ok(result.checks.some((item) => item.code === "llm_model"));
  assert.equal(output.join("\n").includes(secret), false);
  assert.equal(output.join("\n").includes(privateBase), false);
});

test("preflight rejects unsafe canonical and legacy base URLs without echoing credentials", () => {
  for (const key of ["LLM_BASE_URL", "LLM_API_BASE_URL"]) {
    const output = [];
    const unsafeUrl = "https://user:private-password@example.invalid/v1?token=private-token#fragment";
    const result = runCheckEnv({
      environment: {
        ...validCloudEnv,
        LLM_PROVIDER: "openai-compatible",
        LLM_API_KEY: "placeholder-key",
        [key]: unsafeUrl
      },
      logger: (line) => output.push(line),
      errorLogger: (line) => output.push(line)
    });

    assert.equal(result.exitCode, 1);
    assert.ok(result.checks.some((item) => item.code === "llm_base_url"));
    assert.equal(output.join("\n").includes(unsafeUrl), false);
    assert.equal(output.join("\n").includes("private-password"), false);
    assert.equal(output.join("\n").includes("private-token"), false);
  }
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
