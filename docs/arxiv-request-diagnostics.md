# arXiv request diagnosis and recovery

This patch is based on `d8552a0468a5970ee530195726f6c96e04b286b3`. The September 13–15, 2026 cloud daily runs reported `ARXIV_API_ERROR`, `stage=request`, and `failureCategory=timeout`. Those old records cannot distinguish client deadlines from HTTP 408, or identify the affected page. This change improves reliability and the evidence available on subsequent executions; fixture tests do not establish production recovery.

## Request behavior

- All arXiv attempts in one process share a serial queue. A new request waits at least three seconds after the previous attempt finishes, including its response body. Retries use the same queue; a short or zero `Retry-After` cannot bypass it.
- Each arXiv deadline covers headers and the complete text body. Retryable response bodies are cancelled before retrying. The existing retry count and bounded `Retry-After` handling remain in place.
- Category queries, per-category pagination, successful-watermark filtering, and pipeline outcomes are preserved. A transient page failure retries that page while retaining earlier pages in memory. If retries are exhausted, the source still fails and its watermark does not advance. Returning incomplete results as success would silently skip missing papers.
- Serialization is process-local. It is not a distributed rate limiter across independent machines. Existing daily execution guards still apply.

## Read the evidence

Each `arXiv HTTP attempt` log includes `categoryIndex` (one-based position in the configured category list), `page` (one-based), `start`, `attempt`, `timeoutMs`, `elapsedMs`, `requestPhase`, `outcome`, and available `httpStatus` / `transportCode`. The fixed endpoint host is `export.arxiv.org`.

The terminal `Daily arXiv source ingestion failed` record also persists these bounded fields in the ingestion stage's source diagnostic. Here `attempts` is the total attempts on the failed page, `elapsedMs` includes that page's queue/backoff waits, and `attemptElapsedMs` measures only the final network/body attempt. Attempt logs measure only that attempt, excluding queue and backoff time.

| Evidence | Interpretation |
| --- | --- |
| `outcome=timeout`, `requestPhase=headers`, no HTTP status | Client deadline before response headers, or a transport timeout reported by the fetch implementation |
| `outcome=timeout`, `requestPhase=body`, HTTP 200 | Headers arrived, but the body did not finish within the deadline |
| `outcome=http`, HTTP 408 | Server returned an HTTP timeout response |
| HTTP 429 | Explicit rate limiting; inspect retries and spacing |
| HTTP 5xx | Upstream service error |
| `outcome=network`, allow-listed `transportCode` | Transport evidence such as DNS lookup failure or connection reset |

No raw query, configured category string, response body, headers, private address, or exception message is included. Transport codes are selected from a fixed allow-list; unknown codes are omitted. Existing persisted diagnostics remain readable because new fields are optional.

## Configuration and verification

The production daily workflow now passes the existing variables into the job with unchanged defaults: `ARXIV_MAX_PAGES=3`, `ARXIV_RETRY_BACKOFF_MS=15000`, `ARXIV_RETRY_AFTER_CAP_MS=120000`, and `SOURCE_HTTP_TIMEOUT_MS=20000`. No production variable is changed by editing the workflow. The three-second queue interval is fixed. Avoid increasing request volume or narrowing date filters without verifying watermark and revised-paper coverage.

Validate locally with fixture-based ingestion/HTTP tests, workflow tests, the full test suite, and typecheck. After an authorized integration, inspect a naturally scheduled daily run: request diagnostics should show the new fields, and any arXiv failure must remain explicit. A green GitHub run or delivered email alone is not evidence of source recovery. Do not rerun ingestion, update watermarks, or resend notifications as a diagnostic probe without explicit authorization.
