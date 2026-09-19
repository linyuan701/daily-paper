# System Design Prompt

> **Classification: historical design prompt.** It is retained as provenance, not current project state or architecture. See `docs/PROJECT_STATE.md` and `docs/ARCHITECTURE.md`.

> **Scope correction (2026-09-19):** Local runtime and SQLite production proposals are abandoned under DPO-011. Do not revive them from this prompt; use GitHub-hosted jobs and the cloud services described in [current architecture](ARCHITECTURE.md).

You are a senior full-stack engineer and AI product architect.

Help design an MVP for a daily literature triage web app centered on a Zotero library.

Do not generate a huge amount of implementation code yet.
First freeze the system design, architecture, schema, and module boundaries.

## Product Goal

This app is not a general academic search engine.

Its purpose is to help the user discover papers that are newly published, newly updated, or newly indexed today, and rank them by how likely the user is to care about them.

The system has two coupled pipelines:

1. a low-frequency Zotero-based profile pipeline
2. a high-frequency daily recommendation pipeline

## Core Logic

Do not treat the full Zotero library as a flat corpus of equal relevance.

The correct flow is:

- lightweight Zotero sync
- user selects collection priorities
- active profile is built only from selected collections
- star tags become attention_level
- attention_level almost overrides recency
- recency is a secondary continuous signal
- `#` tags are structured content metadata
- selected items without `#` tags use title + abstract fallback
- missing `#` tags are batch-generated during initial profile build

Collections must support:
- primary
- secondary
- excluded

Subcollections must be allowed to override parent collection states.

## Structured Tag Semantics

Preserve two structured tag types:

### Tag 1
Content-recall label:
- method/framework name
- biological object or regulatory layer
- distinctive output form

### Tag 2
Research-type label:
`Category | primary innovation keyword, secondary innovation keyword`

Category:
- method
- biology
- resource
- benchmark

These should be stored as structured metadata where possible.

## Profile Pipeline

The low-frequency profile pipeline should:
- run on initial setup
- support manual refresh
- support scheduled refresh
- remind the user once per month by default

The output should contain:
- recent core interests
- stable long-term interests
- low-confidence or task-specific background interests
- preferred research types
- collection-aware weights
- attention-aware weights
- profile centroids or prototypes if useful
- user correction metadata
- refresh metadata

## Daily Recommendation Pipeline

The high-frequency daily pipeline should:
- fetch only papers new today
- normalize metadata
- deduplicate items
- enrich journal metadata if available
- generate structured candidate representation
- rank the daily candidate set against the active profile
- show results in a dashboard
- store user feedback without instantly rewriting the long-term profile

Candidate sources:
- bioRxiv
- arXiv
- PubMed
- selected journal feeds

For preprints:
- use user-selected broad category scopes
- do not search the full source without limits

For journals:
- start with user-imported journal pools
- leave an open interface for future automatic import or external curated collections
- support external journal metric enrichment such as EasyScholar

## Ranking Design

Do not rank daily papers by flat average similarity against the whole Zotero library.

For MVP, prefer:
- profile represented by multiple centroids or prototypes if useful
- two-stage ranking
- explainable reranking

### Stage 1: recall
Possible signals:
- semantic similarity to active profile
- `#` tag overlap
- research-type match
- source/category filtering

### Stage 2: reranking
Possible signals:
- similarity to recent core profile
- similarity to stable long-term profile
- similarity to high-attention items
- content-recall tag match
- research-type preference match
- collection-derived profile weight
- user-corrected tag or keyword match
- source priority
- journal quality metrics
- optional same-day recency refinement

Prefer transparent linear or semi-linear reranking for MVP.

## AI Output

For top-ranked daily papers, generate:
1. a concise structured summary including research question, method, main finding, and why it matters to the user’s interests
2. structured editable topic labels using the same style as the Zotero `#` tag schema where possible

User edits should first be stored as feedback logs.
They should influence the profile later during profile refresh, not instantly.

## UI Expectations

The UI should support:
- Zotero connection
- collection selection
- subcollection override
- profile refresh control
- daily dashboard
- source/category display
- summary display
- editable structured tags
- visible recommendation reasons
- feedback actions such as save, dismiss, promote, or tag correction

## Data Model Expectations

Keep these concepts separate:
- raw Zotero items
- collection hierarchy
- collection priority state
- attention_level
- structured content tags
- structured research-type tags
- profile snapshots
- daily candidate papers
- source metadata
- journal enrichment metadata
- recommendation results
- feedback logs
- profile refresh jobs

## Technical Preferences

Prefer:
- Next.js + TypeScript
- Prisma
- PostgreSQL or SQLite for MVP
- modular service design
- scheduled jobs
- environment-based configuration

## What to Output

Please do the following in order:

1. Restate the MVP scope in clear engineering terms.
2. Propose the architecture and data flow for the two-pipeline system.
3. Propose the database schema in detail.
4. Propose the project folder structure.
5. Propose the ranking architecture in detail.
6. Identify tradeoffs, ambiguities, and likely failure points.
7. Clearly mark which decisions are frozen for MVP and which are left open for extension.

Do not generate the full implementation yet.
