import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DEEPSEEK_BASE_URL,
  DEEPSEEK_MODEL,
  resolveSmokeConfig,
  runDeepSeekSmoke
} from "./deepseek-llm-smoke.mjs";

const configuredEnvironment = {
  DEEPSEEK_API_KEY: "test-secret",
  LLM_BASE_URL: `${DEEPSEEK_BASE_URL}/`,
  LLM_MODEL: DEEPSEEK_MODEL
};

const workflow = await readFile(
  new URL("../.github/workflows/deepseek-llm-smoke.yml", import.meta.url),
  "utf8"
);

test("DeepSeek smoke config validates exact official settings", () => {
  assert.deepEqual(resolveSmokeConfig(configuredEnvironment), {
    apiKey: "test-secret",
    baseUrl: DEEPSEEK_BASE_URL,
    model: DEEPSEEK_MODEL
  });
  assert.throws(() => resolveSmokeConfig({ ...configuredEnvironment, DEEPSEEK_API_KEY: "" }), /DEEPSEEK_API_KEY/);
  assert.throws(() => resolveSmokeConfig({ ...configuredEnvironment, LLM_BASE_URL: "https://example.test" }), /LLM_BASE_URL/);
  assert.throws(() => resolveSmokeConfig({ ...configuredEnvironment, LLM_MODEL: "deepseek-ai\/deepseek-v4-flash" }), /LLM_MODEL/);
});

test("DeepSeek smoke sends one bounded structured request and ignores reasoning", async () => {
  const calls = [];
  const logs = [];
  const result = await runDeepSeekSmoke({
    environment: configuredEnvironment,
    fetchImpl: async (...args) => {
      calls.push(args);
      return new Response(JSON.stringify({
        choices: [{
          message: {
            reasoning: "ignored",
            reasoning_content: "ignored too",
            content: '{"status":"ok"}'
          }
        }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
    logger: (line) => logs.push(line),
    now: (() => {
      const values = [100, 125];
      return () => values.shift();
    })()
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], `${DEEPSEEK_BASE_URL}/chat/completions`);
  const request = JSON.parse(calls[0][1].body);
  assert.equal(request.model, DEEPSEEK_MODEL);
  assert.equal(request.stream, false);
  assert.deepEqual(request.response_format, { type: "json_object" });
  assert.deepEqual(request.thinking, { type: "disabled" });
  assert.equal(request.chat_template_kwargs, undefined);
  assert.deepEqual(result, {
    model: DEEPSEEK_MODEL,
    httpClassification: "success",
    elapsedMs: 25,
    jsonValid: true
  });
  assert.equal(logs[0].includes("test-secret"), false);
});

test("DeepSeek smoke rejects malformed and schema-invalid JSON", async () => {
  for (const content of ["not-json", '{"status":"wrong"}', '{"status":"ok","extra":true}']) {
    await assert.rejects(runDeepSeekSmoke({
      environment: configuredEnvironment,
      fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 }),
      logger: () => undefined
    }), /DeepSeek smoke failed/);
  }
});

test("DeepSeek smoke safely classifies HTTP failures", async () => {
  for (const [status, classification] of [[401, "authentication_failed"], [402, "insufficient_balance"], [429, "rate_limited"], [500, "server_error"]]) {
    const logs = [];
    await assert.rejects(runDeepSeekSmoke({
      environment: configuredEnvironment,
      fetchImpl: async () => new Response("private body", { status }),
      logger: (line) => logs.push(JSON.parse(line))
    }), /DeepSeek smoke failed/);
    assert.equal(logs[0].httpClassification, classification);
    assert.equal(JSON.stringify(logs).includes("private body"), false);
  }
});

test("DeepSeek smoke classifies timeout and network errors without leaking details", async () => {
  const networkLogs = [];
  await assert.rejects(runDeepSeekSmoke({
    environment: configuredEnvironment,
    fetchImpl: async () => { throw new Error("private network detail"); },
    logger: (line) => networkLogs.push(JSON.parse(line))
  }), /DeepSeek smoke failed/);
  assert.equal(networkLogs[0].httpClassification, "network_error");

  const timeoutLogs = [];
  await assert.rejects(runDeepSeekSmoke({
    environment: configuredEnvironment,
    fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }),
    logger: (line) => timeoutLogs.push(JSON.parse(line)),
    timeoutMs: 1
  }), /DeepSeek smoke failed/);
  assert.equal(timeoutLogs[0].httpClassification, "timeout");
});

test("DeepSeek smoke workflow is manual-only, isolated, and scopes its secret", () => {
  assert.match(workflow, /on:\s*\n\s*workflow_dispatch:/);
  assert.doesNotMatch(workflow, /schedule:|pull_request:|push:/);
  assert.match(workflow, /permissions:\s*\n\s*contents: read/);
  assert.match(workflow, /environment: production/);
  assert.match(workflow, /timeout-minutes: 5/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /DEEPSEEK_API_KEY: \$\{\{ secrets\.DEEPSEEK_API_KEY \}\}/);
  const stepsIndex = workflow.indexOf("    steps:");
  assert.doesNotMatch(workflow.slice(0, stepsIndex), /DEEPSEEK_API_KEY/);
  for (const forbidden of [
    "DATABASE_URL",
    "prisma",
    "job:daily",
    "run-daily-cloud",
    "ingestion",
    "normalization",
    "rerank",
    "notification"
  ]) {
    assert.doesNotMatch(workflow, new RegExp(forbidden, "i"));
  }
});
