import { pathToFileURL } from "node:url";

export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const DEEPSEEK_MODEL = "deepseek-v4-flash";

export function resolveSmokeConfig(environment = process.env) {
  const apiKey = environment.DEEPSEEK_API_KEY?.trim();
  const baseUrl = (environment.LLM_BASE_URL?.trim() || DEEPSEEK_BASE_URL).replace(/\/+$/, "");
  const model = environment.LLM_MODEL?.trim() || DEEPSEEK_MODEL;
  const invalid = [];

  if (!apiKey) invalid.push("DEEPSEEK_API_KEY");
  if (baseUrl !== DEEPSEEK_BASE_URL) invalid.push("LLM_BASE_URL");
  if (model !== DEEPSEEK_MODEL) invalid.push("LLM_MODEL");
  if (invalid.length > 0) {
    throw new Error(`DeepSeek smoke configuration is invalid: ${invalid.join(", ")}`);
  }

  return { apiKey, baseUrl, model };
}

export function classifyStatus(status) {
  if (status === 200) return "success";
  if (status === 401) return "authentication_failed";
  if (status === 402) return "insufficient_balance";
  if (status === 403) return "authorization_failed";
  if (status === 408) return "request_timeout";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  if (status >= 400) return "request_rejected";
  return "unexpected_status";
}

function validateContent(payload) {
  const message = payload?.choices?.[0]?.message;
  if (!message || typeof message.content !== "string" || !message.content.trim()) return false;
  if (
    (message.reasoning !== undefined && message.reasoning !== null && typeof message.reasoning !== "string") ||
    (message.reasoning_content !== undefined &&
      message.reasoning_content !== null &&
      typeof message.reasoning_content !== "string")
  ) return false;

  try {
    const value = JSON.parse(message.content);
    return value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === 1 &&
      value.status === "ok";
  } catch {
    return false;
  }
}

export async function runDeepSeekSmoke({
  environment = process.env,
  fetchImpl = fetch,
  logger = console.log,
  now = () => Date.now(),
  timeoutMs = 10_000
} = {}) {
  const config = resolveSmokeConfig(environment);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = now();
  let httpClassification = "network_error";
  let jsonValid = false;

  try {
    const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: "system", content: "Return only valid json." },
          { role: "user", content: 'Return exactly {"status":"ok"}.' }
        ],
        temperature: 0.2,
        stream: false,
        response_format: { type: "json_object" },
        thinking: { type: "disabled" },
        max_tokens: 32
      }),
      signal: controller.signal
    });

    httpClassification = classifyStatus(response.status);
    if (response.status === 200) {
      const payload = await response.json().catch(() => undefined);
      jsonValid = validateContent(payload);
    } else {
      await response.body?.cancel().catch(() => undefined);
    }
  } catch (error) {
    httpClassification = controller.signal.aborted || error?.name === "AbortError"
      ? "timeout"
      : "network_error";
  } finally {
    clearTimeout(timeout);
  }

  const result = {
    model: config.model,
    httpClassification,
    elapsedMs: Math.max(0, now() - startedAt),
    jsonValid
  };
  logger(JSON.stringify(result));
  if (httpClassification !== "success" || !jsonValid) {
    throw new Error("DeepSeek smoke failed; see bounded status metadata.");
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runDeepSeekSmoke();
  } catch {
    process.exitCode = 1;
  }
}
