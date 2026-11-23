---
phase: 01-evaluation-harness-baseline
plan: 08
subsystem: testing
tags: [fixture-corpus, synthetic-data, chinese, italian, ocr-noise, eval]

requires:
  - phase: 01-02
    provides: corpus loader (chunk markers, first-heading section rule), fixture embedder
provides:
  - four native Chinese and four native Italian synthetic fixture documents (45 chunks) with near-duplicates, stale-versus-current wording, tables, handbook/warranty text and OCR-noisy scans
affects: [01-15, 01-20, golden set, baseline, per-language slices]

plan_head_before: 01cb286d3ef0514ba357763d53099e719a12b497
plan_head_after: a05ceae458d98ac3cfb452f9aaac2a829a025a2f

actuals:
  tokens: 4430
  tasks: 2
  commits: 2

tech-stack:
  added: []
  patterns:
    - "Per-language fixture documents are written natively, not translated; same measurement-relevant shapes as the English half"
    - "Near-duplicate plan chunks differ only in the number of days; previous-policy chunk is worded differently"

key-files:
  created:
    - eval/fixtures/corpus/zh/refund-policy.zh.md
    - eval/fixtures/corpus/zh/product-specs.zh.md
    - eval/fixtures/corpus/zh/employee-handbook.zh.md
    - eval/fixtures/corpus/zh/scanned-contract.zh.md
    - eval/fixtures/corpus/it/refund-policy.it.md
    - eval/fixtures/corpus/it/product-specs.it.md
    - eval/fixtures/corpus/it/warranty-terms.it.md
    - eval/fixtures/corpus/it/scanned-receipt.it.md
  modified: []

key-decisions:
  - "Fictional companies: 绿谷仪器 (zh) and Valle Verde Strumenti (it); fictional people (陈示例, 周样本, Rossi Esempio); numbers chosen independently of the English documents"
  - "Year ranges are written so they never look phone-shaped (the Italian heading is 'Politica precedente (fino al 2023)' rather than a hyphenated year range)"

patterns-established:
  - "OCR noise in Chinese: broken line breaks inside sentences and O/0 swaps in digits; in Italian: dropped accents (perche, Citta, e), l/1 and O/0 swaps"

requirements-completed: []

coverage:
  - id: D1
    description: "Four Chinese documents (refund policy, product specs, employee handbook, scanned contract), 5 or 6 chunks each, every chunk starting with a Chinese '## ' heading; refund policy has near-duplicate annual/monthly chunks (60 vs 7 days), an exceptions chunk and an outdated 2022-2023 policy chunk"
    requirement: EVAL-04
    verification:
      - kind: other
        ref: "node --import tsx loadCorpus check: exactly 4 zh documents, 4..7 chunks each, every chunk has a section; no Chinese mobile pattern; refund-policy marker count 4; product-specs table lines 12"
        status: pass
    human_judgment: false
  - id: D2
    description: "Four Italian documents (refund policy, product specs, warranty terms, scanned receipt), 5 or 6 chunks each; refund policy has near-duplicate annual/monthly chunks (60 vs 10 days), exceptions and previous-policy chunks; scanned receipt has dropped accents and l/1, O/0 swaps"
    requirement: EVAL-04
    verification:
      - kind: other
        ref: "node --import tsx loadCorpus check: exactly 4 it and 4 zh documents, 4..7 chunks each; no +39; refund-policy marker count 4"
        status: pass
    human_judgment: false
  - id: D3
    description: "No real-looking personal data: only 555-0143 and 555-0144 phone numbers, emails only at example.com/.org/.net, no +39 numbers, no 11-digit mobile pattern"
    requirement: EVAL-04
    verification:
      - kind: other
        ref: "phone-shaped grep over zh and it finds only 555-0143 and 555-0144; email domain grep finds only example.com, example.org, example.net"
        status: pass
    human_judgment: false
  - id: D4
    description: "Production retrieval code stays byte-identical to commit 325a2c9"
    requirement: EVAL-04
    verification:
      - kind: other
        ref: "git diff --quiet 325a2c9 -- src/app/api/chat/route.ts src/lib/enhanced-rag-retrieval.ts exits 0"
        status: pass
    human_judgment: false

duration: 10min
completed: 2026-11-23
status: complete
---

# Phase 1 Plan 08: Chinese and Italian Fixture Corpus Summary

**Eight native synthetic documents (4 Chinese, 4 Italian; 45 chunks) mirroring the English half's measurement shapes: near-duplicate refund chunks that differ only in days, a stale previous-policy chunk, model-code and table documents, handbook or warranty text, and OCR-noisy scans.**

## Performance

- **Duration:** about 10 min (start time not captured at launch; estimate)
- **Completed:** 2026-11-23
- **Tasks:** 2
- **Files modified:** 8 (8 created)

## Accomplishments
- Chinese (绿谷仪器): `refund-policy.zh.md` (5 chunks; 年度方案 60 days vs 月度方案 7 days, exceptions, 旧版政策 with a 20-day account-balance rule), `product-specs.zh.md` (6 chunks; GT-300/GT-310 near-twins, spec table, price table, firmware/ID, parts), `employee-handbook.zh.md` (6 chunks; leave days and leave application in separate chunks for compound questions), `scanned-contract.zh.md` (6 chunks; sentences broken across lines, O/0 swaps, penalty and confidentiality terms that exist only here).
- Italian (Valle Verde Strumenti): `refund-policy.it.md` (5 chunks; Piani annuali 60 days vs Piani mensili 10 days, Eccezioni, Politica precedente), `product-specs.it.md` (6 chunks; VS-210/VS-220 near-twins, spec table, price table), `warranty-terms.it.md` (6 chunks; duration, coverage, exclusions, claim process, shipping and extension), `scanned-receipt.it.md` (5 chunks; dropped accents, l/1 and O/0 swaps, in-store return window found only here).
- With plan 01-07's five English documents the corpus is 13 documents; the count is checked by plan 01-15.

## Task Commits

1. **Task 1: Four native Chinese fixture documents** - `e9f9deb` (feat)
2. **Task 2: Four native Italian fixture documents** - `a05ceae` (feat)

**Plan metadata:** committed separately (docs: complete plan)

## Decisions Made
- Content is native, not translated: different company, products, numbers and phrasing from the English corpus. Wording was not tuned to favor retrieval (RESEARCH Pattern 8).
- The Chinese refund chunks differ only in the plan name and day count; the previous-policy chunks use different wording and a different remedy (account credit) so stale-versus-current confusion can be measured.
- The Italian receipt's in-store return window (14 days) is a retail-counter rule distinct from the subscription refund windows, so it is a fact found only in the scan.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Phone-shaped year range in an Italian heading**
- **Found during:** Task 2 verification
- **Issue:** The heading `Politica precedente (2022-2023)` contains `022-2023`, which matches the plan's phone-shaped grep (`[0-9]{3}-[0-9]{4}`), so the verify pipeline failed.
- **Fix:** Heading reworded to `Politica precedente (fino al 2023)`.
- **Files modified:** eval/fixtures/corpus/it/refund-policy.it.md
- **Verification:** both plan verify pipelines exit 0
- **Commit:** `a05ceae` (fixed before the Task 2 commit)

---

**Total deviations:** 1 (1 bug). **Impact on plan:** none; wording only.

## Issues Encountered
- EVAL-04 is not marked by this plan: REQUIREMENTS.md already shows it `[x]`/Complete (set earlier by plan 01-02), and the requirement also needs the fixture golden set from plan 01-15. `requirements-completed` is left empty and REQUIREMENTS.md was not touched. This matches the note in the 01-07 summary; the orchestrator may want to revisit the earlier mark.
- The committed baseline (plan 01-20) will be recorded on this corpus, so later edits to these documents require re-recording it.

## Known Stubs
None.

## Threat Flags
None. Fixture text only; T-01-40 mitigated by synthetic-only content and the grep checks above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Plan 01-15 writes golden items quoting these documents verbatim; for the scanned contract and receipt the quote must reproduce the noisy characters and, in the contract, the line breaks as stored (chunk text is trimmed but internal newlines are kept).
- `eval/tests/test_fixture_pii.py` (plan 01-15) runs the full PII scan.

## Self-Check: PASSED

All 8 created files exist, commits `e9f9deb` and `a05ceae` are ancestors of HEAD, both plan verify pipelines exit 0, and the protected-file diff check exits 0.
