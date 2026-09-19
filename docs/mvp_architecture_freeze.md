# MVP Architecture Freeze (DAI-20)

> **Classification: historical architecture baseline.** Its original source-of-truth claim is superseded. Current integrated architecture is documented in `docs/ARCHITECTURE.md`, with current state in `docs/PROJECT_STATE.md`.

> **Scope correction (2026-09-19):** DPO-011 retires Local Mode and SQLite production support. The provider-switching and local-runtime proposals below are historical, not current setup or acceptance requirements. See [current architecture](ARCHITECTURE.md).

This document freezes the MVP architecture, data model, and module boundaries for the daily literature triage app.
It is the source of truth for implementation issues that follow.

## 1) MVP Scope (Engineering Restatement)

### In scope (MVP)
- Single-user web app (future multi-user compatible schema).
- Two separate but coupled pipelines:
  - low-frequency Zotero profile pipeline
  - high-frequency daily recommendation pipeline (today-only candidates)
- Zotero sync and collection-priority selection (`primary`, `secondary`, `excluded`) with subcollection override.
- Interest profile construction only from selected collections.
- Star-tag parsing to `attention_level` (stronger than recency).
- Structured `#` tag handling with fallback to `title + abstract` when missing.
- Initial batch generation interface for missing `#` tags on selected items.
- Daily ingestion from bioRxiv, arXiv, PubMed, and user-imported journals.
- Normalize + deduplicate + rank + explain + summarize top candidates.
- Feedback logging and delayed integration during profile refresh.

### Out of scope (MVP)
- Full automatic journal pool discovery.
- Fully online profile rewriting on each user action.
- Complex black-box ranking models that reduce explainability.
- Multi-tenant auth/permissions beyond a single-user deployment.

## 2) Two-Pipeline Architecture and Data Flow

### A. Low-frequency profile pipeline
1. Trigger: first setup, manual refresh, or scheduled refresh.
2. Pull lightweight Zotero metadata into raw tables.
3. Build/refresh collection tree and persisted priority overrides.
4. Select profile source items: only `primary`/`secondary` effective collections.
5. Parse star-like tags into numeric `attention_level`.
6. Resolve content representation:
   - if structured `#` tags exist -> use parsed structured fields
   - otherwise -> fallback to `title + abstract`
7. Queue optional missing-tag generation jobs for selected items.
8. Build profile snapshot with multiple subprofiles:
   - recent core interests
   - stable long-term interests
   - background/low-confidence interests
   - research-type preference distribution
9. Persist snapshot as active profile version.

### B. High-frequency daily recommendation pipeline
1. Trigger: scheduled (e.g., daily), optional manual run.
2. Ingest today-only candidates from configured sources.
3. Normalize source-specific metadata into canonical candidate records.
4. Deduplicate candidates across sources.
5. Enrich journal metadata when available (optional integration).
6. Generate candidate structured representation (summary + labels).
7. Rank candidates against current active profile:
   - Stage 1 recall
   - Stage 2 explainable rerank
8. Persist ranked results + per-feature explanations.
9. Serve dashboard and collect feedback logs (save/dismiss/promote/tag edits).

### Coupling contract between pipelines
- Daily pipeline is read-only on long-term profile data.
- Daily feedback writes to logs, not directly to profile features.
- Profile pipeline reads feedback logs during refresh and produces the next profile snapshot.

## 3) Database Schema (MVP Proposal)

The schema keeps product concepts separate and versioned.

### Core user/config tables
- `user`
  - `id`, `created_at`, `updated_at`
- `app_settings`
  - `user_id`, `timezone`, `default_profile_refresh_interval_days`, `default_daily_run_time`
- `source_config`
  - `user_id`, `source` (`biorxiv|arxiv|pubmed|journal`), `enabled`, `scope_json`

### Zotero sync and collection boundary tables
- `zotero_item_raw`
  - `id`, `user_id`, `zotero_item_key`, `title`, `abstract`, `authors_json`, `published_at`, `added_at`, `source_payload_json`, `last_synced_at`
  - unique: (`user_id`, `zotero_item_key`)
- `zotero_collection`
  - `id`, `user_id`, `zotero_collection_key`, `name`, `parent_collection_id`, `path`
  - unique: (`user_id`, `zotero_collection_key`)
- `zotero_item_collection`
  - `item_id`, `collection_id`
  - unique: (`item_id`, `collection_id`)
- `collection_priority_state`
  - `id`, `user_id`, `collection_id`, `priority` (`primary|secondary|excluded`), `is_explicit_override`
  - unique: (`user_id`, `collection_id`)
- `zotero_item_signal`
  - `item_id`, `attention_level`, `parsed_star_tag`, `has_structured_tags`, `signal_version`

### Structured tag tables
- `item_content_tag`
  - `id`, `item_id`, `label`, `origin` (`imported|ai_generated|user_edited`), `created_at`
- `item_research_tag`
  - `id`, `item_id`, `category` (`method|biology|resource|benchmark`), `primary_keyword`, `secondary_keyword`, `origin`, `created_at`
- `tag_generation_job`
  - `id`, `user_id`, `item_id`, `status`, `error`, `requested_at`, `completed_at`

### Profile versioning tables
- `profile_snapshot`
  - `id`, `user_id`, `status` (`active|superseded|failed`), `created_at`, `source_sync_at`, `notes`
- `profile_subvector`
  - `id`, `snapshot_id`, `segment` (`recent_core|stable_long_term|background`), `representation_json`, `weight`
- `profile_research_preference`
  - `id`, `snapshot_id`, `category`, `weight`, `keywords_json`
- `profile_build_job`
  - `id`, `user_id`, `snapshot_id`, `trigger` (`initial|manual|scheduled`), `status`, `started_at`, `finished_at`, `error`

### Daily candidate and ranking tables
- `daily_ingest_run`
  - `id`, `user_id`, `run_date`, `status`, `started_at`, `finished_at`, `error`
  - unique: (`user_id`, `run_date`)
- `daily_candidate_raw`
  - `id`, `run_id`, `source`, `external_id`, `payload_json`, `retrieved_at`
  - unique: (`run_id`, `source`, `external_id`)
- `daily_candidate`
  - `id`, `run_id`, `canonical_key`, `title`, `abstract`, `published_at`, `is_preprint`, `journal_name`, `doi`, `pmid`, `metadata_json`
  - unique: (`run_id`, `canonical_key`)
- `journal_metric`
  - `id`, `journal_name`, `provider`, `quartile`, `impact_score`, `updated_at`
- `candidate_representation`
  - `id`, `candidate_id`, `content_label`, `research_category`, `primary_keyword`, `secondary_keyword`, `embedding_ref`
- `ranking_result`
  - `id`, `run_id`, `candidate_id`, `profile_snapshot_id`, `recall_score`, `rerank_score`, `final_score`, `rank_position`, `reason_json`
  - index: (`run_id`, `rank_position`)
- `candidate_summary`
  - `id`, `candidate_id`, `research_question`, `method`, `main_finding`, `why_relevant`, `version`

### Feedback and delayed profile learning tables
- `user_feedback`
  - `id`, `user_id`, `candidate_id`, `run_id`, `feedback_type` (`save|dismiss|promote|tag_edit`), `payload_json`, `created_at`
- `profile_feedback_consumption`
  - `id`, `snapshot_id`, `feedback_id`, `applied_at`
  - unique: (`snapshot_id`, `feedback_id`)

### Recommended MVP indexes
- Zotero item lookup by `added_at`, and collection join indexes.
- Daily candidate lookup by `run_id`, `published_at`, `canonical_key`.
- Ranking read path: (`run_id`, `rank_position`).
- Feedback aggregation: (`user_id`, `created_at`, `feedback_type`).

## 4) Module Boundaries and Project Structure

Use Next.js + TypeScript + Prisma with explicit service boundaries.

```
src/
  app/                       # Next.js pages/routes
  api/                       # Route handlers only (thin layer)
  modules/
    zotero-sync/             # external Zotero pull + raw persistence
    collections/             # tree, overrides, effective priority resolver
    profile-build/           # profile pipeline orchestration
    tagging/                 # parse # tags + generation interface
    ingestion/               # source connectors (arXiv/bioRxiv/PubMed/journals)
    normalize-dedupe/        # canonicalization + duplicate merge
    candidate-enrich/        # journal metrics + structured candidate fields
    ranking/
      recall/                # stage-1 recall scoring/filtering
      rerank/                # stage-2 explainable fusion
      explain/               # reason extraction for UI
    summary/                 # structured summary generation
    feedback/                # feedback logging and query
    scheduler/               # job triggers and run state
  db/
    prisma/                  # schema and migrations
    repositories/            # data-access abstractions
  lib/
    config/                  # env validation and config
    types/                   # shared types
    logging/                 # structured logs
```

Boundary rules:
- `api` cannot contain ranking/profile business logic.
- `ranking` reads profile snapshots; it does not mutate profile tables.
- `feedback` does not update active profile directly.
- Integrations are behind interfaces (`ingestion`, `candidate-enrich`, `tagging`).

## 5) Ranking Architecture (Frozen for MVP)

### Stage 1: recall (high recall, low latency)
- Inputs:
  - active profile snapshot
  - daily candidate representations
- Signals:
  - semantic similarity (candidate vs profile subvectors)
  - content-tag overlap
  - research-type/category match
  - source/category scope filters
- Output:
  - top-K candidate ids + recall features for stage 2

### Stage 2: rerank (explainable linear fusion)
- Features (normalized):
  - sim to recent core profile
  - sim to stable long-term profile
  - sim to high-attention historical items
  - content-recall label match
  - research-type preference match
  - collection-derived profile weight proxy
  - user-corrected keyword/tag boosts
  - source priority prior
  - journal quality score (if available)
  - same-day recency refinement (small weight)
- Scoring:
  - weighted linear/semi-linear score
  - persist feature contribution per candidate for explanation
- Output:
  - ordered recommendations with reason codes for UI

## 6) Tradeoffs, Failure Points, and Ambiguities

### Key tradeoffs
- Explainability vs peak ranking accuracy:
  - MVP freezes on explainable reranking.
- Freshness vs profile stability:
  - feedback is delayed to refresh-time integration.
- Schema strictness vs integration variability:
  - keep raw payload storage plus normalized canonical tables.

### Likely failure points
- Source ingestion instability (rate limits / schema drift).
- Dedup collisions across DOI/PMID/arXiv IDs.
- Missing abstracts or noisy metadata reducing ranking quality.
- Star-tag parsing inconsistency from non-standard user tags.
- Low-quality AI tag generation for edge-case papers.

### MVP mitigations
- Persist raw payloads for replay and parser improvements.
- Keep deterministic canonical-key strategy + override hooks.
- Use fallback text-based representation when tags are missing.
- Track job errors and partial failures per run.

## 7) Frozen Decisions vs Extension Points

### Frozen for MVP
- Two distinct pipelines with delayed feedback integration.
- Daily ranking applies only to today-only candidate set.
- Collection priority (`primary|secondary|excluded`) with subcollection override.
- `attention_level` parsed from star tags and weighted above recency.
- Two-stage ranking with explainable rerank.
- Structured storage for two `#` tag types.
- Profile snapshot versioning and active snapshot read model.

### Extension points (explicitly open)
- Swap SQLite/PostgreSQL by environment.
- Alternative embedding provider and vector storage strategy.
- Additional sources and journal-quality providers.
- More advanced reranking model after explainability baseline.
- Multi-user auth and tenant isolation.
