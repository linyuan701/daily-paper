import { pathToFileURL } from "node:url";

const READ_ONLY = "SET TRANSACTION READ ONLY";
const STATEMENT_TIMEOUT = "SET LOCAL statement_timeout = 5000";
const QUERY = "SELECT 1 AS ok";
const TRANSACTION_LIMITS = { maxWait: 2000, timeout: 5000 };

class ProbeInputError extends Error {
  constructor(category) {
    super("Invalid health probe input");
    this.category = category;
  }
}

function boundedDatabaseUrl(value) {
  if (!value) throw new ProbeInputError("missing_database_url");
  let url;
  try { url = new URL(value); } catch { throw new ProbeInputError("invalid_database_url"); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.pathname.length < 2) {
    throw new ProbeInputError("invalid_database_url");
  }
  for (const [name, value] of Object.entries({ connection_limit: 1, connect_timeout: 5, pool_timeout: 5, socket_timeout: 5 })) {
    url.searchParams.set(name, String(value));
  }
  url.searchParams.set("sslmode", "require");
  url.searchParams.set("sslaccept", "strict");
  return url.toString();
}

function safeFailure(error) {
  if (error instanceof ProbeInputError) return { category: error.category };
  const code = typeof error?.code === "string" && /^P[0-9]{4}$/.test(error.code) ? error.code : undefined;
  const category = ({
    P1000: "authentication_failed", P1001: "connection_unreachable", P1002: "connection_timeout",
    P1008: "query_timeout", P1011: "tls_failed", P2024: "connection_timeout", P2028: "transaction_failed"
  })[code] ?? "database_check_failed";
  return { category, ...(code ? { errorCode: code } : {}) };
}

async function createProductionClient(databaseUrl) {
  const { PrismaClient } = await import("../src/generated/prisma-postgresql/index.js");
  return new PrismaClient({ datasources: { db: { url: databaseUrl } }, log: [] });
}

// Injection is for offline/disposable tests only. The CLI supplies no configurable SQL or factory.
export async function checkDatabaseHealth({ databaseUrl, createClient = createProductionClient }) {
  const started = Date.now();
  const checkedAt = new Date(started).toISOString();
  let client;
  let result;
  try {
    client = await createClient(boundedDatabaseUrl(databaseUrl));
    await client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(READ_ONLY);
      await tx.$executeRawUnsafe(STATEMENT_TIMEOUT);
      const rows = await tx.$queryRawUnsafe(QUERY);
      if (rows?.length !== 1 || rows[0]?.ok !== 1) throw new Error("Unexpected health result");
    }, TRANSACTION_LIMITS);
    result = { status: "ready" };
  } catch (error) {
    result = { status: "failed", ...safeFailure(error) };
  } finally {
    if (client) {
      try { await client.$disconnect(); } catch { result = { status: "failed", category: "disconnect_failed" }; }
    }
  }
  return { checkedAt, elapsedMs: Date.now() - started, ...result };
}

export function isApprovedInvocation(env, args) {
  return args.length === 0 && env.GITHUB_ACTIONS === "true" &&
    env.GITHUB_REPOSITORY === "linyuan701/daily-paper" &&
    env.GITHUB_REF === "refs/heads/master" && env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
    env.GITHUB_WORKFLOW_REF === "linyuan701/daily-paper/.github/workflows/production-db-health.yml@refs/heads/master";
}

async function main() {
  if (!isApprovedInvocation(process.env, process.argv.slice(2))) {
    console.log(JSON.stringify({ checkedAt: new Date().toISOString(), status: "failed", category: "unauthorized_invocation" }));
    process.exitCode = 1;
    return;
  }
  const started = Date.now();
  const deadline = setTimeout(() => {
    console.log(JSON.stringify({ checkedAt: new Date().toISOString(), elapsedMs: Date.now() - started, status: "failed", category: "hard_timeout" }));
    process.exit(1);
  }, 15000);
  const result = await checkDatabaseHealth({ databaseUrl: process.env.DATABASE_URL });
  clearTimeout(deadline);
  console.log(JSON.stringify(result));
  process.exitCode = result.status === "ready" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
