import { NextResponse, type NextRequest } from "next/server";

import { isSiteDashboardRead, verifyCloudflareAccess, verifySiteDashboardAccess } from "./lib/http/cloudflare-access";

export async function middleware(request: NextRequest) {
  if (
    process.env.DEPLOYMENT_MODE?.trim().toLowerCase() !== "cloud" ||
    request.nextUrl.pathname === "/api/health/live"
  ) {
    return NextResponse.next();
  }

  const access = await (isSiteDashboardRead(request)
    ? verifySiteDashboardAccess(request)
    : verifyCloudflareAccess(request));
  if (!access.ok) {
    return NextResponse.json(
      {
        status: "error",
        code: access.code,
        message: "Cloudflare Access authentication is required."
      },
      {
        status: 403,
        headers: { "Cache-Control": "no-store" }
      }
    );
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"]
};
