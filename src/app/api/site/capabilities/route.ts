import { NextResponse } from "next/server";
import { verifyCloudflareAccess } from "../../../../lib/http/cloudflare-access";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const access = await verifyCloudflareAccess(request);
  if (!access.ok) return NextResponse.json({ status: "error", code: access.code }, { status: 403 });
  const rawSha = process.env.DAILY_PAPER_BUILD_SHA ?? "";
  const rawTime = process.env.DAILY_PAPER_BUILD_TIME ?? "";
  return NextResponse.json({
    status: "ok", contractVersion: 1,
    feedback: ["save", "dismiss", "promote", "label_edit", "summary_edit"],
    refreshExecution: false,
    worker: {
      sha: /^[a-f0-9]{40}$/.test(rawSha) ? rawSha : null,
      builtAt: Number.isFinite(Date.parse(rawTime)) ? new Date(rawTime).toISOString() : null
    }
  }, { headers: { "Cache-Control": "no-store" } });
}
