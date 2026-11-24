# HANDOFF — Phase 3 (Cloud Agent)

**Branch:** `claude/ecstatic-hamilton-86gtwv` (push only; no PR)  
**GSD runtime:** `.cursor/` GSD 1.23.0 only (`RUNTIME_DIR=$(git rev-parse --show-toplevel)/.cursor`)

## Done this session

- Merged: **03-40**, **03-38**, **03-39**, **03-42**
- Config: `model_overrides` → Opus for `gsd-code-reviewer`, `gsd-verifier`, `gsd-integration-checker`
- Fixed: `legacy-post-filter-sentinel` SHA after 03-38 assemble change; admin doc-type route types (`auto` excluded); `tsconfig` excludes `wt/`
- Gates (latest): vitest **2459/2459**; node tests **145/145**; eval pytest **366 passed**; rag-sidecar **517 passed**; test-rag prechunked + ingest **PASS**; boundary/workflows/check-config **OK**

## Next step

1. Run full rag-db suite on HEAD once (prior full run had 1 flake on `profile-rpc-two-tenant`; single-file re-run passed).
2. Execute **03-45** (eval profile runs), then **03-43**, **03-44**, **03-46**, **03-47**; skip **03-48** (Guang live).
3. Opus **code review + verification** (`followups-notes.md` old bugs, D-08 isolation).
4. Update REQUIREMENTS/ROADMAP/STATE; Phase 3.1 then Phase 4.

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

## Open for Guang

- **03-48** live checkpoint (manual)
- Apply migrations **0315–0319** (0316 two stems)
- Package installs only if new deps appear in remaining plans