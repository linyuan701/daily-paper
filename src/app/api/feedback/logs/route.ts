import { NextResponse } from "next/server";

import { createFeedbackService } from "../../../../modules/feedback";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const runId = searchParams.get("runId")?.trim() || undefined;
  const candidateId = searchParams.get("candidateId")?.trim() || undefined;
  const candidateIds = [...new Set(
    searchParams.getAll("candidateId").map((value) => value.trim()).filter(Boolean)
  )];
  const limitParam = searchParams.get("limit");
  const limit = limitParam ? Math.max(1, Math.min(500, Number.parseInt(limitParam, 10) || 100)) : 100;

  const service = createFeedbackService();
  const logs = await service.listLogs({
    runId,
    candidateId: candidateIds.length > 0 ? undefined : candidateId,
    candidateIds: candidateIds.length > 0 ? candidateIds : undefined,
    limit: candidateIds.length > 0 ? undefined : limit
  });

  return NextResponse.json({
    status: "ok",
    logs
  });
}
