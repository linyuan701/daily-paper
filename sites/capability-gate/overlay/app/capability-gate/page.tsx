import { headers } from "next/headers";
import { requireChatGPTUser } from "@/app/chatgpt-auth";
import { runCapabilityGate } from "@/lib/server/capability-gate";
export const dynamic = "force-dynamic";
export default async function CapabilityGate() {
  await requireChatGPTUser("/capability-gate");
  const identityHeaders = new Headers(await headers());
  const response = await runCapabilityGate(new Request("https://site.invalid/api/capability-gate", { headers: identityHeaders }), process.env);
  const report = await response.json();
  const passed = response.ok && report !== null && typeof report === "object" && "conclusion" in report && report.conclusion === "READ_PATH_PASSED_SECRET_PROOF_PENDING";
  return <main style={{ maxWidth: "960px", margin: "40px auto", padding: "24px", fontFamily: "system-ui", lineHeight: 1.6 }}>
    <a href="/">返回研究运行台</a>
    <h1>Sites runtime capability gate</h1>
    <p>{passed ? "服务端只读链路通过 · 仍需独立核对 secret 摘要" : "尚未证明完整链路"}</p>
    <p>私有 Site → 服务端 secrets → HTTPS → Cloudflare Access → Daily Paper。此页仅发送 GET，不写入业务数据。</p>
    <a href="/capability-gate">重新执行只读检查</a>{" · "}<a href="/api/capability-gate">查看 JSON 证据</a>
    <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", background: "#101d2d", color: "#eef5fa", padding: "20px", borderRadius: "8px", fontSize: "14px" }}>{JSON.stringify(report, null, 2)}</pre>
    <p>canaryProof 是独立随机测试 secret 的摘要。Access 凭据、原始上游响应和用户身份值均不输出。</p>
  </main>;
}
