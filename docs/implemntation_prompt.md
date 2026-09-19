# Implementation Prompt

> **Classification: historical implementation prompt.** It is retained as provenance and must not override current integrated code, `AGENTS.md`, or the four canonical documents.

> **Scope correction (2026-09-19):** Local runtime and SQLite production proposals are abandoned under DPO-011. Do not revive them from this prompt; use GitHub-hosted jobs and the cloud services described in [current architecture](ARCHITECTURE.md).

You are a senior full-stack engineer working from an approved system design.

Now implement the MVP for the daily literature triage web app described in PROJECT.md, AGENT_RULES.md, docs/system_prompt.md, and docs/mvp_architecture_freeze.md.

Do not redesign the product from scratch.
Stay consistent with the approved architecture, schema, and module boundaries.

## Product Summary

This app is a daily personalized literature triage dashboard centered on a Zotero library.

It has two coupled pipelines:

### 1. Low-frequency profile pipeline
- sync Zotero metadata using ZOTERO_KEY and ZOTERO_ID
- let the user select collection priorities: primary / secondary / excluded
- allow subcollections to override parent collections
- build an editable active interest profile only from selected collections
- parse star tags into attention_level
- treat attention_level as the strongest item-level priority signal
- use recency as a weaker continuous signal
- treat `#` tags as structured content metadata
- batch-generate missing `#` tags for selected items during initial profile build

### 2. High-frequency daily recommendation pipeline
- fetch only papers that are new today from bioRxiv, arXiv, PubMed, and user-imported journal feeds
- normalize and deduplicate items
- enrich journal metadata if available
- generate structured candidate representation
- rank only the daily candidate set against the active profile
- show results in a dashboard
- store user edits and feedback as logs
- do not instantly overwrite the long-term profile

## Structured Tag Rules

Preserve two tag types:

### Tag 1
Content-recall label describing what the paper concretely does.

### Tag 2
Research-type label:
`Category | primary innovation keyword, secondary innovation keyword`

Category:
- method
- biology
- resource
- benchmark

Store these as structured fields where possible.

## Ranking Architecture

Use the approved MVP ranking approach:

- profile may use multiple centroids or prototypes
- use a two-stage ranking pipeline

### Stage 1: recall
Use lighter, high-recall signals:
- semantic similarity to active profile
- `#` tag content overlap
- research-type match
- source/category filtering

### Stage 2: rerank
Use richer features:
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

Keep reranking explainable and transparent for MVP.

## Technical Stack

Use:
- Next.js + TypeScript
- Prisma
- PostgreSQL or SQLite for MVP
- modular service design
- scheduled jobs
- environment variables

## Implementation Order

Generate the project in dependency order.

Start with:

1. project structure
2. Prisma schema
3. environment config and `.env.example`
4. shared types and utilities
5. Zotero sync module
6. collection selection and persistence
7. profile-building module
8. `#` tag parsing / generation interfaces
9. daily source ingestion modules
10. normalization and deduplication
11. ranking pipeline
12. feedback logging
13. API routes
14. basic UI pages
15. scheduled job examples
16. setup instructions

## Coding Constraints

- clearly separate profile-building logic from daily recommendation logic
- keep external integrations honest
- do not fake API behavior
- keep code readable and maintainable
- prefer runnable scaffolding over pseudo-code
- explain each module briefly before outputting code
- when a part depends on external credentials or unavailable APIs, implement the interface and mark the integration point clearly

## Output Style

Proceed incrementally.

For each step:
- explain what the module does
- explain why it comes at this stage
- then generate the code

Do not regenerate earlier modules unless necessary.
Do not change the schema silently.
