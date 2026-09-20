# NVIDIA NIM generative LLM configuration

Daily Paper uses the NVIDIA NIM hosted OpenAI-compatible Chat Completions endpoint for candidate labels and Chinese summaries when `LLM_PROVIDER=nvidia`.

## Runtime contract

```text
LLM_PROVIDER=nvidia
LLM_BASE_URL=https://integrate.api.nvidia.com/v1
LLM_MODEL=deepseek-ai/deepseek-v4-flash
LLM_API_KEY=<injected secret>
```

The base URL ends at `/v1`; the client appends `/chat/completions`. The abbreviated model name `deepseek-v4-flash` is invalid. `LLM_API_BASE_URL` remains a deprecated fallback for existing OpenAI-compatible provider configurations, but new configuration should use `LLM_BASE_URL`.

The request is non-streaming, keeps the application's existing `temperature=0.2`, requests JSON mode, and disables the model's thinking extension. Only `message.content` is parsed as business JSON. Optional `reasoning` and `reasoning_content` fields are never appended to summaries or labels, and every parsed result still passes the application's strict field-level validation.

Embedding settings remain separate under `EMBEDDING_API_KEY`, `EMBEDDING_API_BASE_URL`, and `EMBEDDING_MODEL`. Explainable recall/rerank, recommendation reasons, EasyScholar, source ingestion, scheduling, and notification behavior do not use this chat model.

## GitHub production settings

In the protected `production` Environment, configure:

- Secret `NVIDIA_API_KEY` with the NVIDIA API credential.
- Variable `LLM_PROVIDER` as `nvidia` (required to select the NVIDIA credential).
- Variable `LLM_BASE_URL` as `https://integrate.api.nvidia.com/v1`.
- Variable `LLM_MODEL` as `deepseek-ai/deepseek-v4-flash`.

Do not put the credential in a Variable, repository file, command line, fixture, or issue/PR text. The workflow never falls back from `NVIDIA_API_KEY` to another provider's credential. Omitting `LLM_PROVIDER` preserves the existing OpenAI-compatible workflow behavior; the legacy `LLM_API_KEY` Secret and `LLM_API_BASE_URL` Variable remain recognized only for rollback compatibility.

## Isolated smoke test

The **NVIDIA NIM LLM smoke test** workflow is manual-only. It sends one fixed, small prompt, does not install or import Prisma, and has no database, Zotero, ingestion, ranking, daily-run, recommendation, or notification configuration. Its log contains only the model, HTTP classification, elapsed milliseconds, and JSON-validation result.

To run it safely:

1. Configure the protected Environment settings above.
2. Open Actions → **NVIDIA NIM LLM smoke test** → **Run workflow**.
3. Select the intended reviewed branch and explicitly dispatch it.
4. Confirm `httpClassification` is `success` and `jsonValid` is `true`.

The script rejects a non-NVIDIA base URL or abbreviated/wrong model before sending the secret. A missing `NVIDIA_API_KEY` also fails before any network request. Do not use the daily workflow as a provider smoke test.

If a normal smoke returns `server_error`, explicitly enable the `diagnostic` input. Diagnostic mode makes exactly two bounded calls: an API-reference-style minimal request and the existing structured-output request. It logs the stage and exact HTTP status in addition to the normal bounded metadata, but never logs response bodies, headers, prompts, or credentials. If both stages fail with the same 5xx, the failure is upstream of structured-output parameters; if only the structured stage fails, investigate `response_format` and thinking controls before changing production behavior.

Run this check through the manual GitHub smoke-test workflow. The former local credential-injection procedure is retired under DPO-011; no local Node installation or secret file is required.

## Retry and rollback

Application calls retry only HTTP 429, recoverable HTTP 500/502/503/504 responses, and NVIDIA gateway HTTP 520-529 responses, using bounded backoff up to `LLM_MAX_RETRIES`. The default is two retries and the client enforces a hard maximum of five; it never retries indefinitely. Authentication, authorization, HTTP 408, client timeout, other 4xx, non-recoverable 5xx, and network errors are classified without retry. Batch label validation failures retain the existing per-paper fallback.

To roll back the generative provider, set `LLM_PROVIDER=openai-compatible`, restore the previous provider's `LLM_API_KEY`, base, and model values, and use `LLM_BASE_URL` (or the deprecated `LLM_API_BASE_URL` fallback). The workflow selects the legacy key for that explicit provider even if `NVIDIA_API_KEY` remains stored. No database migration or data rewrite is involved. Existing generated records retain their stored provider provenance.
