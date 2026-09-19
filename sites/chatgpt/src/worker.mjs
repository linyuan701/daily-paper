import { authorize, githubRuns, json, proxy } from "./proxy.mjs";
import { assets } from "./assets.mjs";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/bridge/"))
      return proxy(request, env, url.pathname.slice(12));
    if (url.pathname === "/api/github-runs") return githubRuns(request, env);
    if (request.method !== "GET" && request.method !== "HEAD")
      return json({ code: "METHOD_NOT_ALLOWED" }, 405);
    if (["/app.js", "/contracts.js", "/styles.css", "/favicon.svg"].includes(url.pathname))
      return asset(url.pathname, request.method);
    const denied = authorize(request, env);
    if (denied) {
      if (denied.status === 401)
        return Response.redirect(
          `${url.origin}/signin-with-chatgpt?return_to=${encodeURIComponent(url.pathname + url.search)}`,
          302,
        );
      return new Response("站点访问尚未配置，或当前账户不是站点所有者。", {
        status: 403,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }
    if (
      ![
        "/",
        "/papers",
        "/paper",
        "/profile",
        "/operations",
        "/history",
      ].includes(url.pathname)
    )
      return new Response("Not found", { status: 404 });
    return asset("/index.html", request.method);
  },
};

function asset(path, method) {
  const content = assets[path];
  if (!content) return new Response("Not found", { status: 404 });
  return new Response(method === "HEAD" ? null : content.body, {
    headers: {
      "Content-Type": content.type,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
      "Content-Security-Policy":
        "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'",
    },
  });
}
