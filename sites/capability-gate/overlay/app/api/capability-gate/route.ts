import { runCapabilityGate } from "@/lib/server/capability-gate";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return runCapabilityGate(request, process.env);
}
const readOnly = () => Response.json({ error: "read_only_gate" }, { status: 405, headers: { "Cache-Control": "no-store" } });
export const HEAD = readOnly, POST = readOnly, PUT = readOnly, PATCH = readOnly, DELETE = readOnly, OPTIONS = readOnly;
