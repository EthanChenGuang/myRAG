---
phase: 03-unified-ingestion-embedding-profiles
plan: 25
subsystem: testing
tags: [fixtures, reportlab, pillow, docling, docling-core, rapidocr, pytest, github-actions, pii]

requires:
  - phase: 03-unified-ingestion-embedding-profiles
    provides: "03-05 reportlab pin and the docling image target with baked models; 03-14 invoice extractor; 03-15 Docling adapter (to_parse_result), probe and the real_docling marker"
provides:
  - "specs.py: twelve synthetic typed fixtures defined once (zh report with a 40-row table, zh/en/it scans, zh/en/it invoices, en PDF with two pictures, zh contract with an exception clause, zh/en/it injection documents) with the facts later plans assert"
  - "generate_pdfs.py: deterministic fixture PDF generator (reportlab invariant mode; scans rendered with Pillow and a CJK font, stored as JPEG); 12 committed PDFs plus Markdown for the contract and injection text path"
  - "record_parse_results.py and recorded/: ParseResult, Docling JSON and picture artifacts produced by the sidecar adapter on DoclingDocuments built from the specs"
  - "manifest.json: fixture registry (id, path, mime, file_sha256, doc type, profile id, recorded paths, expected facts) the fake sidecar serves by hash"
  - "nightly real-docling job and test_real_docling.py: real Docling on the generated PDFs, offline with the models baked into the docling image"
affects: [03-27 fake sidecar, 03-29 invoice extraction stage, 03-38 PDF images, 03-41 and 03-44 ingest-mode eval, 03-19 legal chunker tests, 03-48 live verification]

actuals:
  tokens: 101000
  tasks: 3
  commits: 5
plan_head_before: cd7917bc9a09b5f0cb4923af9697ca5dc3c455ef
plan_head_after: 01ee769d54144a64f0dcdb5a9928354139969bb9

tech-stack:
  added: []
  patterns: ["fixtures defined once as data (specs.py) and rendered by independent tools (reportlab PDFs, docling-core recordings, Markdown)", "byte-reproducible PDFs: invariant mode, uncompressed content streams, JPEG instead of Flate images, so output does not depend on a zlib build", "recorder output regenerated in a sidecar test and compared with the committed files (PNG compared by pixels)", "nightly job gates every step on an install-probe step output and skips with a ::notice::"]

key-files:
  created:
    - eval/fixtures/ingest/specs.py
    - eval/fixtures/ingest/generate_pdfs.py
    - eval/fixtures/ingest/record_parse_results.py
    - eval/fixtures/ingest/manifest.json
    - eval/fixtures/ingest/pdf/ (12 PDFs and build-info.json)
    - eval/fixtures/ingest/recorded/ (12 parse results, 12 Docling JSON, 2 picture PNGs)
    - eval/fixtures/ingest/text/ (4 Markdown files)
    - eval/tests/test_ingest_fixtures.py
    - rag-sidecar/tests/test_real_docling.py
    - rag-sidecar/tests/test_ingest_fixture_recordings.py
  modified:
    - eval/tests/test_fixture_pii.py
    - .github/workflows/nightly.yml
    - scripts/ci/check-workflows.py
    - scripts/tests/test_check_workflows.py

key-decisions:
  - "Digital PDFs are written with pageCompression=0 and pictures and scans are embedded as JPEG, so no output byte depends on a zlib implementation; invariant mode alone would not have given that"
  - "Scans are checked structurally (no text-show operator, DCT image) on every run, and byte-for-byte only when a font with the sha256 recorded in pdf/build-info.json is found (RAG_FIXTURE_CJK_FONT or two known paths); otherwise the test skips with a notice"
  - "Recorded DoclingDocuments follow the shape real Docling returned for these PDFs (list items keep their marker in the text, titles are level-1 headings) after a read-only comparison with a real run"
  - "The nightly job takes its models from the docling image (docker build --target docling, docker cp /opt/docling-models and /opt/tiktoken) and runs offline; an install failure of the extra skips with a notice, an image build failure fails the job"
  - "Real-Docling thresholds: digital headings recall 1.0, table id recall 0.95, header cell match 0.75, scan key-phrase floors zh/en 0.75 and it 0.6; measurements go to RAG_REAL_DOCLING_REPORT"

patterns-established:
  - "Eval tests load fixture helper modules by path (importlib) and read committed JSON only; the sidecar env regenerates the recordings"
  - "Workflow checker: one function per nightly job, needles plus gating assertions, unit-tested with mutated copies of the real workflow"

requirements-completed: [DATA-05, DATA-09, DATA-11, SEC-01, CHK-02]

coverage:
  - id: D1
    description: "A committed deterministic generator produces every typed fixture from synthetic specs; regenerating the digital PDFs gives identical bytes and they equal the committed files"
    requirement: "DATA-05"
    verification:
      - kind: unit
        ref: "eval/tests/test_ingest_fixtures.py#test_regenerating_the_digital_pdfs_gives_identical_bytes"
        status: pass
      - kind: unit
        ref: "eval/tests/test_ingest_fixtures.py#test_committed_digital_pdfs_equal_a_fresh_build"
        status: pass
    human_judgment: false
  - id: D2
    description: "Scanned zh/en/it PDFs have no text layer, the font hash is recorded, and they regenerate byte for byte when that font is present"
    requirement: "DATA-05"
    verification:
      - kind: unit
        ref: "eval/tests/test_ingest_fixtures.py#test_committed_scans_are_image_only"
        status: pass
      - kind: unit
        ref: "eval/tests/test_ingest_fixtures.py#test_scans_regenerate_byte_for_byte_when_the_recorded_font_is_present (ran here with the recorded font; skips with a notice elsewhere)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Recorded ParseResults validate, every pure table chunk starts with its header and separator rows (the 40-row table splits into three chunks), the images fixture lists pictures on pages 1 and 2 with artifact names, and invoice recordings yield the expected fields"
    requirement: "DATA-09"
    verification:
      - kind: unit
        ref: "eval/tests/test_ingest_fixtures.py#test_every_table_chunk_starts_with_its_header_and_separator_rows"
        status: pass
      - kind: unit
        ref: "eval/tests/test_ingest_fixtures.py#test_the_images_fixture_lists_pictures_on_pages_one_and_two_with_artifact_names"
        status: pass
      - kind: unit
        ref: "eval/tests/test_ingest_fixtures.py#test_invoice_recordings_yield_the_expected_fields_through_the_extractor"
        status: pass
      - kind: unit
        ref: "rag-sidecar/tests/test_ingest_fixture_recordings.py#test_committed_recordings_equal_a_fresh_run_of_the_adapter"
        status: pass
    human_judgment: false
  - id: D4
    description: "manifest.json maps each fixture id to path, mime, file_sha256 (recomputed by a test), doc type, recorded paths and the expected facts for 03-41 and 03-44 (invoice fields, quarantine phrase, image pages, clause text)"
    requirement: "DATA-11"
    verification:
      - kind: unit
        ref: "eval/tests/test_ingest_fixtures.py#test_the_manifest_registers_every_fixture_with_its_hash_type_and_recordings"
        status: pass
      - kind: unit
        ref: "eval/tests/test_ingest_fixtures.py#test_manifest_expected_facts_equal_the_specs"
        status: pass
    human_judgment: false
  - id: D5
    description: "The fixture PII scanner covers specs, text, manifest and recordings (45 files) and no synthetic id matches a phone pattern"
    requirement: "SEC-01"
    verification:
      - kind: unit
        ref: "eval/tests/test_fixture_pii.py#test_fixture_text_has_only_reserved_phone_numbers"
        status: pass
      - kind: unit
        ref: "eval/tests/test_ingest_fixtures.py#test_no_spec_text_matches_a_phone_pattern"
        status: pass
    human_judgment: false
  - id: D6
    description: "The contract fixture's clause 第5条 keeps its exception lead-in and four items in one chunk under the heading path of the clause, in the recording and in real Docling output"
    requirement: "CHK-02"
    verification:
      - kind: unit
        ref: "eval/tests/test_ingest_fixtures.py#test_the_contract_recording_keeps_the_exception_lead_in_and_its_list_in_one_chunk"
        status: pass
      - kind: integration
        ref: "pytest -m real_docling tests/test_real_docling.py::test_real_docling_keeps_the_clause_heading_path_and_the_whole_exception_list_together (scratch environment, locked docling 2.150.1)"
        status: pass
    human_judgment: false
  - id: D7
    description: "The nightly real-docling job runs real Docling on the generated PDFs (fonts, docling extra, image models, regenerated scans, offline run, report upload) and skips with a notice when the extra cannot install"
    requirement: "DATA-05"
    verification:
      - kind: other
        ref: "python3 scripts/ci/check-workflows.py (OK) and scripts/tests/test_check_workflows.py RealDoclingJobTest (5 tests)"
        status: pass
      - kind: integration
        ref: "pytest -m real_docling tests/test_real_docling.py: 39 passed against the locked docling in a scratch environment, offline with only the models directory"
        status: pass
    human_judgment: true
    rationale: "The workflow YAML has not run on a GitHub runner: the image build, docker cp, the Noto face index 2 and the apt font install are unverified until the first nightly"
  - id: D8
    description: "OCR quality for Chinese and Italian scans with PP-OCRv6 (hand-off item from 03-15)"
    requirement: "DATA-05"
    verification: []
    human_judgment: true
    rationale: "Measured on clean synthetic 200 dpi scans only (zh 4/4 and en 4/4 key phrases; it 4/5, with part of the first Italian paragraph garbled); real scans of real documents remain the ROADMAP live check"

duration: 40min
completed: 2026-11-24
status: complete
---

# Phase 3 Plan 25: Ingest fixtures and the nightly real-Docling job Summary

**Twelve synthetic typed fixture PDFs from a byte-reproducible reportlab/Pillow generator, adapter-recorded ParseResult and Docling JSON with a hash-keyed manifest of expected facts, and a nightly job that converts the same PDFs with real Docling offline; the first real run measured zh and en OCR at 4/4 key phrases and Italian at 4/5**

## Performance

- **Duration:** about 40 min (start time was not captured; estimated from the first commit and the session log)
- **Completed:** 2026-11-24T02:50:00Z
- **Tasks:** 3 of 3
- **Files changed vs plan base:** 54 (12 PDFs and 2 PNGs are binary)

## Accomplishments
- `specs.py` defines every fixture once (blocks, pages, facts). The generator renders digital PDFs with reportlab in invariant mode and no stream compression (STSong-Light for Chinese) and scans with Pillow and a CJK font stored as JPEG, so the committed digital PDFs equal a fresh build and the scans carry no text operator. `pdf/build-info.json` records the scan font's sha256.
- The recorder builds a DoclingDocument per spec, runs `to_parse_result` with the options of the fixture's profile from `config/rag/processing-profiles.json`, and writes `<id>.parse.json`, `<id>.docling.json` and picture artifacts. The 40-row table splits into three table chunks that each repeat the header row; invoices come out as one header-block-plus-table chunk; the images fixture lists pictures on pages 1 and 2.
- `manifest.json` holds 12 entries with the recomputed `file_sha256`, MIME type, doc type, profile id, recorded paths (including an artifact name map for the fake sidecar), the Markdown text path where it exists, and the expected facts for 03-41/03-44 (invoice fields, the quarantine phrase, picture pages, the exception clause text). The recorder fails if the extractor does not yield the expected invoice fields from the recorded Markdown.
- The PII scanner now covers `specs.py`, the four Markdown files, the manifest and 24 recorded JSON files (45 files).
- `test_real_docling.py` (marker `real_docling`) and the nightly `real-docling` job: fonts-noto-cjk, `uv sync --locked --extra docling` with a skip notice, `docker build --target docling` and `docker cp` of the baked models, PDFs regenerated with the Noto face, the run offline (`HF_HUB_OFFLINE`, `TRANSFORMERS_OFFLINE`), and the measurements uploaded as an artifact. `check-workflows.py` requires the job's needles and the gating of every step after the install probe.

## Task Commits

1. **Task 1: Specs and the deterministic PDF generator** (TDD)
   - RED: `28395df` (test): 11 tests failed on assertions against an inert generator (no PDFs, no Markdown, no `invariant`, PII scan count 5 expected)
   - GREEN: `1851e8e` (feat)
2. **Task 2: Recorded parse outputs and the manifest** (TDD)
   - RED: `b2c9b12` (test): 18 tests failed on the assertion that `manifest.json` and the recordings exist
   - GREEN: `92e72a1` (feat)
3. **Task 3: Nightly real-Docling job** - `01ee769` (ci)

**Plan metadata:** the commit that adds this SUMMARY (docs: complete plan). `commits: 5` is measured from the ledger base `cd7917b`.

## TDD Gate Compliance

| Task | RED evidence | Semantic assessment |
|------|--------------|---------------------|
| 1 | `gsd_run check tdd-red-evidence` on the JUnit report of `test_digital_pdfs_are_written_for_every_digital_fixture`: `RED_EVIDENCE_OK` (`target_test_failed`) | The target ran and failed on `assert set(written) == DIGITAL_IDS` because the placeholder returned `{}`; no import or fixture fault |
| 2 | Same classifier on `test_every_table_chunk_starts_with_its_header_and_separator_rows`: `RED_EVIDENCE_OK` | The target ran and failed on `manifest.json is missing`, the planned precondition; not a load error |

Every other RED failure was an assertion (all file reads go through a helper that asserts existence first). One RED test was refined in the GREEN commit: see deviation 3.

## Files Created/Modified
- `eval/fixtures/ingest/specs.py` - fixture specs, facts, deterministic picture pixels, Markdown renderer
- `eval/fixtures/ingest/generate_pdfs.py` - PDF generator (`--out`, `--text-out`, `--cjk-font`, `--cjk-font-index`)
- `eval/fixtures/ingest/record_parse_results.py` - recorder and manifest writer (sidecar env, chunking extra)
- `eval/fixtures/ingest/{pdf,recorded,text}/`, `manifest.json` - committed outputs
- `eval/tests/test_ingest_fixtures.py`, `eval/tests/test_fixture_pii.py` - generator, recording and manifest tests; wider PII scan
- `rag-sidecar/tests/test_ingest_fixture_recordings.py` - regenerates the recordings and compares
- `rag-sidecar/tests/test_real_docling.py` - nightly real-Docling checks
- `.github/workflows/nightly.yml`, `scripts/ci/check-workflows.py`, `scripts/tests/test_check_workflows.py` - job, checker, unit tests

## Decisions Made
See `key-decisions`. Fixture ids: Partita IVA `99999999990` and `00000010017`, USCC `91000000MA0000000N` and `91000000MA0000001R`, VAT `BE0000000097` and `FR00000000093` (all from `tests/fixtures/ingest/tax-id-vectors.json`), invoice numbers `FP-2025-00417`, `INV-2025-00418`, `FT-2025-00419` (pitfall P-21). The German VAT id used in the extractor's own English test was not reused.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical] Byte-reproducibility needed more than invariant mode**
- **Found during:** Task 1
- **Issue:** `invariant=1` fixes dates and ids, but Flate-compressed streams and Flate-encoded images would still differ between zlib builds, which would break the committed-bytes check (T-03-71) on another runner.
- **Fix:** `pageCompression=0` for digital PDFs; pictures and scans are embedded as JPEG (Pillow's pinned libjpeg), so no output goes through zlib. Added `pdf/build-info.json` (font family, index, sha256, generator versions) so the manifest can record the font.
- **Files modified:** `eval/fixtures/ingest/generate_pdfs.py`, `eval/fixtures/ingest/pdf/build-info.json`
- **Verification:** two runs and a run in another directory gave the same 12 hashes
- **Committed in:** `1851e8e`

**2. [Rule 2 - Missing critical] Drift test for the recordings**
- **Found during:** Task 2
- **Issue:** T-03-71 asks that outputs of unknown origin never enter the repository; nothing would notice a hand-edited or stale recording.
- **Fix:** `rag-sidecar/tests/test_ingest_fixture_recordings.py` regenerates every recording and the manifest in the sidecar env (skipped without the chunking extra) and compares with the committed files; PNG data is compared by pixel hash. A negative control (editing one recorded heading) made it fail.
- **Files modified:** `rag-sidecar/tests/test_ingest_fixture_recordings.py` (not in the plan's file list)
- **Committed in:** `92e72a1`

**3. [Rule 1 - Bug in own test] Invoice chunks are not pure table chunks**
- **Found during:** Task 2 (GREEN)
- **Issue:** The RED test required every table chunk to start with a `|` row and to carry `table_header`. The adapter marks a chunk as a table chunk when it holds any table item, and the invoice chunk (header block, then the line-item table in one chunk, which is what D-14 wants) starts with text; real Docling output has the same shape.
- **Fix:** Pure table chunks must start with header and separator rows and equal `table_header`; mixed chunks must contain the header and separator rows and keep the invoice number with the table. The separate invoice test was replaced accordingly.
- **Files modified:** `eval/tests/test_ingest_fixtures.py`
- **Committed in:** `92e72a1`

**4. [Rule 3 - Blocking] The nightly job needs models**
- **Found during:** Task 3
- **Issue:** The plan's job text installs the extra but never provides baked models, and `test_real_docling` needs `RAG_SIDECAR_DOCLING_ARTIFACTS`.
- **Fix:** Following the 03-15 hand-off, the job builds `--target docling` and copies `/opt/docling-models` and `/opt/tiktoken` out of the image, then runs offline. This also exercises the open 03-05 item (first real image build). An image build failure fails the job; only an install failure of the extra skips with the notice.
- **Files modified:** `.github/workflows/nightly.yml`, `scripts/ci/check-workflows.py`
- **Committed in:** `01ee769`

**5. [Plan edit] Extra checker unit tests**
- **Issue:** the new `check_real_docling` branch had no test.
- **Fix:** `RealDoclingJobTest` (5 tests) in `scripts/tests/test_check_workflows.py`, which PR CI already runs.
- **Committed in:** `01ee769`

---

**Total deviations:** 5 (2 Rule 2, 1 Rule 1, 1 Rule 3, 1 plan edit)
**Impact on plan:** No scope creep; all five close gaps between the plan text and what the checks need.

## Issues Encountered
Findings from running real Docling (locked 2.150.1, models via `docling-tools`, in an existing scratch environment outside the worktree; nothing installed or locked) over these PDFs. They matter to later plans:

1. **Real Docling merges adjacent short Latin lines into one paragraph.** On `invoice-en` and `invoice-it` the whole key-value header ("Invoice No.: ... Invoice date: ... Supplier: ...") came back as one line, and `extract_invoice` on the real Markdown returned confidence 0.0 with every field missing; `invoice-zh` was fine (confidence 1.0). A 16 pt paragraph gap did not change this. The recordings are idealized from the specs (as the plan decided), so 03-29/03-44 tests on them extract perfectly. 03-29 should either make the extractor tolerate merged lines or lean on `RAG_INVOICE_LLM_EXTRACT`, and the nightly report now records `invoice_extraction` per invoice so the gap stays visible.
2. **`table_header` is `None` when a table starts after the first six lines of a chunk** (`_table_header` in `docling_adapter.py` scans only six lines). It affects the invoice chunk only; the header rows are still inside the chunk text. Left alone (03-15's file, outside this plan); nothing in the plan depends on it.
3. **OCR (D7 of 03-15):** clean 200 dpi synthetic scans, PP-OCRv6 `ch` model: zh 4/4 and en 4/4 key phrases, it 4/5 (strict and folded the same, so `è` was read). The first Italian paragraph came back as "...collaudata Innt n n l ut n na s le", losing its second line including "unità". Spacing is lost in places (`on15 March`, `验收编号AC-2025-0231`).
4. Real heading levels differ from the spec levels ("2.1 费用科目表" came back as level 1, so the report table's path is only that heading, not three levels); the real test therefore checks the last heading for the report and the exact path for the contract (which matched).
5. Picture detection worked on the synthetic pictures (pages 1 and 2, page share 0.121).
6. `uv run --directory eval python ../scripts/ci/check-workflows.py` (the plan's verify) needs PyYAML, which the eval env only gets through the judge and draft extras; it passes in PR CI (all extras) and as `python3 scripts/ci/check-workflows.py`.
7. The scans were rendered here with WenQuanYi Zen Hei (the font available in this sandbox); the nightly renders its own scans with Noto Sans CJK (face index 2, SC). Noto is not installed here, so that path is untested.

## User Setup Required
None - no external service configuration required.

## Known Stubs
None. The inert generator used for the Task 1 RED commit was replaced in `1851e8e`.

## Threat Flags
None. The new CI surface (apt install, docker build, docker cp) runs in the nightly job without secrets; the model download stays the existing, accepted T-03-13 build-time step.

## Next Phase Readiness
- 03-27 can serve recorded ParseResults from `manifest.json` by `file_sha256`; `recorded.artifacts` maps artifact names (`docling.json`, `picture-N.png`) to files.
- 03-41/03-44 find the expected facts under each entry's `expected`; 03-38 reads the images fixture and its two PNG artifacts; 03-19 can use `text/contract-zh.md` and the clause facts.
- Operator: the first nightly run proves the image build, `docker cp`, the Noto face index and the offline run; its `real-docling-report` artifact holds the measured OCR hit rates.

## Gate Results
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npx vitest run`: 120 files, 1541 tests passed
- `node --import tsx --test tests/*.test.mts`: 143 passed (no langfuse-pins ENOENT)
- `node scripts/ci/check-rag-boundary.mjs`: ok (670 files); `python3 scripts/ci/check-workflows.py`: OK; `node scripts/check-config.mjs`: ok (93 variables)
- `cd rag-sidecar && uv run --frozen pytest -q`: 554 passed, 10 skipped (the real_docling module and docling-extra tests skip without models)
- `uv run --directory eval pytest -q` (all extras): 364 passed; `python3 -m unittest discover -s scripts/tests -p test_check_workflows.py`: 13 passed
- Real Docling (scratch environment, locked versions): `pytest -m real_docling tests/test_real_docling.py` 39 passed, also with an empty HF cache and `HF_HUB_OFFLINE=1`
- `uv.lock` files and `package*.json` are unchanged from the plan base
- Acceptance: `pdf/*.pdf` 12 (>= 9), `invariant` in generate_pdfs.py 3 (>= 1), manifest fixtures 12 (>= 12), `recorded/*.parse.json` 12 (>= 9), `real_docling` in nightly.yml 1 (>= 1)

---
*Phase: 03-unified-ingestion-embedding-profiles*
*Completed: 2026-11-24*

## Self-Check: PASSED

All created files exist, commits 28395df, 1851e8e, b2c9b12, 92e72a1 and 01ee769 are ancestors of HEAD, the acceptance counts were re-run, and the stub scan found nothing.
