import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ verify: vi.fn() }));

vi.mock("./lib/http/cloudflare-access", () => ({
  verifyCloudflareAccess: mocks.verify,
  verifySiteDashboardAccess: mocks.verify,
  isSiteDashboardRead: (request: Request) => request.method === "GET" && new URL(request.url).pathname === "/api/site/dashboard"
}));

import { middleware } from "./middleware";

function request(path: string) {
  return {
    nextUrl: { pathname: path },
    url: `https://daily-paper.example.workers.dev${path}`,
    headers: new Headers()
  } as never;
}

describe("Cloudflare Access middleware", () => {
  beforeEach(() => {
    process.env.DEPLOYMENT_MODE = "cloud";
    mocks.verify.mockReset();
  });

  it("keeps exact liveness public", async () => {
    const response = await middleware(request("/api/health/live"));
    expect(response.status).toBe(200);
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("rejects dashboard and API requests without a verified token", async () => {
    mocks.verify.mockResolvedValue({ ok: false, code: "ACCESS_TOKEN_REQUIRED" });
    const response = await middleware(request("/api/health/ready"));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      status: "error",
      code: "ACCESS_TOKEN_REQUIRED",
      message: "Cloudflare Access authentication is required."
    });
  });

  it("continues after application-level JWT verification", async () => {
    mocks.verify.mockResolvedValue({ ok: true, email: "owner@example.test" });
    expect((await middleware(request("/"))).status).toBe(200);
  });
});
