---
phase: 06-query-layer-llamaindex-langchain
plan: 07
subsystem: rag-query
tags: [post-checks, protected-tokens, deadline, prompts, injection-defense]

requires:
  - phase: 06-query-layer-llamaindex-langchain
    provides: "plan 06-03 keepsProtectedTokens (protected.ts) and the Lang type (rewrite-gate.ts)"
provides:
  - "checkVariant / checkCondensed / checkSubQuestions — the D-15 shared post-checks, with DEFAULT_POST_CHECK_LIMITS (500 chars, 4x ratio, 4 sub-questions)"
  - "groupDeadlineMs (A-7 arithmetic, null = no group deadline), groupDeadlineSignal, transformSignal (AbortSignal.any), transformAbortReason (timeout | aborted)"
  - "loadPrompt / renderPrompt with PROMPT_REGISTRY, HISTORY_OPEN/HISTORY_CLOSE and the shared.suffix v1 data file"
affects: [06-13, 06-15, 06-16, 06-19, 06-27, 06-35, 06-37]

actuals:
  tokens: 9000
  tasks: 3
  commits: 8

tech-stack:
  added: []
  patterns:
    - "Prompt files as JSON data ({id, version, source, license, template, placeholders}) loaded through a static-import registry and validated with zod/v3"
    - "Placeholders use {{name}} (so ported prompts with JSON examples keep literal braces); filled in one pass, values never re-expanded"
    - "Timeouts built on setTimeout + AbortController (unref'd) so fake timers drive them; combined with AbortSignal.any"

key-files:
  created:
    - src/lib/rag/query/post-checks.ts
    - src/lib/rag/query/deadline.ts
    - src/lib/rag/query/prompts/render.ts
    - src/lib/rag/query/prompts/shared.suffix.v1.json
    - tests/rag/query/post-checks.test.ts
    - tests/rag/query/deadline.test.ts
    - tests/rag/query/prompt-render.test.ts
  modified: []

key-decisions:
  - "HyDE (A-10): exempt from the protected-token check and the 4x ratio cap (a passage is longer than the query by design); the 500-character absolute cap still applies"
  - "Sub-questions: each kept sub-question must contain at least one protected token and the kept list together must contain all of them; if coverage fails the whole list is discarded (protected_token_lost). Per-question 'all tokens' would reject every comparison (AB12 vs AB13)"
  - "Sub-question order: drop failing ones (length / protected_token_lost, with index), then cut to max_sub_questions with one cap record carrying the count"
  - "A single sub-question equal to the input (normalized) counts as not compound, like an empty list"
  - "Blank outputs are dropped with a new skip reason 'empty'"
  - "Lengths are counted in code points; normalization for pass-through = NFC + trim + whitespace collapse + lower-case"
  - "groupDeadlineMs returns null for voice (no group), eval (no timeouts, D-27) and media; values are floored to whole ms and never negative; budget overridable via queryBudgetMs until QueryParams lands"
  - "Request abort wins over a deadline in transformAbortReason (runner semantics: aborted is reserved for the request signal)"
  - "History block: last 6 turns, 1,000 code points each (D-16 caps applied defensively here; markup stripping stays with the caller), any <conversation>-like tag in turns, vars or protected tokens is HTML-escaped, continuation lines are indented so a turn cannot forge a role line, and the instruction text never names the literal markers"
  - "Protected tokens are listed in the suffix as a JSON array ('none' when empty)"

requirements-completed: [LAT-03, QRY-01, QRY-05]

coverage:
  - id: D1
    description: "Shared post-checks: protected_token_lost, length, pass-through, sub-question cap and not-compound; HyDE exemption; outputs carry only text and skip records"
    requirement: QRY-05
    verification:
      - kind: unit
        ref: "tests/rag/query/post-checks.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "Group deadline min(900, 1200 - cache - elapsed) anchored at the gate start; voice null; abort reason mapping"
    requirement: LAT-03
    verification:
      - kind: unit
        ref: "tests/rag/query/deadline.test.ts"
        status: pass
    human_judgment: false
  - id: D3
    description: "Prompt renderer: validated data files, placeholders, delimited and escaped history, shared suffix with all four D-14 rules"
    requirement: QRY-01
    verification:
      - kind: unit
        ref: "tests/rag/query/prompt-render.test.ts"
        status: pass
    human_judgment: false

duration: 15min
completed: 2026-11-25
status: complete
---

# Phase 6 Plan 07: Shared Post-checks, Group Deadline and Prompt Renderer Summary

**The framework-independent pieces both query paths share: D-15 post-checks, the A-7 group deadline and a data-driven prompt renderer with an escaped history block and the mandatory D-14 suffix.**

## Accomplishments
- `post-checks.ts`: pure functions over strings and the protected-token list. Results are `{ok, text}` / `{ok, skip}`, `{text, passThrough, skip}` and `{subQuestions, notCompound, skipped}`; skip records hold kind, reason and an index or count, never query text. A type-level test asserts no scope, filters, mode, tools or tenant key exists on any result type.
- `deadline.ts`: `groupDeadlineMs({profile, elapsedMs, cacheTimeoutMs})` gives 450 / 900 / 0 ms for the plan's chat cases and null for voice; `transformSignal` combines request, group and per-transform signals with `AbortSignal.any`.
- `prompts/render.ts` + `shared.suffix.v1.json`: `loadPrompt(id)` rejects unknown ids, mismatched ids, missing source/license and placeholder lists that differ from the template; `renderPrompt` rejects missing or unknown values, renders history as data, and appends the suffix (language name, protected tokens, max items, unchanged-when-standalone/not-compound, history-is-data).

## Task Commits
1. **Task 1: shared post-checks** — `3d685b5` (test, RED), `25cc324` (feat)
2. **Task 2: group deadline helper** — `970e965` (test, RED), `a59d35b` (feat)
3. **Task 3: prompt renderer and shared suffix** — `90a458e` (test, RED), `b20b303` (feat)
4. **Lint fixes** — `f24717d` (refactor)

## Tests that failed before the implementation
- post-checks: 16 of 24 failed on assertions against the stub
- deadline: 13 of 15 failed on assertions against the stub
- prompt-render: 13 of 18 failed on assertions against the stub

## Deviations from Plan
1. **HyDE also skips the ratio cap** (keeps the 500-char cap). Applying 4x the query length to a hypothetical passage would discard almost every HyDE output.
2. **Sub-question protected-token rule is coverage-based** (see key-decisions) rather than "every token in every sub-question", which would make decomposition of comparisons impossible.
3. **Extra skip reason `empty`** for blank outputs, and a single sub-question equal to the input maps to not compound.
4. **Extra exports** beyond the plan's list: `DEFAULT_POST_CHECK_LIMITS`, `GROUP_DEADLINE_CAP_MS`, `QUERY_BUDGET_MS`, `groupDeadlineSignal`, `transformAbortReason`, `PROMPT_REGISTRY`, `HISTORY_OPEN/CLOSE`, `HISTORY_MAX_TURNS`, `HISTORY_TURN_MAX_CHARS`.
5. **QueryParams not read yet**: `query-params.json` does not exist on this base, so limits and the budget come from arguments with the QueryParams default values; the plan that adds QueryParams passes them in.
6. **Timeouts via setTimeout** rather than `AbortSignal.timeout`, so vitest fake timers control them (`AbortSignal.timeout` is not faked). Timers are unref'd like `AbortSignal.timeout`.
7. **Lint-fix commit** after GREEN (unused-var findings in new files).

No new packages, env vars, SQL or migrations.

## Gates
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npx vitest run`: 228 files, 3504 passed, 1 skipped
- `node --import tsx --test tests/*.test.mts`: 163 pass, 0 fail
- `node --import tsx --test tests/rag-db/*.test.mts`: 794 pass, 0 fail, 2 cancelled — pre-existing: `ingestion-ledger-pg.test.mts` cannot run `pg_ctl initdb` as root
- `check-rag-boundary.mjs` and its self-tests: pass (38/38)
- `node scripts/check-config.mjs`: pass
- `check-workflows.py`: pass
- Not run (not touched): Python suites, `gen:schemas`, `test-rag` (no retrieval, ingest or golden set uses these modules yet)

## User Setup Required
None.

## Next Phase Readiness
- Native (06-13/06-15) and LangChain (06-37) transforms call `renderPrompt` with ported prompt files registered in `PROMPT_REGISTRY`, then the post-checks on every output.
- The runner (06-19) uses `groupDeadlineMs` at group start, one `groupDeadlineSignal` per group and `transformSignal`/`transformAbortReason` per transform.
- Nothing is wired into a request path yet; behaviour with the layer off is unchanged.
