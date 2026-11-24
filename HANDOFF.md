# HANDOFF — Phase 3 (Cloud Agent)

**Branch:** `claude/ecstatic-hamilton-86gtwv` (push only; no PR)  
**GSD runtime:** `.cursor/` GSD 1.23.0 only (`RUNTIME_DIR=$(git rev-parse --show-toplevel)/.cursor`)

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

## Account switch (96% usage)

- **Cold resume:** `.planning/NEXT-ACCOUNT-PROMPT.md` — self-contained paste for a new Cursor account; updated after every trunk merge.
- **Executors:** push `origin/exec/<plan>` after each task commit.
- **`PAUSE-96`:** stop spawns → executor patches in `.planning/paused/patches/` → `/gsd-pause-work` → refresh NEXT-ACCOUNT-PROMPT + HANDOFF → push → stop.

## Parallelism (mandatory)

**Keep exactly 4 executors RUNNING at all times; refill in the same step as each merge** (one orchestrator message: merge + tests + ledger + batch `Task` until 4 `RUNNING` + ff all `wt/*`). Confirm count with `cursor-cloud` when UI shows fewer. See `.planning/paused/exec-ledger.md` Wave E.

**Wave E now (4 RUNNING):** [03.1-23](bc-ab1e9b2d-301d-50ad-85d3-54b3af5e3261), [03.1-25](bc-1f542e8a-f80a-58a7-99bb-5c47f655d0ce), [04-18](bc-78743196-9471-5cda-8414-1d4c80c9d85f), [04-19](bc-eafdad13-4e57-5750-a00f-8bc029517ee2).

**Overflow queue:** `04-45`, `03-48-sec-rpc` worktrees on trunk (spawn on next merge, same turn).

## Done this session

- Trunk: Phase **3.1** wave 3 + Phase **4** through **04-44** merged; integration @ `450662e`
- Rules: `.cursor/rules/orchestration.mdc` — **exactly 4** executors + same-turn batch refill

## Next step

1. On **any** executor completion: merge + gates on trunk → **batch-spawn** until 4 RUNNING (use overflow queue).
2. **03-48** live DB: Guang/box only; integration agents use **03-48-sec-rpc** / **setup-idempotent** worktrees.
3. No duplicate plan ids; push only `claude/ecstatic-hamilton-86gtwv`; no PR.
3. Review + verification (`followups-notes.md`, D-08).
4. REQUIREMENTS/ROADMAP/STATE; Phase 3.1 then Phase 4.

## How to verify

```bash
export RUNTIME_DIR="$(git rev-parse --show-toplevel)/.cursor"
export PATH="$HOME/.local/bin:$PATH"
npx next typegen && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json
npx vitest run
node --import tsx --test tests/*.test.mts
node --import tsx --test tests/rag-db/*.test.mts
npm run test-rag -- --out /tmp/rag-pre && npm run test-rag -- --fixture-mode ingest --out /tmp/rag-ingest
```

## Executed without Sonnet gsd-executor

| Plan | Reason |
|------|--------|
| 03-39 Task 3 (admin doc-type route) | Orchestrator worktree after Sonnet quota failures |
| 03-42 | Composer `gsd-executor` (`inherit`) after two Sonnet Task failures |

## Executor dedupe (Guang)

- **Ledger:** `.planning/paused/exec-ledger.md` — one executor per plan; check before every `Task` spawn.
- **03-44 DUPLICATE EXECUTION:** [bc-cdb95a3d](bc-cdb95a3d-1ebc-5b58-a6a1-46d7c48b8221), [bc-9cd7df41](bc-9cd7df41-c92d-5032-a8a1-d1547071d01f), [bc-645e437f](bc-645e437f-c0b8-5e86-a96d-f80cec58aab7) — canonical merge via bc-645e437f only.

## Open for Guang

- **03-48** live checkpoint (manual)
- Apply migrations **0315–0319** (0316 two stems)
- Package installs only if new deps appear in remaining plans