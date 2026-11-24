# Project-local frontend design skills (Cursor)

Pinned copies under `.cursor/skills/` (Cursor GSD 1.23) and **mirrored** under `.claude/skills/` (Claude Code GSD 1.22 takeover). **Do not fetch skill bodies from the network at runtime** (read bundled `SKILL.md` + `references/` only).

| Skill | Source | Commit / pin | License |
|-------|--------|--------------|---------|
| **frontend-design** | https://github.com/anthropics/skills | `e4bb5d960d87126ff3b3a8af1a104b7db67560ba` (`skills/frontend-design`) | See `frontend-design/LICENSE.txt` |
| **Impeccable** | https://github.com/pbakaus/impeccable | `b49177d32788f2dc585c42831d845dacf1ebed2c` (`.cursor/skills/impeccable` in repo) | Apache-2.0 (see skill metadata) |
| **web-design-guidelines** | https://github.com/vercel-labs/web-interface-guidelines | Guidelines snapshot commit `434b7f91364665f2f733b310ec54809bf8f37937` in `references/command.md` | Bundled in skill |

## GSD wiring (this repo)

- **`.planning/config.json`:** `agent_skills` maps skills onto `gsd-ui-researcher`, `gsd-executor`, `gsd-ui-auditor`, `gsd-verifier`; `workflow.ui_phase`, `workflow.ui_safety_gate`, `workflow.ui_review` enabled.
- **Agents:** `@.cursor/gsd-core/references/frontend-design-pipeline.md` (pipeline); verifier also loads `frontend-design-verifier-gate.md`.
- **Gate:** `node scripts/ci/check-frontend-design-summary.mjs <phase_dir>` — BLOCKER on UI phases when SUMMARY design contract is incomplete.
- **Rule:** `.cursor/rules/frontend-design.mdc` (UI path globs).

## Network / script review

| Artifact | Network at runtime? | Notes |
|----------|---------------------|--------|
| `frontend-design/` | No | Markdown only |
| `web-design-guidelines/` | No* | `SKILL.md` update instructions mention curl for **maintainers only** |
| `impeccable/scripts/impeccable*` | **Yes (optional)** | Launcher may download engine from `https://github.com/pbakaus/impeccable/releases` if not cached. **Agents:** use `reference/*.md` without running the launcher unless `IMPECCABLE_BIN` is preinstalled. |
| `impeccable/scripts/live-browser*.js` | Local dev server only | Not required for Cloud Agent review |

**No npm/pip install** required for these skills.

## Pipeline (order)

1. `/gsd-ui-phase` (UI-SPEC) + **frontend-design** for new interfaces  
2. Implement (executor loads **frontend-design** + **Impeccable** references)  
3. **Impeccable** critique/polish on built UI  
4. **web-design-guidelines** on changed files (fix all findings)  
5. `/gsd-ui-review`  
6. Verify + SUMMARY gate