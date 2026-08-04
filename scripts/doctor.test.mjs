import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { inspectProject, runDoctor } from "./doctor.mjs";

const validEnv = `
DATABASE_URL="file:./dev.db"
ZOTERO_TRANSPORT="auto"
ZOTERO_KEY=""
ZOTERO_ID=""
LLM_PROVIDER="nvidia"
LLM_API_KEY=""
LLM_BASE_URL="https://integrate.api.nvidia.com/v1"
LLM_API_BASE_URL=""
LLM_MODEL="deepseek-ai/deepseek-v4-flash"
EMBEDDING_API_KEY=""
EMBEDDING_API_BASE_URL=""
EMBEDDING_MODEL=""
OBSIDIAN_ENABLED="false"
OBSIDIAN_VAULT_PATH=""
NOTIFICATION_SMTP_HOST=""
NOTIFICATION_SMTP_PORT="465"
NOTIFICATION_SMTP_SECURE="true"
NOTIFICATION_SMTP_USER=""
NOTIFICATION_SMTP_PASS=""
NOTIFICATION_EMAIL_FROM=""
NOTIFICATION_EMAIL_TO=""
OPERATIONS_GITHUB_OWNER=""
OPERATIONS_GITHUB_REPO=""
OPERATIONS_GITHUB_TOKEN=""
OPERATIONS_GITHUB_REF=""
SCHEDULER_DAILY_UTC_HOUR="0"
SCHEDULER_MONTHLY_UTC_DAY="1"
SCHEDULER_MONTHLY_UTC_HOUR="7"
SCHEDULER_POLL_MS="60000"
SCHEDULER_RETRY_MS="900000"
OBSIDIAN_FEEDBACK_SYNC_MS="300000"
`;

async function withTempProject(envText, run) {
  const projectDir = await mkdtemp(join(tmpdir(), "daily-paper-doctor-"));
  try {
    if (envText !== null) {
      await writeFile(join(projectDir, ".env"), envText, "utf8");
    }
    await run(projectDir);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

test("doctor accepts the minimal Windows SQLite configuration", async () => {
  await withTempProject(validEnv, async (projectDir) => {
    const report = await inspectProject({ projectDir, platform: "win32", nodeVersion: "v22.18.0", environment: {} });

    assert.equal(report.summary.error, 0);
    assert.ok(report.summary.ready > 0);
    assert.ok(report.summary.warn > 0);
  });
});

test("doctor reports unsupported platform, Node, missing env, and invalid database", async () => {
  await withTempProject(null, async (projectDir) => {
    const report = await inspectProject({ projectDir, platform: "linux", nodeVersion: "v25.0.0", environment: {} });
    assert.ok(report.summary.error >= 3);
  });

  await withTempProject(validEnv.replace('DATABASE_URL="file:./dev.db"', 'DATABASE_URL="postgresql://example.invalid/db"'), async (projectDir) => {
    const report = await inspectProject({ projectDir, platform: "win32", nodeVersion: "v22.18.0", environment: {} });
    assert.ok(report.checks.some((check) => check.level === "error" && check.code === "database_url"));
  });

  await withTempProject(validEnv.replace('DATABASE_URL="file:./dev.db"', 'DATABASE_URL="file:./prisma/dev.db"'), async (projectDir) => {
    const report = await inspectProject({ projectDir, platform: "win32", nodeVersion: "v22.18.0", environment: {} });
    assert.ok(report.checks.some((check) => check.level === "error" && check.code === "database_url"));
  });
});

test("doctor validates paired providers, enabled Obsidian, SMTP, and schedule ranges", async () => {
  const invalidEnv = validEnv
    .replace('ZOTERO_TRANSPORT="auto"', 'ZOTERO_TRANSPORT="web"')
    .replace('ZOTERO_KEY=""', 'ZOTERO_KEY="private-value"')
    .replace('LLM_PROVIDER="nvidia"', 'LLM_PROVIDER="openai-compatible"')
    .replace('LLM_API_KEY=""', 'LLM_API_KEY="private-value"')
    .replace('LLM_BASE_URL="https://integrate.api.nvidia.com/v1"', 'LLM_BASE_URL=""')
    .replace('EMBEDDING_MODEL=""', 'EMBEDDING_MODEL="model-only"')
    .replace('OBSIDIAN_ENABLED="false"', 'OBSIDIAN_ENABLED="true"')
    .replace('NOTIFICATION_SMTP_HOST=""', 'NOTIFICATION_SMTP_HOST="smtp.example.test"')
    .replace('SCHEDULER_DAILY_UTC_HOUR="0"', 'SCHEDULER_DAILY_UTC_HOUR="24"');

  await withTempProject(invalidEnv, async (projectDir) => {
    const report = await inspectProject({ projectDir, platform: "win32", nodeVersion: "v22.18.0", environment: {} });
    for (const code of ["zotero_web", "llm", "embedding", "obsidian", "smtp", "scheduler_daily_hour"]) {
      assert.ok(report.checks.some((check) => check.level === "error" && check.code === code), code);
    }
  });
});

test("doctor validates Operations dispatch as an optional complete secret set", async () => {
  const incomplete = validEnv.replace(
    'OPERATIONS_GITHUB_OWNER=""',
    'OPERATIONS_GITHUB_OWNER="example-owner"'
  );
  await withTempProject(incomplete, async (projectDir) => {
    const report = await inspectProject({ projectDir, platform: "win32", nodeVersion: "v22.18.0", environment: {} });
    assert.ok(report.checks.some((item) => item.level === "error" && item.code === "operations_dispatch"));
  });

  const complete = validEnv
    .replace('OPERATIONS_GITHUB_OWNER=""', 'OPERATIONS_GITHUB_OWNER="example-owner"')
    .replace('OPERATIONS_GITHUB_REPO=""', 'OPERATIONS_GITHUB_REPO="daily-paper"')
    .replace('OPERATIONS_GITHUB_TOKEN=""', 'OPERATIONS_GITHUB_TOKEN="do-not-print-operations-token"')
    .replace('OPERATIONS_GITHUB_REF=""', 'OPERATIONS_GITHUB_REF="master"');
  await withTempProject(complete, async (projectDir) => {
    const lines = [];
    const result = await runDoctor({
      projectDir,
      platform: "win32",
      nodeVersion: "v22.18.0",
      environment: {},
      logger: (line) => lines.push(line)
    });
    assert.equal(result.exitCode, 0);
    assert.ok(result.checks.some((item) => item.level === "ready" && item.code === "operations_dispatch"));
    assert.equal(lines.join("\n").includes("do-not-print-operations-token"), false);
  });
});

test("doctor output contains status counts but never secret values", async () => {
  const configured = validEnv
    .replace('LLM_API_KEY=""', 'LLM_API_KEY="do-not-print-this"')
    .replace(
      'LLM_BASE_URL="https://integrate.api.nvidia.com/v1"',
      'LLM_BASE_URL="https://integrate.api.nvidia.com/v1///"'
    );

  await withTempProject(configured, async (projectDir) => {
    const lines = [];
    const result = await runDoctor({
      projectDir,
      platform: "win32",
      nodeVersion: "v22.18.0",
      environment: {},
      logger: (line) => lines.push(line)
    });

    const output = lines.join("\n");
    assert.equal(result.exitCode, 0);
    assert.match(output, /Summary: ready=\d+ warn=\d+ error=0/);
    assert.equal(output.includes("do-not-print-this"), false);
    assert.equal(output.includes("https://integrate.api.nvidia.com/v1"), false);
  });
});

test("doctor accepts embedding credentials inherited from the LLM provider", async () => {
  const configured = validEnv
    .replace('LLM_PROVIDER="nvidia"', 'LLM_PROVIDER="openai-compatible"')
    .replace('LLM_API_KEY=""', 'LLM_API_KEY="shared-key"')
    .replace('LLM_BASE_URL="https://integrate.api.nvidia.com/v1"', 'LLM_BASE_URL="https://example.test/v1"')
    .replace('LLM_MODEL="deepseek-ai/deepseek-v4-flash"', 'LLM_MODEL="generic-model"')
    .replace('LLM_API_BASE_URL=""', 'LLM_API_BASE_URL="https://example.test/v1"')
    .replace('EMBEDDING_MODEL=""', 'EMBEDDING_MODEL="embedding-model"');

  await withTempProject(configured, async (projectDir) => {
    const report = await inspectProject({ projectDir, platform: "win32", nodeVersion: "v22.18.0", environment: {} });
    assert.ok(report.checks.some((check) => check.level === "ready" && check.code === "embedding"));
    assert.equal(report.summary.error, 0);
  });
});

test("doctor treats a valid NVIDIA provider without a key as optional", async () => {
  await withTempProject(validEnv, async (projectDir) => {
    const report = await inspectProject({ projectDir, platform: "win32", nodeVersion: "v22.18.0", environment: {} });
    assert.ok(report.checks.some((item) => item.level === "warn" && item.code === "llm"));
    assert.equal(report.checks.some((item) => item.level === "error" && item.code === "llm"), false);
  });
});

test("doctor accepts a complete NVIDIA configuration and normalizes trailing slashes", async () => {
  const configured = validEnv
    .replace('LLM_API_KEY=""', 'LLM_API_KEY="placeholder-key"')
    .replace(
      'LLM_BASE_URL="https://integrate.api.nvidia.com/v1"',
      'LLM_BASE_URL="https://integrate.api.nvidia.com/v1///"'
    );

  await withTempProject(configured, async (projectDir) => {
    const report = await inspectProject({ projectDir, platform: "win32", nodeVersion: "v22.18.0", environment: {} });
    assert.ok(report.checks.some((item) => item.level === "ready" && item.code === "llm"));
    assert.equal(report.summary.error, 0);
  });
});

test("doctor does not inherit DeepSeek credentials into embeddings", async () => {
  const configured = validEnv
    .replace('LLM_PROVIDER="nvidia"', 'LLM_PROVIDER="deepseek"')
    .replace('LLM_API_KEY=""', 'LLM_API_KEY="deepseek-only-key"')
    .replace('LLM_BASE_URL="https://integrate.api.nvidia.com/v1"', 'LLM_BASE_URL="https://api.deepseek.com"')
    .replace('LLM_MODEL="deepseek-ai/deepseek-v4-flash"', 'LLM_MODEL="deepseek-v4-flash"')
    .replace('EMBEDDING_MODEL=""', 'EMBEDDING_MODEL="embedding-model"');

  await withTempProject(configured, async (projectDir) => {
    const report = await inspectProject({ projectDir, platform: "win32", nodeVersion: "v22.18.0", environment: {} });
    assert.ok(report.checks.some((check) => check.level === "error" && check.code === "embedding"));
  });
});

test("doctor accepts a complete DeepSeek official configuration and normalizes trailing slashes", async () => {
  const configured = validEnv
    .replace('LLM_PROVIDER="nvidia"', 'LLM_PROVIDER="deepseek"')
    .replace('LLM_API_KEY=""', 'LLM_API_KEY="placeholder-key"')
    .replace(
      'LLM_BASE_URL="https://integrate.api.nvidia.com/v1"',
      'LLM_BASE_URL="https://api.deepseek.com///"'
    )
    .replace('LLM_MODEL="deepseek-ai/deepseek-v4-flash"', 'LLM_MODEL="deepseek-v4-flash"');

  await withTempProject(configured, async (projectDir) => {
    const report = await inspectProject({ projectDir, platform: "win32", nodeVersion: "v22.18.0", environment: {} });
    assert.ok(report.checks.some((item) => item.level === "ready" && item.code === "llm"));
    assert.equal(report.summary.error, 0);
  });
});

test("doctor rejects DeepSeek endpoint/model overrides without exposing secrets", async () => {
  const configured = validEnv
    .replace('LLM_PROVIDER="nvidia"', 'LLM_PROVIDER="deepseek"')
    .replace('LLM_API_KEY=""', 'LLM_API_KEY="do-not-print-deepseek-key"')
    .replace('LLM_BASE_URL="https://integrate.api.nvidia.com/v1"', 'LLM_BASE_URL="https://wrong.example.invalid/v1"');

  await withTempProject(configured, async (projectDir) => {
    const lines = [];
    const result = await runDoctor({
      projectDir,
      platform: "win32",
      nodeVersion: "v22.18.0",
      environment: {},
      logger: (line) => lines.push(line)
    });
    assert.equal(result.exitCode, 1);
    assert.ok(result.checks.some((item) => item.level === "error" && item.code === "llm"));
    assert.equal(lines.join("\n").includes("do-not-print-deepseek-key"), false);
  });
});

test("doctor rejects the wrong NVIDIA endpoint and shorthand model without exposing secrets", async () => {
  const configured = validEnv
    .replace('LLM_API_KEY=""', 'LLM_API_KEY="do-not-print-nvidia-key"')
    .replace('LLM_BASE_URL="https://integrate.api.nvidia.com/v1"', 'LLM_BASE_URL="https://wrong.example.invalid/v1"')
    .replace('LLM_MODEL="deepseek-ai/deepseek-v4-flash"', 'LLM_MODEL="deepseek-v4-flash"');

  await withTempProject(configured, async (projectDir) => {
    const lines = [];
    const result = await runDoctor({
      projectDir,
      platform: "win32",
      nodeVersion: "v22.18.0",
      environment: {},
      logger: (line) => lines.push(line)
    });
    assert.equal(result.exitCode, 1);
    assert.ok(result.checks.some((item) => item.level === "error" && item.code === "llm"));
    assert.equal(lines.join("\n").includes("do-not-print-nvidia-key"), false);
  });
});

test("doctor gives environment and canonical names precedence", async () => {
  const configured = validEnv.replace(
    'LLM_API_BASE_URL=""',
    'LLM_API_BASE_URL="https://legacy.example.invalid/v1"'
  );

  await withTempProject(configured, async (projectDir) => {
    const accepted = await inspectProject({
      projectDir,
      platform: "win32",
      nodeVersion: "v22.18.0",
      environment: { LLM_API_KEY: "injected-key" }
    });
    assert.ok(accepted.checks.some((item) => item.level === "ready" && item.code === "llm"));

    const rejected = await inspectProject({
      projectDir,
      platform: "win32",
      nodeVersion: "v22.18.0",
      environment: { LLM_BASE_URL: "https://environment.example.invalid/v1" }
    });
    assert.ok(rejected.checks.some((item) => item.level === "error" && item.code === "llm"));
  });
});

test("doctor rejects credential-bearing LLM URLs without printing them", async () => {
  const unsafeUrl = "https://user:private-password@example.invalid/v1?token=private-token#fragment";
  const configured = validEnv
    .replace('LLM_PROVIDER="nvidia"', 'LLM_PROVIDER="openai-compatible"')
    .replace('LLM_API_KEY=""', 'LLM_API_KEY="placeholder-key"')
    .replace('LLM_BASE_URL="https://integrate.api.nvidia.com/v1"', `LLM_BASE_URL="${unsafeUrl}"`);

  await withTempProject(configured, async (projectDir) => {
    const lines = [];
    const result = await runDoctor({
      projectDir,
      platform: "win32",
      nodeVersion: "v22.18.0",
      environment: {},
      logger: (line) => lines.push(line)
    });
    const output = lines.join("\n");
    assert.equal(result.exitCode, 1);
    assert.equal(output.includes(unsafeUrl), false);
    assert.equal(output.includes("private-password"), false);
    assert.equal(output.includes("private-token"), false);
  });
});

test("cloud doctor accepts Linux preflight inputs with the PostgreSQL contract", async () => {
  const cloudEnv = `
DEPLOYMENT_MODE="cloud"
DATABASE_URL="postgresql://placeholder:placeholder@example.invalid/daily_paper"
ZOTERO_TRANSPORT="web"
ZOTERO_KEY="placeholder-key"
ZOTERO_ID="placeholder-id"
OBSIDIAN_ENABLED="false"
SCHEDULER_DESKTOP_NOTIFICATION_ENABLED="false"
SCHEDULER_DAILY_UTC_HOUR="not-used-in-cloud"
`;

  await withTempProject(cloudEnv, async (projectDir) => {
    const report = await inspectProject({ projectDir, platform: "linux", nodeVersion: "v22.18.0", environment: {} });
    const errors = report.checks.filter((item) => item.level === "error");

    assert.deepEqual(errors, []);
    assert.ok(report.checks.some((item) => item.level === "ready" && item.code === "platform"));
    assert.ok(report.checks.some((item) => item.level === "ready" && item.code === "scheduler_loop"));
  });
});

test("cloud doctor rejects active Windows-only capabilities using effective settings", async () => {
  const cloudEnv = `
DEPLOYMENT_MODE="cloud"
DATABASE_URL="postgres://placeholder:placeholder@example.invalid/daily_paper"
ZOTERO_TRANSPORT="web"
ZOTERO_KEY="placeholder-key"
ZOTERO_ID="placeholder-id"
OBSIDIAN_VAULT_PATH="C:\\placeholder\\vault"
SCHEDULER_OBSIDIAN_PUSH_ENABLED="true"
SCHEDULER_DESKTOP_NOTIFICATION_ENABLED="true"
`;

  await withTempProject(cloudEnv, async (projectDir) => {
    const report = await inspectProject({ projectDir, platform: "linux", nodeVersion: "v22.18.0", environment: {} });
    for (const code of ["obsidian", "desktop_notification"]) {
      assert.ok(report.checks.some((item) => item.level === "error" && item.code === code), code);
    }
    assert.equal(report.checks.some((item) => item.code === "cloud_schema"), false);
  });
});
