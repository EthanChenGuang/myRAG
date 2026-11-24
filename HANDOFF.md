# HANDOFF — Phase 3 (PAUSE-96 → Claude Code)

**Branch:** `claude/ecstatic-hamilton-86gtwv` (push only; no PR)  
**Trunk at pause:** `201b66b` (2026-11-24 ~13:48 Europe/Rome)  
**Takeover:** **Claude Code** with GSD in `.claude/` — start with `/gsd-resume-work` and `.planning/CLAUDE-CODE-HANDOFF-PROMPT.md`

## PAUSE-96 status

- **No spawns** at pause (including `03-48-sec-rpc-2`).
- **No half-merges.**
- Executors **STOPPED**; WIP pushed:

| Plan | Branch | WIP commit | Patch |
|------|--------|------------|-------|
| 03.1-25 | `exec/03.1-25` | `7c5f7f8` | `.planning/paused/patches/03.1-25.patch` |
| 04-18 | `exec/04-18` | `258a14f` | `.planning/paused/patches/04-18.patch` |
| 04-20 | `exec/04-20` | `b5e47fe` | `.planning/paused/patches/04-20.patch` |
| 03-48-setup-idempotent | `exec/03-48-setup-idempotent` | `d1c5821` | `.planning/paused/patches/03-48-setup-idempotent.patch` |

Cursor bcIds: `bc-1f542e8a`, `bc-78743196`, `bc-36e7beb3`, `bc-b37c0b7a` (+ push nudges `bc-8f62493e`, `bc-ca34e9a0`) — assume **stopped**.

**Machine state:** `.planning/HANDOFF.json`, `.planning/.continue-here.md`

## UI / frontend (Guang)

Enforced pipeline (both runtimes): **gsd-ui-phase** → **frontend-design** → **Impeccable** → **web-design-guidelines** → **gsd-ui-review** → verify (+ SUMMARY gate).

| Layer | Cursor | Claude Code takeover |
|-------|--------|----------------------|
| Skills | `.cursor/skills/{frontend-design,impeccable,web-design-guidelines}` | `.claude/skills/` (same SHAs) |
| Pipeline doc | `.cursor/gsd-core/references/frontend-design-*.md` | `.claude/gsd-core/references/frontend-design-*.md` |
| Rule | `.cursor/rules/frontend-design.mdc` | `.claude/rules/frontend-design.mdc` |
| Gate | `scripts/ci/check-frontend-design-summary.mjs` | same (verifier BLOCKER) |
| Config | `.planning/config.json`: `workflow.ui_phase`, `ui_safety_gate`, `ui_review`; `agent_skills` on ui-researcher / executor / ui-auditor / verifier |

Index: `.cursor/skills/FRONTEND-SKILLS.md`

## Claude Code takeover

When Cursor credits run out, continue on **Claude Code** with GSD **1.22.0** in `.claude/` only — do **not** run `.claude/` GSD hooks from Cursor (no `.claude/settings.json` hook changes; avoids double execution).

- Skills and SHAs are duplicated under `.claude/skills/`; pipeline is in `.claude/CLAUDE.md` and agent overrides (`gsd-verifier`, `gsd-executor`, `gsd-ui-researcher`, `gsd-ui-auditor`).
- **Do not upgrade** vendored `.claude/gsd-core` without a deliberate bump; this pass only added project `references/` and agent lines.
- Shared `.planning/config.json` works for 1.22 and 1.23 (`agent_skills` lists both `.cursor/skills/…` and `.claude/skills/…` paths so each runtime resolves its tree).

## Model routing (Guang-approved)

Orchestrator applies this **fallback chain** per role. **Never use Grok** for any role.

| Role | Primary | If no Opus quota | If no GPT quota |
|------|---------|------------------|-----------------|
| **Execution** (`gsd-executor`) | Sonnet | — | **Composer 2.5** (retry Sonnet once, then orchestrator/worktree) |
| **Review** (`gsd-code-reviewer`) | Opus high/xhigh | **GPT-5.6 sol high/xhigh** | **Composer 2.5** |
| **Verification** (`gsd-verifier`, `gsd-integration-checker`) | Opus high/xhigh | **GPT-5.6 sol high/xhigh** | **Composer 2.5** |
| **Research write-up** (synthesizer, phase/project researcher) | Opus | **GPT-5.6 sol high/xhigh** | **Composer 2.5** |
| **Planning** (`gsd-planner`, roadmapper, pattern-mapper) | Opus medium–high | **GPT-5.6 sol medium/high** | **Composer 2.5** |
| **Plan-check** (`gsd-plan-checker`) | Opus | **GPT-5.6 sol high/xhigh** (prefer **different** from planner) | **Composer 2.5** (separate spawn) |

**Rules**

- **Review / verification / integration** always run as a **separate pass** (own spawn), never inlined with execution.
- **Plan-check** should use a **different model** from the planner when both are non-Composer (e.g. planner Opus + plan-check GPT, or planner GPT medium + plan-check GPT high).
- **Codebase explore / quick grep** may use **Composer 2.5** regardless.
- **FORBIDDEN:** any Grok / `cursor-grok-*` model for any agent.

`model_overrides` in `.planning/config.json` pins **primary** targets when quota exists; orchestrator implements the fallback table above when Task/spawn fails on quota.

## Account switch / pause

- **Cold resume (Cursor):** `.planning/NEXT-ACCOUNT-PROMPT.md`
- **Claude Code resume:** `.planning/CLAUDE-CODE-HANDOFF-PROMPT.md`
- **Executors:** push `origin/exec/<plan>` after each task commit.
- **`PAUSE-96`:** completed 2026-11-24 — patches + WIP branches above.

## Parallelism (when resumed)

**Keep exactly 4 executors RUNNING** whenever dependency-ready disjoint plans exist; refill in the same step as each merge. See `.planning/paused/exec-ledger.md`.

**Overflow first after slot frees:** `03-48-sec-rpc-2` (vitest inventory gate).

## Done before pause

- **03-48-sec-rpc** merged (`0409`, trunk `cec95b3`)
- **03-48-sec-rpc-2** planned, **not started**
- Phase 3.1 / 4 wave through **04-45**, **04-19**, **03.1-23** merged (see exec-ledger)

## 03.1-35 (exec/03.1-35)

**Status:** implementation complete on `exec/03.1-35`; see `.planning/phases/03.1-tiered-parsing-incremental-queue-bulk-backfill/03.1-35-SUMMARY.md`.

**Verify on branch:**

```bash
npx vitest run tests/rag/ingest/advance-outcomes.test.ts tests/rag/ingest/ingest-trace.test.ts
node --import tsx --test tests/rag-e2e/zero-conversions.test.mts
npx vitest run tests/rag/doc-type-routes.test.ts
```

## How to verify (trunk)

```bash
export RUNTIME_DIR="$(git rev-parse --show-toplevel)/.claude"
node --import tsx --test tests/rag-db/search-rpc-grants-pglite.test.mts
npx vitest run tests/rag/search-rpc-grants.test.ts   # 1 fail until sec-rpc-2
node scripts/ci/check-rag-boundary.mjs
```