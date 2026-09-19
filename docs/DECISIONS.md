# Daily Paper decision log

This append-style log records accepted governance and architecture decisions. It does not replace the current-state ledger in `docs/PROJECT_STATE.md` or the implementation description in `docs/ARCHITECTURE.md`.

## DPO-001 — Authoritative integrated truth

- **Decision ID:** DPO-001
- **Date:** 2026-08-12
- **Status:** Accepted
- **Context:** Multiple local branches, worktrees, drafts, and uncommitted experiments made project state ambiguous.
- **Decision:** The latest remote `origin/master` is the only authoritative integrated code baseline. Workspace contents, local branches, draft PRs, archived experiments, and conversation claims are not integration evidence.
- **Rationale:** A remote, reviewable integration point gives every task a reproducible starting fact.
- **Consequences:** Every task begins by verifying remote master and classifying its workspace. Documentation conflicts are reconciled against current integrated code.
- **Evidence:** Approved Agent Operating Model v1; baseline `origin/master@7e4e4602ed06893b41d60e774722157f52697e0f`.
- **Supersedes:** Any practice that treated the active workspace as project truth.
- **Superseded by:** None.

## DPO-002 — Experimental archive boundary

- **Decision ID:** DPO-002
- **Date:** 2026-08-12
- **Status:** Accepted
- **Context:** `codex/cloud-mode-a` contains a mixture of an old base and uncommitted product and agent experiments.
- **Decision:** Classify `codex/cloud-mode-a` and its workspace as a read-only `EXPERIMENTAL_ARCHIVE`. Do not rebase, merge, repair, or revive it. Review and implement any retained idea individually from current master.
- **Rationale:** Wholesale migration would mix unverified experiments with missing or obsolete integrated code.
- **Consequences:** Archive presence never changes feature lifecycle. BM25, embeddings, evaluation, candidate quality, global identity, feedback, Obsidian, Windows, and agent experiments remain non-integrated unless independently merged later.
- **Evidence:** Repository baseline audit and approved Agent Operating Model v1.
- **Supersedes:** Treating `codex/cloud-mode-a` as an active development branch.
- **Superseded by:** None.

## DPO-003 — Separate lifecycle and production status

- **Decision ID:** DPO-003
- **Date:** 2026-08-12
- **Status:** Accepted
- **Context:** Code integration and runtime deployment/health are different facts.
- **Decision:** Track lifecycle as `PLANNED`, `EXPERIMENTAL`, `IN DEVELOPMENT`, or `INTEGRATED`; independently track production as `NOT_APPLICABLE`, `NOT_DEPLOYED`, `DEPLOYED`, `DEGRADED`, `ROLLED_BACK`, or `UNKNOWN`.
- **Rationale:** Code presence does not prove deployment, and a deployed capability may be degraded.
- **Consequences:** Production claims require runtime/deployment evidence. `RETIRED` is not introduced in v1; removal history remains in this log when needed.
- **Evidence:** Approved Agent Operating Model v1.
- **Supersedes:** Combined or implicit integrated/production state.
- **Superseded by:** None.

## DPO-004 — Three persistent roles

- **Decision ID:** DPO-004
- **Date:** 2026-08-12
- **Status:** Accepted
- **Context:** The archived agent design had several narrow permanent roles and no durable state owner.
- **Decision:** Maintain only Primary / Coordinator, Integration Reviewer, and Statekeeper / Historian as persistent project roles. Primary is defined by `AGENTS.md`; the two other roles are project custom agents.
- **Rationale:** Coordination, independent review, and project memory persist across phases; subsystem implementation does not need permanent identities.
- **Consequences:** Reviewer stays read-only. Statekeeper may edit canonical docs only during an explicitly authorized post-integration update.
- **Evidence:** Approved Agent Operating Model v1; `.codex/agents/**`.
- **Supersedes:** The archived five-agent topology.
- **Superseded by:** None.

## DPO-005 — Bounded specialist strategy

- **Decision ID:** DPO-005
- **Date:** 2026-08-12
- **Status:** Accepted
- **Context:** Permanent agents for every subsystem create overlap and stale ownership.
- **Decision:** Invoke ingestion, ranking, feedback, database, production, UI, and portability/configuration specialists only for bounded tasks against frozen contracts.
- **Rationale:** Domain expertise is task-dependent; global state ownership must remain with persistent roles.
- **Consequences:** Specialists use structured handoffs and never update canonical project state independently.
- **Evidence:** Approved Agent Operating Model v1; `AGENTS.md`.
- **Supersedes:** Permanently growing subsystem agent inventories.
- **Superseded by:** None.

## DPO-006 — GitHub-centered integration model

- **Decision ID:** DPO-006
- **Date:** 2026-08-12
- **Status:** Accepted
- **Context:** Durable engineering state must survive local workspaces and conversations.
- **Decision:** Formal changes follow branch/worktree → implementation → independent review → PR → merge to master → state reconciliation.
- **Rationale:** GitHub provides durable refs, reviews, CI, and merge evidence around the authoritative branch.
- **Consequences:** Scratch reasoning and temporary experiments are not automatically committed. A PR is not integrated until its result reaches master.
- **Evidence:** Approved Agent Operating Model v1.
- **Supersedes:** Conversation- or workspace-centered project synchronization.
- **Superseded by:** None.

## DPO-007 — Post-integration Statekeeper reconciliation

- **Decision ID:** DPO-007
- **Date:** 2026-08-12
- **Status:** Accepted
- **Context:** Parallel workers updating state continuously would race with review and merge outcomes.
- **Decision:** Run Statekeeper after the integration checkpoint and after production verification where applicable.
- **Rationale:** Canonical state should describe authoritative facts, not intermediate implementation intent.
- **Consequences:** Statekeeper never marks pre-merge work integrated. Evidence gaps remain `UNKNOWN`.
- **Evidence:** Approved Agent Operating Model v1.
- **Supersedes:** Continuous state edits by feature workers.
- **Superseded by:** None.

## DPO-008 — Phase-oriented engineering work

- **Decision ID:** DPO-008
- **Date:** 2026-08-12
- **Status:** Accepted
- **Context:** One long conversation cannot reliably serve as identity, state ledger, and implementation history.
- **Decision:** Organize work by engineering phase or problem. A phase may use several agents and conversations; a conversation is not an agent identity.
- **Rationale:** Phase contracts and canonical documents preserve continuity without relying on chat history.
- **Consequences:** Each phase has baseline, scope, dependencies, ownership, and exit evidence.
- **Evidence:** Approved Agent Operating Model v1.
- **Supersedes:** One-conversation-equals-one-agent assumptions.
- **Superseded by:** None.

## DPO-009 — Bounded concurrency and one writer

- **Decision ID:** DPO-009
- **Date:** 2026-08-12
- **Status:** Accepted
- **Context:** Parallel writes to shared contracts, schemas, and canonical state create hidden semantic and merge conflicts.
- **Decision:** Permit parallel work only after shared contracts are frozen and ownership is disjoint. Use one active writer per file and no more than three concurrent subagent threads by default.
- **Rationale:** Parallelism should reduce latency without fragmenting ownership.
- **Consequences:** Schema/migrations, public contracts, shared agent configuration, canonical docs, ranking-stage semantics, review/merge, and production verification retain serial gates.
- **Evidence:** Approved Agent Operating Model v1; `.codex/config.toml`.
- **Supersedes:** Unbounded or overlapping parallel editing.
- **Superseded by:** None.

## DPO-010 — Reduced canonical documentation model

- **Decision ID:** DPO-010
- **Date:** 2026-08-12
- **Status:** Accepted
- **Context:** README, historical prompts, plans, and audits previously duplicated current-state claims.
- **Decision:** Use `PROJECT_STATE.md`, `ARCHITECTURE.md`, `ROADMAP.md`, and `DECISIONS.md` as the canonical documentation set. README is an entry point; other documents are historical, design, audit, or operational references.
- **Rationale:** Each kind of fact has one maintained home.
- **Consequences:** Existing documents are retained but must not independently assert current project state.
- **Evidence:** Approved Agent Operating Model v1.
- **Supersedes:** Multiple independent status ledgers.
- **Superseded by:** None.

## DPO-011 — Cloud-only operation and Local Mode retirement

- **Decision ID:** DPO-011
- **Date:** 2026-09-19
- **Status:** Accepted user direction; formal architecture freeze delivered through [PR #44](https://github.com/linyuan701/daily-paper/pull/44), whose merge record is the integration evidence.
- **Context:** Local installation, SQLite, Windows scheduling, and Obsidian proposals remained mixed into current documentation despite the GitHub/cloud production path. The user explicitly confirmed that the whole supported flow should use GitHub execution and network dependencies, with local-dependent flows treated as abandoned plans.
- **Decision:** Use GitHub-hosted Actions for background jobs, network integrations, and CI. Retain Cloudflare Workers/Access for online dashboard and short APIs and PostgreSQL/Neon for persistence. Retire user-PC/local runtime support, Windows installation/migration/scheduling, SQLite production storage/parity, Zotero Local API, desktop notifications, and Obsidian filesystem workflows. No self-hosted runner or local fallback is a supported production dependency.
- **Rationale:** The service must keep operating without the owner's computer, local files, or installed desktop applications. Runtime and provider failures should be diagnosed from cloud evidence.
- **Consequences:** README and agent/reviewer scope now point to the cloud path. Local code, applied migration history, and disposable CI fixtures may remain until reviewed cleanup; their presence does not imply support. No user data, existing local tasks, installed software, or production state is deleted or modified by this decision. The integrated Worker workflow only builds/previews. PR #45's Site and PR #47's release/rollback implementations remain unmerged as of 2026-09-20 and are not deployed or integrated by this architecture freeze. The decision does not automatically close the arXiv issue.
- **Evidence:** User direction in this task on 2026-09-19; `origin/master@d8552a0468a5970ee530195726f6c96e04b286b3`; `.github/workflows/daily.yml`, `.github/workflows/profile.yml`, `.github/workflows/cloudflare-preview.yml`, `wrangler.jsonc`; production daily run [#35421549513](https://github.com/linyuan701/daily-paper/actions/runs/35421549513).
- **Supersedes:** Local Mode support/default/recovery recommendations in the old README and Cloud Mode A design/migration documents, and the former continuing SQLite/PostgreSQL product-parity requirement. DPO-002's archive protection and DPO-003's integration/production distinction still apply; support retirement does not create a new lifecycle value.
- **Superseded by:** None.
