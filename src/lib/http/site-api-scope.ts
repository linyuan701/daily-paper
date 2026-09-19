/** Opt-in service principal scope. Never includes generation, dispatch or admin APIs. */
export function isSiteApiRequest(request: Request): boolean {
  const path = new URL(request.url).pathname;
  if (request.method === "GET") return [
    "/api/recommendations/daily", "/api/ranking/recall", "/api/ranking/rerank",
    "/api/profile/snapshot", "/api/profile/refresh", "/api/feedback/logs",
    "/api/operations/runs", "/api/health/ready", "/api/site/capabilities"
  ].includes(path);
  return (request.method === "POST" && path === "/api/feedback/actions") ||
    (request.method === "PUT" && path === "/api/candidates/content");
}
