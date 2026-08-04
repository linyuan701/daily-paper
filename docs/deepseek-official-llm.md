# DeepSeek official generative LLM configuration

Daily Paper uses DeepSeek's official OpenAI-compatible Chat Completions endpoint for candidate labels and Chinese summaries when `LLM_PROVIDER=deepseek`.

## Runtime contract

```text
LLM_PROVIDER=deepseek
LLM_BASE_URL=https://api.deepseek.com
LLM_MODEL=deepseek-v4-flash
LLM_API_KEY=<injected secret>
```

The client appends `/chat/completions`, so the final request URL is `https://api.deepseek.com/chat/completions`. The official model ID is `deepseek-v4-flash`; the NVIDIA-specific `deepseek-ai/deepseek-v4-flash` identifier is invalid for this provider.

Requests remain non-streaming, keep the application's existing `temperature=0.2`, and request `response_format: {"type":"json_object"}`. DeepSeek V4 enables thinking by default, so this integration sends `thinking: {"type":"disabled"}`. Only `message.content` is parsed as business JSON; `reasoning` and `reasoning_content` are validated and ignored. Parsed labels and summaries still pass the application's strict field-level schema validation before persistence.

Embedding settings remain separate under `EMBEDDING_API_KEY`, `EMBEDDING_API_BASE_URL`, and `EMBEDDING_MODEL`. Recall, explainable rerank, recommendation reasons, EasyScholar, ingestion, scheduling, and notification behavior are unchanged.

## GitHub production settings

Configure the protected `production` Environment manually:

- Secret `DEEPSEEK_API_KEY` with the official DeepSeek credential.
- Variable `LLM_PROVIDER` as `deepseek`.
- Variable `LLM_BASE_URL` as `https://api.deepseek.com`.
- Variable `LLM_MODEL` as `deepseek-v4-flash`.

The daily workflow maps `DEEPSEEK_API_KEY` to the runtime-only `LLM_API_KEY`. It does not fall back to `NVIDIA_API_KEY` or the legacy generic `LLM_API_KEY`. Never place the credential in a Variable, repository file, fixture, log, issue, or PR text.

## Isolated smoke test

The **DeepSeek official LLM smoke test** workflow is manual-only. It sends one small fixed prompt, does not install or import Prisma, and has no database, Zotero, ingestion, ranking, daily-run, recommendation, or notification configuration. Logs contain only the model, bounded HTTP classification, elapsed milliseconds, and JSON validation result.

1. Configure the four production Environment entries above.
2. Open Actions → **DeepSeek official LLM smoke test** → **Run workflow**.
3. Select the reviewed branch and explicitly dispatch it.
4. Confirm `httpClassification` is `success` and `jsonValid` is `true`.

For an equivalent local check, inject `DEEPSEEK_API_KEY` into the current process and run `node scripts/deepseek-llm-smoke.mjs`. Do not put a real key in `.env.example` or shell history. Do not use the daily workflow as a provider smoke test.

## Retry and rollback

Application requests use bounded retries for HTTP 429 and recoverable server/gateway errors, with the existing hard retry cap. Authentication, authorization, insufficient balance, timeout, network, and non-recoverable client errors fail with safe classifications and no response-body logging. Batch label validation failures retain the existing per-paper fallback.

To roll back without code or data changes, restore:

```text
LLM_PROVIDER=nvidia
LLM_BASE_URL=https://integrate.api.nvidia.com/v1
LLM_MODEL=deepseek-ai/deepseek-v4-flash
```

The daily workflow will then select the retained `NVIDIA_API_KEY`. Existing generated records retain their stored provider provenance.
