// No database, filesystem, scheduler, provider, or ranking dependency belongs here.
export const routes = Object.freeze({
  feed: {
    method: "GET",
    path: "/api/recommendations/daily",
    query: ["runId"],
    fixed: { selectedOnly: "true" },
  },
  recall: { method: "GET", path: "/api/ranking/recall", query: ["runId"] },
  rerank: { method: "GET", path: "/api/ranking/rerank", query: ["runId"] },
  profile: { method: "GET", path: "/api/profile/snapshot" },
  refresh: { method: "GET", path: "/api/profile/refresh" },
  operations: {
    method: "GET",
    path: "/api/operations/runs",
    fixed: { limit: "10" },
  },
  logs: {
    method: "GET",
    path: "/api/feedback/logs",
    query: ["runId", "candidateId"],
    fixed: { limit: "500" },
  },
  capabilities: { method: "GET", path: "/api/site/capabilities" },
  feedback: { method: "POST", path: "/api/feedback/actions" },
  content: { method: "PUT", path: "/api/candidates/content" },
});

export function json(value, status = 200) {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
function failure(code, status) {
  return json({ status: "error", code }, status);
}

export function authorize(request, env) {
  const id = request.headers.get("oai-authenticated-user-id")?.trim();
  const email = request.headers
    .get("oai-authenticated-user-email")
    ?.trim()
    .toLowerCase();
  const allowed = env.DAILY_PAPER_SITE_ALLOWED_EMAIL?.trim().toLowerCase();
  if (!id || !email) return failure("CHATGPT_SIGN_IN_REQUIRED", 401);
  if (!allowed || email !== allowed) return failure("SITE_OWNER_REQUIRED", 403);
  return null;
}

function upstreamOrigin(env) {
  try {
    const url = new URL(env.DAILY_PAPER_API_ORIGIN);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      url.hostname === "localhost" ||
      url.hostname.endsWith(".localhost") ||
      url.hostname.includes(":") ||
      /^[\d.]+$/.test(url.hostname)
    )
      return null;
    return url.origin;
  } catch {
    return null;
  }
}

async function boundedText(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw new Error("size");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const buffer = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(buffer);
}

export async function proxy(request, env, name, fetcher = fetch) {
  const denied = authorize(request, env);
  if (denied) return denied;
  const route = Object.hasOwn(routes, name) ? routes[name] : undefined;
  if (!route) return failure("ROUTE_NOT_ALLOWED", 404);
  if (request.method !== route.method)
    return failure("METHOD_NOT_ALLOWED", 405);
  const origin = upstreamOrigin(env);
  if (
    !origin ||
    !env.DAILY_PAPER_ACCESS_CLIENT_ID ||
    !env.DAILY_PAPER_ACCESS_CLIENT_SECRET
  ) {
    return failure("BACKEND_CONNECTION_NOT_CONFIGURED", 503);
  }
  const incoming = new URL(request.url);
  const target = new URL(route.path, origin);
  for (const [key, value] of incoming.searchParams) {
    if (!route.query?.includes(key) || !value.trim() || value.length > 191)
      return failure("INVALID_QUERY", 400);
    target.searchParams.set(key, value);
  }
  for (const [key, value] of Object.entries(route.fixed ?? {}))
    target.searchParams.set(key, value);
  const headers = {
    Accept: "application/json",
    "CF-Access-Client-Id": env.DAILY_PAPER_ACCESS_CLIENT_ID,
    "CF-Access-Client-Secret": env.DAILY_PAPER_ACCESS_CLIENT_SECRET,
  };
  let body;
  if (route.method !== "GET") {
    if (
      request.headers.get("origin") !== incoming.origin ||
      ![null, "same-origin"].includes(request.headers.get("sec-fetch-site"))
    )
      return failure("ORIGIN_MISMATCH", 403);
    if (
      !/^application\/json(?:\s*;|$)/i.test(
        request.headers.get("content-type") ?? "",
      )
    )
      return failure("JSON_REQUIRED", 415);
    try {
      body = await boundedText(request, 64 * 1024);
      const value = JSON.parse(body);
      if (!value || typeof value !== "object" || Array.isArray(value))
        return failure("INVALID_BODY", 400);
      const allowed =
        name === "feedback"
          ? ["runId", "candidateId", "action"]
          : ["candidateId", "labels", "summary"];
      if (Object.keys(value).some((key) => !allowed.includes(key)))
        return failure("INVALID_BODY", 400);
      if (
        name === "feedback" &&
        (!["save", "dismiss", "promote"].includes(value.action) ||
          typeof value.runId !== "string" ||
          !value.runId.trim() ||
          value.runId.length > 191)
      )
        return failure("INVALID_BODY", 400);
      if (
        typeof value.candidateId !== "string" ||
        !value.candidateId.trim() ||
        value.candidateId.length > 191
      )
        return failure("INVALID_BODY", 400);
    } catch {
      return failure("INVALID_OR_OVERSIZED_BODY", 400);
    }
    headers["Content-Type"] = "application/json";
    headers.Origin = origin;
    // Do not copy browser cookies, Access assertions or Fetch-Metadata headers.
  }
  try {
    const response = await fetcher(target.href, {
      method: route.method,
      headers,
      body,
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(20000),
    });
    if (
      (response.status >= 300 && response.status < 400) ||
      [401, 403].includes(response.status)
    )
      return failure("BACKEND_ACCESS_DENIED", 502);
    if (!response.ok)
      return failure(
        route.method !== "GET" && response.status >= 500
          ? "WRITE_OUTCOME_UNKNOWN_CHECK_HISTORY"
          : `BACKEND_HTTP_${response.status}`,
        response.status >= 500 ? 502 : response.status,
      );
    if (
      !/^application\/json(?:\s*;|$)/i.test(
        response.headers.get("content-type") ?? "",
      )
    )
      return failure(
        route.method === "GET"
          ? "BACKEND_NOT_JSON"
          : "WRITE_OUTCOME_UNKNOWN_CHECK_HISTORY",
        502,
      );
    const payload = JSON.parse(await boundedText(response, 4 * 1024 * 1024));
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      return failure(
        route.method === "GET"
          ? "BACKEND_CONTRACT_INVALID"
          : "WRITE_OUTCOME_UNKNOWN_CHECK_HISTORY",
        502,
      );
    // Never reflect a credential even if a misconfigured upstream echoes it.
    const serialized = JSON.stringify(payload);
    if (
      [
        env.DAILY_PAPER_ACCESS_CLIENT_SECRET,
        env.DAILY_PAPER_ACCESS_CLIENT_ID,
      ].some((value) => value && serialized.includes(value))
    )
      return failure(
        route.method === "GET"
          ? "BACKEND_UNSAFE_RESPONSE"
          : "WRITE_OUTCOME_UNKNOWN_CHECK_HISTORY",
        502,
      );
    return json(payload);
  } catch {
    return failure(
      route.method === "GET"
        ? "BACKEND_UNAVAILABLE"
        : "WRITE_OUTCOME_UNKNOWN_CHECK_HISTORY",
      502,
    );
  }
}

export async function githubRuns(request, env, fetcher = fetch) {
  const denied = authorize(request, env);
  if (denied) return denied;
  if (request.method !== "GET") return failure("METHOD_NOT_ALLOWED", 405);
  const repository = env.DAILY_PAPER_GITHUB_REPOSITORY;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? ""))
    return failure("GITHUB_NOT_CONFIGURED", 503);
  try {
    const headers = {
      Accept: "application/vnd.github+json",
      "User-Agent": "Daily-Paper-Site",
    };
    if (env.DAILY_PAPER_GITHUB_READ_TOKEN)
      headers.Authorization = `Bearer ${env.DAILY_PAPER_GITHUB_READ_TOKEN}`;
    const response = await fetcher(
      `https://api.github.com/repos/${repository}/actions/workflows/daily.yml/runs?per_page=10`,
      { headers, redirect: "manual", signal: AbortSignal.timeout(15000) },
    );
    if (!response.ok) return failure("GITHUB_RUNS_UNAVAILABLE", 502);
    const data = JSON.parse(await boundedText(response, 1024 * 1024));
    return json({
      status: "ok",
      runs: (data.workflow_runs ?? []).slice(0, 10).map((run) => ({
        id: run.id,
        sha: run.head_sha,
        createdAt: run.created_at,
        status: run.status,
        conclusion: run.conclusion,
        url: `https://github.com/${repository}/actions/runs/${Number(run.id)}`,
      })),
    });
  } catch {
    return failure("GITHUB_RUNS_UNAVAILABLE", 502);
  }
}
