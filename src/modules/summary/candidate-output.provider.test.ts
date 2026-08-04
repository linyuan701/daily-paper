import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEEPSEEK_BASE_URL,
  DEEPSEEK_MODEL,
  NVIDIA_NIM_BASE_URL,
  NVIDIA_NIM_MODEL
} from "../../lib/config/llm";
import {
  createCandidateOutputProvider,
  GenericLlmCandidateOutputProvider,
  UnavailableCandidateOutputProvider
} from "./candidate-output.provider";

describe("createCandidateOutputProvider", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("uses the exact NVIDIA Chat Completions request contract and normalizes trailing slashes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(labelsEnvelope()));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const provider = createCandidateOutputProvider({
      provider: "nvidia",
      apiKey: "nvidia-secret",
      apiBaseUrl: `${NVIDIA_NIM_BASE_URL}///`,
      maxRetries: 0
    });

    await provider.generateLabels(candidateFixture());

    expect(provider.getHealth()).toMatchObject({
      name: "nvidia-nim",
      endpoint: NVIDIA_NIM_BASE_URL,
      model: NVIDIA_NIM_MODEL
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${NVIDIA_NIM_BASE_URL}/chat/completions`);
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer nvidia-secret");
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      model: NVIDIA_NIM_MODEL,
      temperature: 0.2,
      stream: false,
      response_format: { type: "json_object" },
      chat_template_kwargs: { thinking: false }
    });
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[1].role).toBe("user");
  });

  it("uses the exact DeepSeek official Chat Completions contract with thinking disabled", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(labelsEnvelope()));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const provider = createCandidateOutputProvider({
      provider: "deepseek",
      apiKey: "deepseek-secret",
      apiBaseUrl: `${DEEPSEEK_BASE_URL}///`,
      maxRetries: 0
    });

    await provider.generateLabels(candidateFixture());

    expect(provider.getHealth()).toMatchObject({
      name: "deepseek-official",
      endpoint: DEEPSEEK_BASE_URL,
      model: DEEPSEEK_MODEL
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${DEEPSEEK_BASE_URL}/chat/completions`);
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer deepseek-secret");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      model: DEEPSEEK_MODEL,
      temperature: 0.2,
      stream: false,
      response_format: { type: "json_object" },
      thinking: { type: "disabled" }
    });
    expect(body).not.toHaveProperty("chat_template_kwargs");
  });

  it("keeps the legacy OpenAI-compatible adapter generic", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(labelsEnvelope()));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const provider = createCandidateOutputProvider({
      apiKey: "generic-secret",
      apiBaseUrl: "https://example.test/v1/",
      model: "   ",
      maxRetries: 0
    });

    await provider.generateLabels(candidateFixture());

    expect(provider).toBeInstanceOf(GenericLlmCandidateOutputProvider);
    expect(provider.getHealth()).toMatchObject({
      name: "generic-llm",
      endpoint: "https://example.test/v1",
      model: "gpt-4o-mini"
    });
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(request).not.toHaveProperty("chat_template_kwargs");
  });

  it("uses NVIDIA defaults only for the NVIDIA provider", () => {
    const provider = createCandidateOutputProvider({ provider: "nvidia", apiKey: "token" });
    expect(provider.getHealth()).toMatchObject({
      name: "nvidia-nim",
      endpoint: NVIDIA_NIM_BASE_URL,
      model: NVIDIA_NIM_MODEL
    });
  });

  it("uses official defaults only for the DeepSeek provider", () => {
    const provider = createCandidateOutputProvider({ provider: "deepseek", apiKey: "token" });
    expect(provider.getHealth()).toMatchObject({
      name: "deepseek-official",
      endpoint: DEEPSEEK_BASE_URL,
      model: DEEPSEEK_MODEL
    });
  });

  it("rejects DeepSeek endpoint or model overrides before fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    for (const input of [
      { provider: "deepseek" as const, apiKey: "token", apiBaseUrl: "https://example.test/v1" },
      { provider: "deepseek" as const, apiKey: "token", model: NVIDIA_NIM_MODEL }
    ]) {
      const provider = createCandidateOutputProvider(input);
      expect(provider).toBeInstanceOf(UnavailableCandidateOutputProvider);
      await expect(provider.generateLabels(candidateFixture())).rejects.toMatchObject({
        code: "CANDIDATE_OUTPUT_UNAVAILABLE"
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects NVIDIA endpoint or model overrides before fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    for (const input of [
      { provider: "nvidia" as const, apiKey: "token", apiBaseUrl: "https://example.test/v1" },
      { provider: "nvidia" as const, apiKey: "token", model: "other-model" }
    ]) {
      const provider = createCandidateOutputProvider(input);
      expect(provider).toBeInstanceOf(UnavailableCandidateOutputProvider);
      await expect(provider.generateLabels(candidateFixture())).rejects.toMatchObject({
        code: "CANDIDATE_OUTPUT_UNAVAILABLE"
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("names only missing configuration variables and never fetches", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const nvidia = createCandidateOutputProvider({ provider: "nvidia" });
    const generic = createCandidateOutputProvider({});

    expect(nvidia.getHealth()).toMatchObject({
      status: "unavailable",
      reason: "LLM configuration is missing: LLM_API_KEY."
    });
    expect(generic.getHealth()).toMatchObject({
      status: "unavailable",
      reason: "LLM configuration is missing: LLM_API_KEY, LLM_BASE_URL."
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts message content while ignoring reasoning fields", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      choices: [{
        finish_reason: "stop",
        message: {
          reasoning: "not consumed",
          reasoning_content: "also not consumed",
          content: JSON.stringify(validLabels())
        }
      }]
    })) as unknown as typeof fetch);

    const labels = await genericProvider().generateLabels(candidateFixture());
    expect(labels.researchType?.category).toBe("resource");
  });

  it.each(["reasoning", "reasoning_content"] as const)(
    "validates optional message.%s before ignoring it",
    async (field) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
        choices: [{
          message: {
            [field]: { private: "not a valid reasoning string" },
            content: JSON.stringify(validLabels())
          }
        }]
      })) as unknown as typeof fetch);

      await expect(genericProvider().generateLabels(candidateFixture())).rejects.toMatchObject({
        code: "CANDIDATE_OUTPUT_INVALID_SCHEMA",
        details: { path: `response.choices[0].message.${field}` }
      });
    }
  );

  it("rejects a non-JSON HTTP response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      status: 200,
      json: async () => {
        throw new SyntaxError("private raw response");
      }
    } as unknown as Response) as unknown as typeof fetch);

    await expect(genericProvider().generateLabels(candidateFixture())).rejects.toMatchObject({
      code: "CANDIDATE_OUTPUT_INVALID_SCHEMA",
      details: { path: "response" }
    });
  });

  it("rejects empty and malformed message content", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: "  " } }] }))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: "not-json" } }] }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const provider = genericProvider();

    await expect(provider.generateLabels(candidateFixture())).rejects.toMatchObject({
      code: "CANDIDATE_OUTPUT_INVALID_SCHEMA",
      details: { path: "response.choices[0].message.content" }
    });
    await expect(provider.generateLabels(candidateFixture())).rejects.toMatchObject({
      code: "CANDIDATE_OUTPUT_PROVIDER_ERROR"
    });
  });

  it("preserves strict generated-output schema validation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      choices: [{ message: { content: JSON.stringify({
        researchQuestion: "研究问题。",
        method: 42,
        mainFinding: "主要发现。",
        relevanceToUser: "具有参考价值。"
      }) } }]
    })) as unknown as typeof fetch);

    await expect(genericProvider().generateSummary(candidateFixture())).rejects.toMatchObject({
      code: "CANDIDATE_OUTPUT_INVALID_SCHEMA",
      details: { path: "summary.method" }
    });
  });

  it("rejects LLM-generated recommendation reasons so persisted rerank evidence remains authoritative", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      choices: [{ message: { content: JSON.stringify({
        summary: {},
        labels: {},
        recommendationReason: "must not enter business output"
      }) } }]
    })) as unknown as typeof fetch);

    await expect(genericProvider().generateOutput(candidateFixture())).rejects.toMatchObject({
      code: "CANDIDATE_OUTPUT_INVALID_SCHEMA",
      details: { path: "output" }
    });
  });

  it.each([401, 402, 403, 408, 422])("does not retry HTTP %i", async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(statusResponse(status));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await expect(genericProvider({ maxRetries: 3 }).generateLabels(candidateFixture())).rejects.toMatchObject({
      code: "CANDIDATE_OUTPUT_PROVIDER_HTTP_ERROR",
      details: { status, attempts: 1 }
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([501, 505, 510])("does not retry non-recoverable HTTP %i responses", async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(statusResponse(status));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await expect(genericProvider({ maxRetries: 3 }).generateLabels(candidateFixture())).rejects.toMatchObject({
      code: "CANDIDATE_OUTPUT_PROVIDER_HTTP_ERROR",
      details: { classification: "unexpected_status", status, attempts: 1 }
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a 202 pending response instead of parsing it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(statusResponse(202));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await expect(genericProvider({ maxRetries: 3 }).generateLabels(candidateFixture())).rejects.toMatchObject({
      code: "CANDIDATE_OUTPUT_PROVIDER_HTTP_ERROR",
      details: { classification: "pending_response", status: 202, attempts: 1 }
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([429, 500, 502, 503, 504, 520, 529])("retries bounded transient HTTP %i responses", async (status) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(statusResponse(status))
      .mockResolvedValueOnce(jsonResponse(labelsEnvelope()));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const labels = await genericProvider({ maxRetries: 1 }).generateLabels(candidateFixture());
    expect(labels.contentRecallLabel).toBe("single-cell atlas");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("continues bounded retries across NVIDIA gateway 520 and 529 until a success", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(statusResponse(520))
      .mockResolvedValueOnce(statusResponse(529))
      .mockResolvedValueOnce(jsonResponse(labelsEnvelope()));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const labels = await genericProvider({ maxRetries: 2 }).generateLabels(candidateFixture());
    expect(labels.contentRecallLabel).toBe("single-cell atlas");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("stops retrying NVIDIA gateway errors at the configured limit", async () => {
    const fetchMock = vi.fn().mockResolvedValue(statusResponse(529));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await expect(genericProvider({ maxRetries: 2 }).generateLabels(candidateFixture())).rejects.toMatchObject({
      code: "CANDIDATE_OUTPUT_PROVIDER_HTTP_ERROR",
      details: { classification: "upstream_unavailable", status: 529, attempts: 3, maxRetries: 2 }
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("discards a non-success response body before reporting the failure", async () => {
    const response = new Response("private provider response", { status: 529 });
    const cancelSpy = vi.spyOn(response.body!, "cancel");
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await expect(genericProvider({ maxRetries: 0 }).generateLabels(candidateFixture())).rejects.toMatchObject({
      code: "CANDIDATE_OUTPUT_PROVIDER_HTTP_ERROR",
      details: { status: 529, attempts: 1 }
    });
    expect(cancelSpy).toHaveBeenCalledTimes(1);
  });

  it("uses the default two retries for three total attempts", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(statusResponse(529)));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await expect(genericProvider({ maxRetries: undefined }).generateLabels(candidateFixture())).rejects.toMatchObject({
      details: { status: 529, attempts: 3, maxRetries: 2 }
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("enforces the hard retry cap as six total attempts", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(statusResponse(529)));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await expect(genericProvider({ maxRetries: 99 }).generateLabels(candidateFixture())).rejects.toMatchObject({
      details: { status: 529, attempts: 6, maxRetries: 5 }
    });
    expect(fetchMock).toHaveBeenCalledTimes(6);
  }, 10_000);

  it("reports retry exhaustion without exposing response data", async () => {
    const fetchMock = vi.fn().mockResolvedValue(statusResponse(503));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const secret = "never-print-this-secret";
    const provider = createCandidateOutputProvider({
      apiKey: secret,
      apiBaseUrl: "https://private-host.example/v1",
      maxRetries: 2
    });

    const error = await captureError(() => provider.generateLabels(candidateFixture()));
    expect(error).toMatchObject({
      code: "CANDIDATE_OUTPUT_PROVIDER_HTTP_ERROR",
      details: { classification: "upstream_unavailable", status: 503, attempts: 3 }
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const serialized = JSON.stringify(error);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("private-host");
    expect(serialized).not.toContain("Single-cell atlas");
  });

  it("does not retry timeout failures", async () => {
    const fetchMock = vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("private timeout", "AbortError")));
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await expect(genericProvider({ timeoutMs: 5, maxRetries: 3 }).generateLabels(candidateFixture()))
      .rejects.toMatchObject({
        code: "CANDIDATE_OUTPUT_PROVIDER_REQUEST_FAILED",
        details: { classification: "timeout", attempts: 1 }
      });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry or expose network errors", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error(
      "network failed at https://private-host.example with never-print-this-secret and raw body"
    ));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const error = await captureError(() => genericProvider({ maxRetries: 3 }).generateLabels(candidateFixture()));
    expect(error).toMatchObject({
      code: "CANDIDATE_OUTPUT_PROVIDER_REQUEST_FAILED",
      details: { classification: "network", attempts: 1 }
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(error)).not.toMatch(/private-host|never-print|raw body/);
  });

  it("caps configured retries", () => {
    const provider = genericProvider({ maxRetries: 99 });
    expect(provider.getHealth()).toMatchObject({ maxRetries: 5 });
  });

  it("accepts a complete finish reason and well-formed usage", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      choices: [{ finish_reason: "stop", message: { content: JSON.stringify(validLabels()) } }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, extra_metric: 1 }
    })) as unknown as typeof fetch);

    await expect(genericProvider().generateLabels(candidateFixture())).resolves.toMatchObject({
      contentRecallLabel: "single-cell atlas"
    });
  });

  it("rejects incomplete finish reasons and malformed usage", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({
        choices: [{ finish_reason: "length", message: { content: JSON.stringify(validLabels()) } }]
      }))
      .mockResolvedValueOnce(jsonResponse({
        choices: [{ finish_reason: "stop", message: { content: JSON.stringify(validLabels()) } }],
        usage: { total_tokens: -1 }
      }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const provider = genericProvider();

    await expect(provider.generateLabels(candidateFixture())).rejects.toMatchObject({
      code: "CANDIDATE_OUTPUT_INVALID_SCHEMA",
      details: { path: "response.choices[0].finish_reason" }
    });
    await expect(provider.generateLabels(candidateFixture())).rejects.toMatchObject({
      code: "CANDIDATE_OUTPUT_INVALID_SCHEMA",
      details: { path: "response.usage.total_tokens" }
    });
  });

  it("keeps batch parsing and candidate matching behavior", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      choices: [{ message: { content: JSON.stringify({
        items: [
          { candidateId: "candidate-1", labels: validLabels() },
          { candidateId: "candidate-2", labels: { ...validLabels(), contentRecallLabel: "regulatory genomics" } }
        ]
      }) } }]
    })) as unknown as typeof fetch);

    const outputs = await genericProvider().generateLabelsBatch!([
      candidateFixture(),
      { ...candidateFixture(), candidateId: "candidate-2" }
    ]);
    expect(outputs.map((entry) => entry.candidateId)).toEqual(["candidate-1", "candidate-2"]);
  });

  it("keeps evidence-bounded Chinese summary prompting and validation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      choices: [{ message: { content: JSON.stringify({
        researchQuestion: "研究旨在解析单细胞染色质可及性的变化。",
        method: "作者使用 scATAC-seq 进行单细胞分析。",
        mainFinding: "结果显示候选调控元件具有细胞类型特异性。",
        relevanceToUser: "该方法可为类似数据的分析流程提供参考。"
      }) } }]
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const summary = await genericProvider().generateSummary(candidateFixture());
    expect(summary.method).toContain("scATAC-seq");
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(request.messages[1].content).toContain("Simplified Chinese");
    expect(request.messages[1].content).toContain("do not claim knowledge of the user's profile");
    expect(request.messages[1].content).toContain("not a full-text review");
  });
});

function genericProvider(overrides: {
  timeoutMs?: number;
  maxRetries?: number;
} = {}) {
  return createCandidateOutputProvider({
    provider: "openai-compatible",
    apiKey: "token",
    apiBaseUrl: "https://example.test/v1",
    maxRetries: 0,
    ...overrides
  });
}

function candidateFixture() {
  return {
    candidateId: "candidate-1",
    runId: "run-1",
    canonicalKey: "key-1",
    title: "Single-cell atlas",
    sourceProvenance: []
  };
}

function validLabels() {
  return {
    contentRecallLabel: "single-cell atlas",
    researchType: {
      category: "resource",
      primaryKeyword: "atlas",
      secondaryKeyword: "single-cell"
    }
  };
}

function labelsEnvelope() {
  return {
    choices: [{ message: { content: JSON.stringify(validLabels()) } }]
  };
}

function jsonResponse(payload: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => payload
  } as Response;
}

function statusResponse(status: number) {
  return {
    ok: false,
    status,
    json: async () => ({ error: "private provider response" })
  } as Response;
}

async function captureError(run: () => Promise<unknown>) {
  try {
    await run();
    throw new Error("Expected operation to fail");
  } catch (error) {
    return error;
  }
}
