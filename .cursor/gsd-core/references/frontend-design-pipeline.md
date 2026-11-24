# Frontend design pipeline (myRAG project override)

Mandatory sequence for **any phase or plan with UI surface changes** (Config UI, `src/components/**`, App Router pages, voice overlay, etc.).

## Order (do not skip or reorder)

| Step | When | Skill / command | Agent |
|------|------|-----------------|-------|
| 1 | Before planning UI work | `/gsd-ui-phase <phase>` → UI-SPEC.md | `gsd-ui-researcher` (+ `frontend-design`) |
| 2 | New interface / major visual direction | `.cursor/skills/frontend-design/SKILL.md` | `gsd-ui-researcher`, `gsd-executor` on UI tasks |
| 3 | After implementation, before guidelines | `.cursor/skills/impeccable/SKILL.md` (`critique` / `polish`; prefer `reference/*.md` if launcher unavailable) | `gsd-executor` (self-check), `gsd-ui-auditor` |
| 4 | Last check on **code** | `.cursor/skills/web-design-guidelines/SKILL.md` on every changed UI file; fix all findings | `gsd-ui-auditor`, `gsd-verifier` |
| 5 | Before phase verification | `/gsd-ui-review <phase>` | `gsd-ui-auditor` |
| 6 | Verification | Standard `/gsd-verify-work` + **frontend SUMMARY gate** (below) | `gsd-verifier` |

## SUMMARY.md contract (each UI plan)

Every UI plan SUMMARY **must** include:

```markdown
## Design skills

| Skill | Role | Outcome |
|-------|------|---------|
| frontend-design | … | pass / n/a |
| Impeccable | … | pass / n/a |
| web-design-guidelines | … | pass (all findings resolved) |
```

Under **web-design-guidelines**, list findings as `path:line — rule — fixed` or `none`.

`scripts/ci/check-frontend-design-summary.mjs` enforces this for UI plans at verify time.

## Impeccable launcher

The bundled `scripts/impeccable` may download a binary from GitHub releases on first use. **Cloud agents:** use `reference/critique.md`, `reference/polish.md`, and `reference/craft-floor.md` directly when the launcher is not installed; do not block on network download unless `IMPECCABLE_BIN` is set.