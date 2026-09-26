import { NextResponse } from "next/server";
import { verifySiteDashboardAccess } from "../../../../lib/http/cloudflare-access";
import { getSiteDashboard } from "../../../../modules/site-dashboard/factory";
import type { SiteDashboard } from "../../../../modules/site-dashboard/service";

export const dynamic = "force-dynamic";

type Dependencies = {
  verifyAccess: typeof verifySiteDashboardAccess;
  readDashboard: () => Promise<SiteDashboard>;
};

export async function GET(request: Request) {
  return handleSiteDashboard(request, { verifyAccess: verifySiteDashboardAccess, readDashboard: getSiteDashboard });
}

async function handleSiteDashboard(request: Request, dependencies: Dependencies) {
  const headers = { "Cache-Control": "private, no-store", Vary: "Cf-Access-Jwt-Assertion" };
  if (request.method !== "GET") {
    return NextResponse.json({ status: "error", code: "METHOD_NOT_ALLOWED" }, {
      status: 405, headers: { ...headers, Allow: "GET" }
    });
  }
  const access = await dependencies.verifyAccess(request);
  if (!access.ok) {
    return NextResponse.json({ status: "error", code: access.code }, { status: 403, headers });
  }
  try {
    return NextResponse.json(await dependencies.readDashboard(), { headers });
  } catch {
    // Never return/log a database URL, JWT, or arbitrary provider exception.
    return NextResponse.json({ status: "error", code: "SITE_DASHBOARD_READ_FAILED" }, { status: 500, headers });
  }
}

// Explicitly disable Next's automatic GET -> HEAD response and OPTIONS handling.
const rejectMethod = (request: Request) => handleSiteDashboard(request, {
  verifyAccess: verifySiteDashboardAccess, readDashboard: getSiteDashboard
});
export { rejectMethod as POST, rejectMethod as PUT, rejectMethod as PATCH, rejectMethod as DELETE,
  rejectMethod as HEAD, rejectMethod as OPTIONS };
