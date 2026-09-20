// Server-only diagnostic: no user-selected URL, mutation, persistence, or retries.
export const GATE_REVISION = "daily-paper-sites-gate-v1";
const WORKER_ORIGIN = "https://daily-paper.zzy19990821.workers.dev";
const MAX_BYTES = 4_000_000;
type Environment = Record<string, string | undefined>;
type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
const present = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

async function probe(path: string, credentials: boolean, environment: Environment, fetcher: Fetcher) {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetcher(WORKER_ORIGIN + path, {
      method: "GET", redirect: "manual", credentials: "omit", cache: "no-store", signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(credentials ? {
          "CF-Access-Client-Id": environment.DAILY_PAPER_ACCESS_CLIENT_ID!,
          "CF-Access-Client-Secret": environment.DAILY_PAPER_ACCESS_CLIENT_SECRET!
        } : {})
      }
    });
    let accessLoginRedirect = false;
    try {
      const location = new URL(response.headers.get("location") || "", WORKER_ORIGIN);
      accessLoginRedirect = response.status >= 300 && response.status < 400 && location.hostname.endsWith(".cloudflareaccess.com");
    } catch { /* Report only the boolean, never an auth URL. */ }
    let schemaRecognized = false;
    let code: string | null = null;
    const json = /^application\/json(?:;|$)/i.test(response.headers.get("content-type") || "");
    if (json && response.body) {
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let body = "", size = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_BYTES) throw new Error("bounded_response");
        body += decoder.decode(chunk.value, { stream: true });
      }
      try {
        const payload = JSON.parse(body + decoder.decode());
        schemaRecognized = path === "/api/site/dashboard"
          ? payload?.status === "ok" && payload?.schemaVersion === 1
          : payload?.status === "ready";
        // Closed vocabulary prevents arbitrary upstream/credential reflection.
        if (["ACCESS_CONFIGURATION_INVALID", "ACCESS_TOKEN_REQUIRED", "ACCESS_TOKEN_INVALID", "DATABASE_UNAVAILABLE"].includes(payload?.code)) code = payload.code;
      } catch { /* Not a recognized contract. */ }
    }
    return { path, credentialsSent: credentials, httpStatus: response.status, json, schemaRecognized, accessLoginRedirect, code, elapsedMs: Date.now() - started };
  } catch {
    return { path, credentialsSent: credentials, httpStatus: null, failure: controller.signal.aborted ? "timeout" : "network_or_response_failure", elapsedMs: Date.now() - started };
  } finally {
    clearTimeout(timeout);
    if (reader) await reader.cancel().catch(() => {});
    controller.abort();
  }
}

export async function runCapabilityGate(request: Request, environment: Environment, fetcher: Fetcher = fetch) {
  const common = { "Cache-Control": "no-store, private", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
  const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: common });
  if (request.method !== "GET") return reply({ error: "read_only_gate" }, 405);
  const email = request.headers.get("oai-authenticated-user-email")?.trim().toLowerCase();
  const id = request.headers.get("oai-authenticated-user-id")?.trim();
  if (!email || !id) return reply({ error: "sign_in_required", identity: { emailPresent: !!email, idPresent: !!id } }, 401);
  const allowed = environment.DAILY_PAPER_SITE_ALLOWED_EMAIL?.trim().toLowerCase();
  if (!allowed || email !== allowed) return reply({ error: "owner_required" }, 403);
  const secrets = {
    clientIdPresent: present(environment.DAILY_PAPER_ACCESS_CLIENT_ID),
    clientSecretPresent: present(environment.DAILY_PAPER_ACCESS_CLIENT_SECRET),
    canaryPresent: present(environment.SITES_CAPABILITY_GATE_CANARY)
  };
  if (environment.DAILY_PAPER_API_ORIGIN !== WORKER_ORIGIN || !secrets.clientIdPresent || !secrets.clientSecretPresent ||
      /[\r\n]/.test(environment.DAILY_PAPER_ACCESS_CLIENT_ID! + environment.DAILY_PAPER_ACCESS_CLIENT_SECRET!)) {
    return reply({ error: "gate_configuration_invalid", secrets }, 503);
  }
  const digest = secrets.canaryPresent
    ? await crypto.subtle.digest("SHA-256", new TextEncoder().encode(GATE_REVISION + ":" + environment.SITES_CAPABILITY_GATE_CANARY))
    : null;
  const canaryProof = digest ? Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("") : null;
  const checks = await Promise.all([
    probe("/api/site/dashboard", false, environment, fetcher),
    probe("/api/site/dashboard", true, environment, fetcher),
    probe("/api/health/ready", true, environment, fetcher)
  ]);
  const [anonymous, authenticated] = checks;
  const outboundPassed = authenticated.httpStatus === 200 && "schemaRecognized" in authenticated && authenticated.schemaRecognized;
  const controlRejected = anonymous.httpStatus === 401 || anonymous.httpStatus === 403 || ("accessLoginRedirect" in anonymous && anonymous.accessLoginRedirect);
  return reply({
    revision: GATE_REVISION, observedAt: new Date().toISOString(), requestId: crypto.randomUUID(),
    identity: { emailPresent: true, idPresent: true, ownerMatched: true },
    secrets: { ...secrets, canaryProof },
    workerOrigin: WORKER_ORIGIN, checks,
    conclusion: outboundPassed && controlRejected && secrets.canaryPresent ? "READ_PATH_PASSED_SECRET_PROOF_PENDING" : "NOT_YET_PROVEN"
  });
}
