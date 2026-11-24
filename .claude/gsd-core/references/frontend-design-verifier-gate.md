# Frontend design verifier gate (BLOCKER)

After Step 6 (requirements / truths) and **before** final `passed` verdict, for any phase that touched UI:

## Detect UI phase

UI phase if **any** of:

- `{PHASE_DIR}/*-UI-SPEC.md` exists
- Any `*-PLAN.md` in `{PHASE_DIR}` lists `scripts/config-ui/`, `src/components/`, or `src/app/` in `files_modified`
- Any SUMMARY-modified path matches `scripts/config-ui/**`, `src/components/**`, `src/app/**`

## Run gate

```bash
node scripts/ci/check-frontend-design-summary.mjs "${PHASE_DIR}"
```

- Exit `0` → record in VERIFICATION.md: `Frontend design SUMMARY gate: PASS`
- Exit `2` → **BLOCKER** — `status` cannot be `passed`; append gate stderr to VERIFICATION.md
- Exit `1` → misconfiguration (missing phase dir) → **WARNING**

Do not mark UI plans verified while web-design-guidelines findings are open or design-skills table is missing.