---
phase: 06-query-layer-llamaindex-langchain
plan: 03
subsystem: rag-query
tags: [rewrite-gate, lexicon, language-detection, protected-tokens, latency]

requires:
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: "plan 04-14 src/lib/rag/query/language.ts (queryLanguage) and tests/rag/query; read only here"
provides:
  - "needsRewrite(q, ctx) — the locked LAT-03 gate: every fired rule R0–R12, transforms, XLG-01 language, protected tokens, skipRetrieval"
  - "GATE_RULE_IDS (13 stable ids), GateResult, GateContext (spec ctx + optional kbShares), Lang, Transform"
  - "matchRelativeTime(q) — R2 phrases as structured lexicon entries {term, unit, offset, n?} for the later dates.ts"
  - "rewrite-gate.lexicon.json — every query-side word list and pattern, incl. personal_data and first_person for the cache (D-12)"
  - "detectGateLanguage (XLG-01) and countCjkChars; Phase 4 queryLanguage unchanged"
  - "extractProtectedTokens / keepsProtectedTokens (NFC, case-sensitive) and scanProtected"
affects: [06-07, 06-09, 06-13, 06-14, 06-16, 06-17, 06-23]

actuals:
  tokens: 13400
  tasks: 3
  commits: 6

tech-stack:
  added: []
  patterns:
    - "Gate as data + pure function: lexicon JSON compiled to combined alternation regexes once at module load"
    - "zh terms matched as substrings, en/it with Unicode word boundaries on NFC-lowercased text with Italian elisions split"

key-files:
  created:
    - src/lib/rag/query/rewrite-gate.lexicon.json
    - src/lib/rag/query/gate-language.ts
    - src/lib/rag/query/protected.ts
    - src/lib/rag/query/rewrite-gate.ts
    - tests/rag/query/protected.test.ts
    - tests/rag/query/rewrite-gate.test.ts
    - tests/rag/query/rewrite-gate.fixtures.ts
    - tests/rag/query/rewrite-gate.bench.test.ts
  modified: []

key-decisions:
  - "All three lexicons are applied to every query (zh as substrings, en and it with word boundaries), so a Latin query detected as en still fires Italian rules (E per l'Italia? → R5)"
  - "R8: when ctx.kbShares is given it decides alone (query-language share ≤ 0.2 fires, a missing language counts as 0, an empty object never fires); otherwise kbLang ≠ lang fires"
  - "R2 spans are masked before R1/R5 matching, so 这个月 / this year / questo mese are not read as pronouns"
  - "R0 does not fire when condense_history runs (R1/R5): the condensed query is the one retrieved"
  - "R4 'complete' = not short and no R1/R5; it suppresses expand and decompose but keeps condense and translate (translation must keep protected tokens)"
  - "R10 is not applied when R3, R4 or R6 fired (a comparison or compound question is not vague)"
  - "R11 thresholds are inclusive (≥ 30 zh units, ≥ 15 words); R11 and complete-R4 keep the suppressed rules' ids in reasons but drop expand/decompose"
  - "Length units: zh = CJK characters + non-CJK word runs; en/it = words"
  - "Quoted spans are protected by their inner text (quote style may change in a rewrite)"

patterns-established:
  - "Shared fixture rows in tests/rag/query/rewrite-gate.fixtures.ts reused by the rule tests and the benchmark"

requirements-completed: [LAT-03, XLG-01, QRY-05]

coverage:
  - id: D1
    description: "needsRewrite passes the spec fixture table in zh, en and it and returns every fired rule"
    requirement: LAT-03
    verification:
      - kind: unit
        ref: "tests/rag/query/rewrite-gate.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "Gate language follows XLG-01; 111/114 golden agreement; differences vs Phase 4 queryLanguage are reported"
    requirement: XLG-01
    verification:
      - kind: unit
        ref: "tests/rag/query/rewrite-gate.test.ts#gate language vs Phase 4 queryLanguage on the golden set"
        status: pass
    human_judgment: false
  - id: D3
    description: "Protected tokens (R4 + R7) extracted and checked verbatim (NFC, case-sensitive); lexicon keys present"
    requirement: QRY-05
    verification:
      - kind: unit
        ref: "tests/rag/query/protected.test.ts"
        status: pass
    human_judgment: false
  - id: D4
    description: "Gate p99 < 1 ms over 10,000 calls after 1,000 warm-up calls (measured p99 ≈ 0.04 ms)"
    requirement: LAT-03
    verification:
      - kind: unit
        ref: "tests/rag/query/rewrite-gate.bench.test.ts"
        status: pass
    human_judgment: false

duration: 25min
completed: 2026-11-25
status: complete
---

# Phase 6 Plan 03: Rewrite Gate Summary

**The locked LAT-03 rewrite gate as a pure, data-driven TypeScript function: R0–R12 in zh/en/it, all word lists in one lexicon file, XLG-01 language, verbatim protected tokens, p99 ≈ 0.04 ms.**

## Accomplishments
- `needsRewrite(q, ctx)` evaluates every rule and returns all fired ids (`GATE_RULE_IDS`), the transforms in canonical order, `rewrite` (true only with an LLM transform), the language, protected tokens and `skipRetrieval` for R12. No LLM, no I/O, synchronous.
- The R4 fix: `那个 ERR_TIMEOUT 怎么修？` with history returns R1 + R4, `[condense_history]`, protected `[ERR_TIMEOUT]`.
- `应该怎么申请？` does not fire R1; `该` fires only at the start or before 产品/文档/条款/公司/功能.
- One lexicon file holds every list keyed by rule and language, structured R2 entries (unit, offset, n placeholder), personal-data regexes (phone, e-mail, CN resident ID, IT codice fiscale, long digit run) and the first-person list for the cache (D-12).
- `detectGateLanguage` (CJK share ≥ 30% → zh; Italian stopword score > English → it; else en) feeds only the query layer; `queryLanguage` is untouched (P-12). The golden test logs where the two differ.

## Task Commits
1. **Task 1: lexicon, gate language, protected tokens** — `aa563b2` (test, RED), `032166e` (feat)
2. **Task 2: needsRewrite with the spec fixture table** — `23a58b4` (test, RED), `4b5bb8d` (feat)
3. **Task 3: gate latency benchmark** — `54f6cfc` (test)

## Files Created
- `src/lib/rag/query/rewrite-gate.lexicon.json` — all query-side word lists and patterns
- `src/lib/rag/query/gate-language.ts` — XLG-01 detector, `CJK_SHARE_FOR_ZH = 0.3`
- `src/lib/rag/query/protected.ts` — R4/R7 extraction, NFC verbatim check
- `src/lib/rag/query/rewrite-gate.ts` — `needsRewrite`, `matchRelativeTime`, types, `GATE_RULE_IDS`
- `tests/rag/query/{protected,rewrite-gate,rewrite-gate.bench}.test.ts`, `tests/rag/query/rewrite-gate.fixtures.ts`

## Decisions Made
See `key-decisions` above. Each one closes a spec gap that would otherwise make the spec's own fixture table fail or produce obvious waste.

## Deviations from Plan

**1. Stopword lists extended beyond the spec's examples**
- **Found during:** Task 1. With only the spec's 7 English and 12 Italian stopwords, golden agreement was 107/114 (93.9%), under the plan's 95% bar: short Italian questions (`Quanto pesa?`, `Entro quanti giorni devo chiederlo?`) had no stopword hit.
- **Fix:** added common function words to `stopwords.en` / `stopwords.it` in the lexicon (data only; the 30% CJK rule is literal). Agreement is now 111/114 (97.4%). The three remaining misses are mixed-script cross-lingual items (`xl-en-zh-01`, `xl-zh-en-01`, `xl-zh-it-02`) where the letter-based 30% CJK share disagrees with the golden label.
- **Files:** `src/lib/rag/query/rewrite-gate.lexicon.json` (in `032166e`)

**2. Italian possessives added to R1**
- The spec's fixture row `Quanto dura la sua garanzia?` must fire R1, but the spec's Italian list has no possessive. Added `suo, sua, suoi, sue` (the counterparts of the listed en `its, their`).

**3. Leading-only elliptical phrases**
- en `and for`, `and the` and it `e per`, `e il`, `e la` (R5) match only at the start of the query (key `elliptical_leading`); anywhere else they are ordinary conjunctions and would condense almost every follow-up.

**4. Extra test-support file** — `tests/rag/query/rewrite-gate.fixtures.ts` (not in `files_modified`) holds the fixture rows so the benchmark can reuse them without importing a test file.

**5. Task 3 has no RED commit** — the benchmark measures a gate that already met the bound (p99 ≈ 0.04 ms); there was nothing to fail first.

**Total deviations:** 5, all within the plan's discretion (lexicon contents, D-33) or test layout. No scope creep, no new packages, no env vars, no SQL.

## Issues Encountered
- Gate `node --import tsx --test tests/rag-db/*.test.mts`: 794 pass, 0 fail, 2 cancelled — the optional `tests/rag-db/ingestion-ledger-pg.test.mts` hook fails because `pg_ctl initdb` refuses to run as root in this container. Pre-existing and environmental: it fails identically on trunk `claude/ecstatic-hamilton-86gtwv`, and the file imports nothing from this plan.
- `npm run test-rag` gates were not run: this plan adds pure modules that no retrieval, ingest path or golden set uses yet.

## User Setup Required
None.

## Next Phase Readiness
- The router (06-14) and transforms (06-07) can call `needsRewrite` and use `protectedTokens` with `keepsProtectedTokens` after every LLM variant.
- `dates.ts` can turn `matchRelativeTime` output into a date range (R2 "date filter set" is that plan's job; the gate exposes the structured match).
- The cache bypass (06-09/06-17) can read `personal_data` and `first_person` from the lexicon.
- Not wired into any request path yet, so behaviour with the layer off is unchanged.
