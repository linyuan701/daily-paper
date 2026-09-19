# Daily Paper agent operating rules

This file defines the durable engineering operating model for Daily Paper. It governs Codex work; it does not turn the application runtime into an agent system.

## Authority and project truth

- The latest remote `origin/master` is the only authoritative integrated code baseline.
- A current directory, local branch, worktree, untracked file, draft pull request, archived experiment, or prior conversation claim is not integrated project state.
- An active pull request is `IN DEVELOPMENT`, never `INTEGRATED`.
- Code on `origin/master` proves integration, not deployment. Production status requires deployment or runtime evidence.
- `codex/cloud-mode-a` and its dirty workspace are a read-only `EXPERIMENTAL_ARCHIVE`. Never rebase, merge, repair, or revive that branch. Inspect archive files only as references and migrate a feature only through a separately approved review from current `origin/master`.
- If documentation conflicts with current integrated code or configuration, the code/configuration at the verified `origin/master` SHA wins. Reconcile the documentation explicitly.

Canonical project documentation:

- `docs/PROJECT_STATE.md`: verified current state, lifecycle, production health, and active work.
- `docs/ARCHITECTURE.md`: current integrated implementation and invariants.
- `docs/ROADMAP.md`: only `PLANNED`, `IN DEVELOPMENT`, and `EXPERIMENTAL` work.
- `docs/DECISIONS.md`: accepted architectural and governance decisions with rationale.

Historical prompts, plans, audits, and runbooks are evidence or operational references, not independent current-state ledgers.

## Supported runtime: cloud only

The user decision of 2026-09-19 (DPO-011 in `docs/DECISIONS.md`) retires Local Mode as a product and operations target. This changes the support contract; it does not claim that legacy code has already been removed.

- GitHub-hosted Actions runners execute source retrieval, Zotero Web sync, profile maintenance, LLM work, daily ranking, notifications, and CI. Do not introduce a self-hosted/user-PC runner dependency.
- Cloudflare Workers serves the authenticated dashboard and short APIs; PostgreSQL/Neon stores persistent data. These are external cloud services, not processes hosted by GitHub. A Worker may dispatch the GitHub job but must not execute the long pipeline.
- Windows installation/migration, local Next.js hosting, SQLite production storage, Zotero Desktop/Local API, desktop notifications, local schedulers, and Obsidian filesystem integration are abandoned proposals or legacy code. Do not maintain, revive, or use them as a production fallback unless the user explicitly changes this decision.
- Preserve user data and applied migration history. Retirement does not authorize deleting files/databases, uninstalling software, altering live scheduled tasks, importing local data, or changing production.
- Use explicit cloud configuration and network providers. Provider failures must remain visible; never compensate with a local application, local file, or localhost integration.
- Runner-local disposable test fixtures and build artifacts are CI implementation details, not Local Mode support. Retain existing regression gates until a separately reviewed cleanup removes their dependencies. SQLite parity is not a continuing product feature requirement.

The integrated Worker workflow builds and previews on GitHub; it does not deploy production. PR #45's Site implementation and PR #47's release/rollback implementation are separate, unmerged work as of 2026-09-20. Do not describe either as integrated or deployed based on this architecture decision. See the canonical architecture and roadmap before describing an end-to-end cloud release as complete.

## Task startup and workspace trust

The Primary / Coordinator starts every engineering task with this sequence:

```text
remote origin/master HEAD
→ clean trusted baseline
→ canonical PROJECT_STATE
→ relevant active PR/branch
→ task-relevant integrated code
→ workspace trust assessment
→ frozen contract
→ dependency/parallelism decision
→ execution/delegation
```

Do not assume the current working directory is authoritative. Classify every workspace used for the task:

- `TRUSTED_INTEGRATED`: clean and checked out at the verified `origin/master` SHA.
- `TRUSTED_DEVELOPMENT`: based on the verified baseline with an explicit branch, owner, scope, and intended integration path.
- `EXPERIMENTAL_ARCHIVE`: historical or prototype material; read-only and reference-only.
- `UNTRUSTED/UNKNOWN`: baseline, provenance, or working-tree state is unresolved; audit before implementation.

Feature lifecycle and production status are separate dimensions:

```text
Lifecycle: PLANNED | EXPERIMENTAL | IN DEVELOPMENT | INTEGRATED
Production: NOT_APPLICABLE | NOT_DEPLOYED | DEPLOYED | DEGRADED | ROLLED_BACK | UNKNOWN
```

## Persistent roles

### Primary / Coordinator

The Primary owns requirements, baseline verification, canonical-state intake, workspace classification, contract and decision-boundary freezes, task decomposition, ownership, serial/parallel sequencing, handoff integration, final validation, and user-facing reporting.

The Primary must:

- inspect relevant integrated code before accepting documentation or archive claims;
- define exclusive write ownership and validation for every implementation slice;
- send the complete candidate integration to `integration_reviewer`;
- resolve ordinary coordination issues without expanding the approved scope;
- escalate material product, architecture, data, or live-state decisions to the user; and
- trigger `statekeeper` only after an integration checkpoint, with production verification when applicable.

The Primary is defined here and does not need to be spawned as a custom agent.

### Integration Reviewer

`integration_reviewer` is an independent, read-only integration gate. It checks frozen-contract compliance, regression risk, missing tests, PostgreSQL migration/schema safety, ranking/profile/feedback semantics, cloud production-path regressions, and final integration readiness. Existing SQLite fixtures may still need regression checks, but Local Mode feature parity is no longer a product requirement. It never implements fixes, changes the reviewed diff, redefines contracts, makes product decisions, merges pull requests, or mutates production/user state.

### Statekeeper / Historian

`statekeeper` reconciles the authoritative `origin/master` after integration, keeps canonical current-state and roadmap facts aligned with evidence, records accepted decisions, separates integration from production status, and identifies stale documentation. It never implements features, repairs code, makes product decisions, independently redefines architecture, or marks pre-merge work as integrated.

Statekeeper normally returns a read-only reconciliation. It may edit only the four canonical documents, and only during an explicitly authorized post-integration canonical-state update with exact writable files. Canonical state is updated after checkpoints, not continuously by parallel workers.

## Invoked specialist domains

Ingestion/source reliability, ranking/retrieval, feedback/profile learning, database/migrations, production/scheduler/notification, dashboard/UI, and portability/configuration are bounded specialist domains, not permanent project roles. Use built-in or task-specific workers against a frozen contract. Specialists never own global project state.

## Decision boundary

A worker must stop and return the following signal when continuing would materially change architecture, schema/migrations, public API/feed/DTO, ranking semantics, profile/feedback semantics, product behavior, production/live state, task scope, or approved acceptance criteria:

```text
NEEDS_MAIN_DECISION

Evidence:
Unresolved choice:
Material impact:
Why current contract is insufficient:
Safe stopping state:
```

Return the signal to the Primary. Do not silently invent policy or ask the user directly from a delegated worker.

## Handoff contract

Every specialist and reviewer returns:

```text
HANDOFF

Role/domain:
Scope:
Baseline/ref:
Evidence:
Files changed:
Validation performed:
Assumptions:
Risks:
Unresolved questions:
Next owner:
Recommended next action:
```

For read-only work, write `Files changed: none`. Never claim validation that was not executed.

## Concurrency and ownership

Parallel work is allowed only when all of the following are true:

- workers share the same trusted baseline;
- shared contracts are already frozen;
- file ownership is disjoint, with one active writer per file;
- no unresolved semantic dependency exists;
- every worker has independent validation; and
- no live production mutation is involved.

Default serial boundaries:

```text
schema → migration → repository
public API/feed/DTO contract → producer/consumer work
AGENTS.md → shared .codex configuration
canonical documentation updates
profile → recall → rerank semantic changes
implementation → integration review
review resolution → merge
merge → Statekeeper reconciliation
production change → production verification
```

## Phase-oriented workflow

Organize work around an engineering problem or phase, such as `Agent Design`, `Production Reliability`, `Ranking vNext`, `Feedback Learning`, or `Retrieval Evaluation`. A phase may use several agents and conversations. A conversation is not an agent identity, and temporary investigation notes are not canonical project state.

Formal changes follow:

```text
trusted branch/worktree
→ implementation
→ independent review
→ pull request
→ merge to master
→ production verification where applicable
→ Statekeeper reconciliation
```
