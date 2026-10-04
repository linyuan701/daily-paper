import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { checkDatabaseHealth, isApprovedInvocation } from "./production-db-health.mjs";

const fixtureUrl = "postgresql://fixture:DO_NOT_LOG_THIS@database.invalid/fixture";
const approvedEnv = {
  GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "linyuan701/daily-paper", GITHUB_REF: "refs/heads/master",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_WORKFLOW_REF: "linyuan701/daily-paper/.github/workflows/production-db-health.yml@refs/heads/master"
};
function fixture({ executeError, queryError, rows = [{ ok: 1 }], disconnectError } = {}) {
  const calls = [];
  return {
    calls,
    client: {
      async $transaction(callback, limits) {
        calls.push(["transaction", limits]);
        return callback({
          async $executeRawUnsafe(sql) { calls.push(["execute", sql]); if (executeError) throw executeError; },
          async $queryRawUnsafe(sql) { calls.push(["query", sql]); if (queryError) throw queryError; return rows; }
        });
      },
      async $disconnect() { calls.push(["disconnect"]); if (disconnectError) throw disconnectError; }
    }
  };
}

test("production query enforces readonly and database timeout before fixed SELECT, then disconnects", async () => {
  const f = fixture();
  let configured;
  const result = await checkDatabaseHealth({ databaseUrl: fixtureUrl, createClient: async url => { configured = new URL(url); return f.client; } });
  assert.equal(result.status, "ready");
  assert.deepEqual(f.calls, [
    ["transaction", { maxWait: 2000, timeout: 5000 }],
    ["execute", "SET TRANSACTION READ ONLY"], ["execute", "SET LOCAL statement_timeout = 5000"],
    ["query", "SELECT 1 AS ok"], ["disconnect"]
  ]);
  for (const [key, value] of Object.entries({connection_limit: "1", connect_timeout: "5", pool_timeout: "5", socket_timeout: "5"})) assert.equal(configured.searchParams.get(key), value);
  assert.equal(configured.searchParams.get("sslmode"), "require");
  assert.equal(configured.searchParams.get("sslaccept"), "strict");
  assert.deepEqual(Object.keys(result).sort(), ["checkedAt", "elapsedMs", "status"]);
  assert.ok(!JSON.stringify(result).includes("DO_NOT_LOG_THIS"));
});

test("a failed readonly restriction prevents SELECT and still disconnects", async () => {
  const f = fixture({ executeError: new Error(fixtureUrl) });
  const result = await checkDatabaseHealth({ databaseUrl: fixtureUrl, createClient: async () => f.client });
  assert.equal(result.status, "failed");
  assert.ok(!f.calls.some(([kind]) => kind === "query"));
  assert.deepEqual(f.calls.at(-1), ["disconnect"]);
  assert.ok(!JSON.stringify(result).includes("DO_NOT_LOG_THIS"));
});

test("authentication/connection/TLS errors are classified without exception text or metadata", async () => {
  for (const [code, category] of [["P1000", "authentication_failed"], ["P1001", "connection_unreachable"], ["P1002", "connection_timeout"], ["P1011", "tls_failed"], ["P2028", "transaction_failed"]]) {
    const f = fixture({ queryError: Object.assign(new Error(fixtureUrl), { code, meta: { secret: fixtureUrl } }) });
    const result = await checkDatabaseHealth({ databaseUrl: fixtureUrl, createClient: async () => f.client });
    assert.equal(result.category, category);
    assert.equal(result.errorCode, code);
    assert.ok(!JSON.stringify(result).includes("DO_NOT_LOG_THIS"));
    assert.deepEqual(f.calls.at(-1), ["disconnect"]);
  }
});

test("invalid input cannot construct a client, and query rows/raw codes are not emitted", async () => {
  for (const databaseUrl of [undefined, fixtureUrl.replace("postgresql:", "file:"), "DO_NOT_LOG_THIS"]) {
    let created = false;
    const result = await checkDatabaseHealth({ databaseUrl, createClient: async () => { created = true; } });
    assert.equal(created, false);
    assert.equal(result.status, "failed");
    assert.ok(!JSON.stringify(result).includes("DO_NOT_LOG_THIS"));
  }
  for (const options of [{ rows: [{ ok: 2, secret: fixtureUrl }] }, { queryError: { code: fixtureUrl, message: fixtureUrl } }, { disconnectError: new Error(fixtureUrl) }]) {
    const f = fixture(options);
    const result = await checkDatabaseHealth({ databaseUrl: fixtureUrl, createClient: async () => f.client });
    assert.equal(result.status, "failed");
    assert.ok(!JSON.stringify(result).includes("DO_NOT_LOG_THIS"));
  }
});

test("CLI refuses non-master, automated, foreign-workflow and arbitrary-argument invocations", () => {
  assert.equal(isApprovedInvocation(approvedEnv, []), true);
  assert.equal(isApprovedInvocation(approvedEnv, ["SELECT 2"]), false);
  for (const [key, value] of [["GITHUB_ACTIONS", "false"], ["GITHUB_REF", "refs/heads/unreviewed"], ["GITHUB_EVENT_NAME", "push"], ["GITHUB_REPOSITORY", "other/repo"], ["GITHUB_WORKFLOW_REF", "other"]]) assert.equal(isApprovedInvocation({ ...approvedEnv, [key]: value }, []), false);
  const cli = spawnSync(process.execPath, [fileURLToPath(new URL('./production-db-health.mjs', import.meta.url))], {
    env: { ...process.env, ...approvedEnv, GITHUB_EVENT_NAME: "push", DATABASE_URL: fixtureUrl }, encoding: "utf8", timeout: 3000
  });
  assert.equal(cli.status, 1);
  assert.equal(JSON.parse(cli.stdout).category, "unauthorized_invocation");
  assert.ok(!`${cli.stdout}${cli.stderr}`.includes("DO_NOT_LOG_THIS"));
});

test("workflow is manual-only, master-only, bounded and injects only existing DB Secret in final step", async () => {
  const workflow = await readFile(new URL("../.github/workflows/production-db-health.yml", import.meta.url), "utf8");
  assert.match(workflow, /on:\s*\n  workflow_dispatch:\s*\n\npermissions:/);
  assert.doesNotMatch(workflow, /schedule:|push:|pull_request:|workflow_call:|inputs:|write|upload-artifact|prisma.*migrate|job:daily|job:profile|deploy|NOTIFICATION|SMTP/);
  assert.match(workflow, /permissions:\s*\n  contents: read/);
  assert.match(workflow, /if: github.ref == 'refs\/heads\/master'/);
  assert.match(workflow, /environment: production/);
  assert.match(workflow, /ref: \$\{\{ github.sha \}\}/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /npm ci --ignore-scripts --no-audit --fund=false/);
  assert.equal(workflow.match(/secrets\./g)?.length, 1);
  const finalStep = workflow.slice(workflow.indexOf("      - name: Run one bounded"));
  assert.match(finalStep, /DATABASE_URL: \$\{\{ secrets.DATABASE_URL \}\}/);
  assert.match(finalStep, /timeout --signal=TERM --kill-after=2s 20s node scripts\/production-db-health.mjs/);
  const script = await readFile(new URL("./production-db-health.mjs", import.meta.url), "utf8");
  assert.match(script, /setTimeout\([\s\S]*?15000/);
  assert.match(script, /log: \[\]/);
  const ci = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(ci, /node --test scripts\/production-db-health.test.mjs/);
  assert.match(ci, /name: Test read-only health on the disposable database[\s\S]*?TEST_POSTGRES_DATABASE_URL:/);
});

test("real disposable PostgreSQL authenticates fixed SELECT and rejects DDL inside probe's readonly transaction", { skip: !process.env.TEST_POSTGRES_DATABASE_URL }, async () => {
  const databaseUrl = process.env.TEST_POSTGRES_DATABASE_URL;
  const url = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "Only the explicit runner-local disposable test database is allowed");
  const { PrismaClient } = await import("../src/generated/prisma-postgresql/index.js");
  const createClient = async value => {
    const testUrl = new URL(value);
    // Only the explicit disposable localhost fixture lacks TLS; production always requires strict TLS.
    testUrl.searchParams.set("sslmode", "disable");
    return new PrismaClient({ datasources: { db: { url: testUrl.toString() } }, log: [] });
  };
  assert.equal((await checkDatabaseHealth({ databaseUrl, createClient })).status, "ready");
  let rejected = false;
  const result = await checkDatabaseHealth({ databaseUrl, createClient: async url => {
    const client = await createClient(url);
    return {
      $disconnect: () => client.$disconnect(),
      $transaction: (callback, limits) => client.$transaction(tx => callback({
        $executeRawUnsafe: sql => tx.$executeRawUnsafe(sql),
        $queryRawUnsafe: async sql => {
          await tx.$queryRawUnsafe(sql);
          try { await tx.$executeRawUnsafe('CREATE TABLE "__health_readonly_contract_probe" (id integer)'); }
          catch (error) { assert.equal(error.meta?.code, "25006"); rejected = true; throw new Error("Readonly write rejection confirmed"); }
          // Always roll back even if a regression incorrectly permitted the disposable DDL.
          throw new Error("Readonly restriction missing");
        }
      }), limits)
    };
  } });
  assert.equal(result.status, "failed");
  assert.equal(rejected, true);
});
