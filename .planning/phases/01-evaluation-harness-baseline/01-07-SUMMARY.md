---
phase: 01-evaluation-harness-baseline
plan: 07
subsystem: testing
tags: [fixture-corpus, synthetic-data, english, ocr-noise, image-caption, eval]

requires:
  - phase: 01-02
    provides: corpus loader (fixture-meta header, chunk markers), fixture embedder, tracer refund-policy.en.md
provides:
  - five-document English synthetic fixture corpus (29 chunks) with near-duplicates, stale-vs-current wording, tables, OCR noise and an image caption
affects: [01-08, 01-15, 01-20, golden set, baseline]

plan_head_before: c0aa71715305f956d63f20bae2a4922a78e84c98
plan_head_after: ed6504c84320f0363ddc04822bd7bdab57e7f198

actuals:
  tokens: 2960
  tasks: 2
  commits: 2

tech-stack:
  added: []
  patterns:
    - "Fixture documents are plain realistic text; chunks separated by <!-- chunk -->, each starting with a ## heading"
    - "Image-caption fixture declares filename and image_url in a first-line fixture-meta comment"

key-files:
  created:
    - eval/fixtures/corpus/en/product-specs.en.md
    - eval/fixtures/corpus/en/shipping-handbook.en.md
    - eval/fixtures/corpus/en/scanned-invoice.en.md
    - eval/fixtures/corpus/en/warehouse-floorplan.en.md
  modified:
    - eval/fixtures/corpus/en/refund-policy.en.md
    - tests/fixture-edge.test.mts

key-decisions:
  - "Corpus content kept plain and untuned: the previous-policy chunk is worded differently from the current one, and the XR-4410 / XR-4420 chunks differ only in the measurement range value"
  - "The image document's loaded filename is warehouse-floorplan.png (from fixture-meta), while the file on disk is warehouse-floorplan.en.md"

patterns-established:
  - "Tests that need the tracer document look it up by filename, not by corpus position"

requirements-completed: []

coverage:
  - id: D1
    description: "refund-policy.en.md keeps its three tracer chunks byte-identical and first, and gains a 2023 previous-policy chunk plus a how-to-submit chunk (5 chunks)"
    requirement: EVAL-04
    verification:
      - kind: other
        ref: "node --import tsx corpus check: refund-policy.en.md has 5 chunks and chunks[0].section === 'Annual plans'; git diff shows only appended lines"
        status: pass
      - kind: unit
        ref: "tests/fixture-edge.test.mts (21 of 21 pass, tracer retrieval unchanged)"
        status: pass
    human_judgment: false
  - id: D2
    description: "product-specs.en.md has 6 chunks with model numbers and SKUs, a specs table and a pricing table (12 table lines), and two products whose spec lines differ in one value"
    requirement: EVAL-04
    verification:
      - kind: other
        ref: "corpus check 5-7 chunks; grep -c '^|' = 12; grep -c '<!-- chunk -->' = 5"
        status: pass
    human_judgment: false
  - id: D3
    description: "Exactly 5 English documents, each 4 to 7 chunks starting with '## ', including the OCR-noisy invoice (l/1, O/0 swaps) and the image-caption document whose imageUrl is set"
    requirement: EVAL-04
    verification:
      - kind: other
        ref: "node --import tsx loadCorpus check: 5 en documents, warehouse-floorplan.png has imageUrl, every chunk starts with '## '"
        status: pass
    human_judgment: false
  - id: D4
    description: "No real-looking personal data: only 555-01xx phone numbers, example.com/.org/.net emails, example.com URLs"
    requirement: EVAL-04
    verification:
      - kind: other
        ref: "phone-shaped grep finds only 555-0142; email grep finds nothing outside the example domains; URL grep finds nothing outside example.com"
        status: pass
    human_judgment: false
  - id: D5
    description: "Production retrieval code stays byte-identical to commit 325a2c9"
    requirement: EVAL-04
    verification:
      - kind: other
        ref: "git diff --quiet 325a2c9 -- src/app/api/chat/route.ts src/lib/enhanced-rag-retrieval.ts exits 0"
        status: pass
    human_judgment: false

duration: 12min
completed: 2026-11-23
status: complete
---

# Phase 1 Plan 07: English Fixture Corpus Summary

**Five synthetic English documents (29 chunks) shaped to measure today's system honestly: near-duplicate refund and product chunks, a stale "previous policy" chunk, spec and pricing tables, an OCR-noisy invoice and an image-caption floor plan.**

## Performance

- **Duration:** about 12 min (start time not captured at launch; estimate)
- **Completed:** 2026-11-23
- **Tasks:** 2
- **Files modified:** 6 (4 created, 2 modified)

## Accomplishments
- `refund-policy.en.md`: tracer chunks untouched; appended `## Previous policy (2023)` (30-day store credit rule, retired 1 January 2024) and `## How to submit a request`.
- `product-specs.en.md` (6 chunks): XR-4410 and XR-4420 probes whose spec lines differ only in range (250 vs 400 C), a specs table, a pricing table, firmware/ID chunk and a warranty/parts chunk.
- `shipping-handbook.en.md` (6 chunks): cut-off times and packaging rules in separate chunks to support compound questions, plus delivery times, costs, customs and damaged-parcel handling.
- `scanned-invoice.en.md` (5 chunks): OCR-style text with l/1 and O/0 swaps; payment terms (net 45 days, 1.5 % monthly interest) appear only here. Invoice arithmetic is internally consistent.
- `warehouse-floorplan.en.md` (4 chunks): fixture-meta header with `warehouse-floorplan.png` and an example.com `image_url`, so loadCorpus reports `imageUrl` and the image branch can be exercised.

## Task Commits

1. **Task 1: Refund policy and product specs** - `2cf3ca1` (feat)
2. **Task 2: Shipping handbook, scanned invoice, floor plan** - `ed6504c` (feat)

**Plan metadata:** committed separately (docs: complete plan)

## Decisions Made
- Wording was not tuned to favor retrieval; documents read as ordinary business text (RESEARCH Pattern 8).
- The one phone number uses the reserved 555-0142; all emails are at example.com/.org/.net and the one URL is at example.com.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixture-edge tests assumed the refund policy is `documents[0]`**
- **Found during:** Task 1 verification (`tests/fixture-edge.test.mts` run showed 2 failures)
- **Issue:** Corpus documents load in sorted relpath order; `product-specs.en.md` now sorts before `refund-policy.en.md`, so three `documents[0]` lookups (two failed, one passed by coincidence of its assertions) pointed at the wrong document.
- **Fix:** The three lookups now find the document by `filename === 'refund-policy.en.md'`. No assertion changed.
- **Files modified:** tests/fixture-edge.test.mts
- **Verification:** 21 of 21 pass
- **Commit:** `2cf3ca1`

---

**Total deviations:** 1 (1 bug). **Impact on plan:** test-only fix to keep the plan's own verification (`fixture-edge.test.mts` still passes) true; no scope change.

## Issues Encountered
- REQUIREMENTS.md already shows EVAL-04 as `[x]`/Complete (set earlier by plan 01-02). This plan delivers only the English half; the Chinese and Italian documents (01-08) and the fixture golden set (01-15) are still pending. `requirements-completed` is left empty here and no requirement was marked by this plan; the orchestrator may want to revisit the earlier mark.
- Per RESEARCH Pattern 8, the committed baseline (plan 01-20) will be recorded on this corpus, so later edits to these documents require re-recording it.

## Known Stubs
None.

## Threat Flags
None. Fixture text only; T-01-39 mitigated by synthetic-only content and the grep checks above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Plan 01-08 writes the Chinese and Italian documents; plan 01-15 writes golden items quoting these English documents verbatim (including the OCR-noisy invoice, where the quote must reproduce the noisy characters).
- The loaded filename of the image document is `warehouse-floorplan.png`, so golden `document` fields must use that name, not the `.en.md` file name.
- `eval/tests/test_fixture_pii.py` (plan 01-15) will run the full PII scan.

## Self-Check: PASSED

All 4 created files and 2 modified files exist, commits `2cf3ca1` and `ed6504c` are ancestors of HEAD, `node --import tsx --test tests/fixture-edge.test.mts` reports 21 pass / 0 fail, and both plan verify pipelines plus the protected-file diff check exit 0.
