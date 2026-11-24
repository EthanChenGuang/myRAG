---
phase: 03-unified-ingestion-embedding-profiles
plan: 15
subsystem: ingestion
tags: [docling, docling-core, rapidocr, pp-ocrv6, hybridchunker, tiktoken, pypdfium2, pytest, github-actions]

requires:
  - phase: 03-unified-ingestion-embedding-profiles
    provides: "03-05 locked docling 2.150.1 / docling-core 2.107.1 / huggingface_hub 1.33.0 / transformers 5.23.0 / torch 2.15.0+cpu and the docling Dockerfile target; 03-12 parse job runner, Converter protocol and LazyDoclingConverter"
provides:
  - "to_parse_result: DoclingDocument to ParseResult with repeated, visible Markdown table headers, cl100k_base bounded chunks, heading paths, pages, pictures and the docling.json artifact"
  - "DoclingConverter: RapidOCR (onnxruntime, one PP-OCRv6 code) pipeline, image and PDF sharing one set of pipeline options, partial and failure mapping, json_docling re-chunk without a pipeline"
  - "probe.text_layer_page_share (pypdfium2) and the real_docling pytest marker"
  - "PR CI python job syncs and runs the sidecar tests with the light chunking extra"
affects: [03-12 job runner (default_converter now resolves a real DoclingConverter), 03-25 fixture generator and nightly real-Docling job, ingest core and the parser chain, image chunks (D-29)]

actuals:
  tokens: 49000
  tasks: 3
  commits: 5
plan_head_before: 1bb17723d342d0193e1279efa9dda871088dbcd4
plan_head_after: 7e28cd56dcfbfc84a3c3df0a0e348f0f19ff705d

tech-stack:
  added: []
  patterns: ["converter_factory injection so converter logic is tested with a fake Docling converter in the light CI environment", "heavy imports (docling, pypdfium2) only inside functions; docling-core is the only module-level dependency", "status compared by enum value so tests need no Docling classes"]

key-files:
  created:
    - rag-sidecar/src/rag_sidecar/parse/probe.py
    - rag-sidecar/tests/fixtures/docling/build_fixtures.py
    - rag-sidecar/tests/fixtures/docling/table-report.json
    - rag-sidecar/tests/fixtures/docling/headings-zh.json
    - rag-sidecar/tests/fixtures/docling/pictures.json
    - rag-sidecar/tests/test_docling_adapter.py
  modified:
    - rag-sidecar/src/rag_sidecar/parse/docling_adapter.py
    - rag-sidecar/src/rag_sidecar/parse/converter.py
    - rag-sidecar/pyproject.toml
    - .github/workflows/pr-smoke.yml
    - scripts/ci/check-workflows.py

key-decisions:
  - "ParseJobRequest has no timeout field, so the 120 s document timeout is a DoclingConverter constructor default (DEFAULT_DOCUMENT_TIMEOUT_SECONDS), not a request value; adding a field would change the contract exported by earlier plans"
  - "json_docling inputs are re-chunked straight from docling-core (DoclingDocument.model_validate) instead of through DocumentConverter, so no pipeline is built and it runs without the docling extra"
  - "Input format comes from request.input_format, else is sniffed from the leading bytes, because the uploaded file is named input.bin; Docling gets a DocumentStream with a matching name"
  - "Profile options drive the pipeline: table_mode fast maps to TableFormerMode.FAST, accurate to ACCURATE, off disables table structure; heading_hierarchy and generate_picture_images follow the request"
  - "The PP-OCRv6 recognition code set (52 codes) is hardcoded so validation works without rapidocr, and a test compares it with the installed rapidocr when present"

patterns-established:
  - "Docling tests are layered: docling-core only (light CI), docling installed (options, skipped in light CI), real_docling (needs baked models via RAG_SIDECAR_DOCLING_ARTIFACTS)"

requirements-completed: [DATA-05]

coverage:
  - id: D1
    description: "Every table chunk begins with the header row and the |---| separator row, and table_header equals those two lines"
    requirement: "DATA-05"
    verification:
      - kind: unit
        ref: "rag-sidecar/tests/test_docling_adapter.py#test_every_table_chunk_starts_with_the_header_row_and_separator"
        status: pass
      - kind: unit
        ref: "rag-sidecar/tests/test_docling_adapter.py#test_table_header_is_the_header_row_and_separator_of_each_table_chunk"
        status: pass
    human_judgment: false
  - id: D2
    description: "Chunks carry outermost-first heading paths, pages and contextualized text, all within max_tokens on cl100k_base"
    requirement: "DATA-05"
    verification:
      - kind: unit
        ref: "rag-sidecar/tests/test_docling_adapter.py#test_every_contextualized_text_is_within_max_tokens_on_cl100k"
        status: pass
      - kind: unit
        ref: "rag-sidecar/tests/test_docling_adapter.py#test_chinese_headings_come_outermost_first_with_their_pages"
        status: pass
    human_judgment: false
  - id: D3
    description: "Pictures carry page, bbox, page_area_share and an artifact name; docling.json is an artifact; a json_docling input re-chunks with no pipeline and keeps the stored parser fields"
    requirement: "DATA-05"
    verification:
      - kind: unit
        ref: "rag-sidecar/tests/test_docling_adapter.py#test_pictures_carry_page_bbox_share_and_an_artifact_name"
        status: pass
      - kind: unit
        ref: "rag-sidecar/tests/test_docling_adapter.py#test_a_stored_docling_json_is_rechunked_without_a_pipeline_and_keeps_its_parser_fields"
        status: pass
    human_judgment: false
  - id: D4
    description: "The converter sets RapidOCR (onnxruntime, ch) with full-page OCR when forced, heading hierarchy, table mode, picture images, timeout and artifacts path; unsupported OCR languages raise; PARTIAL_SUCCESS gives partial with a warning; over-cap documents raise page_cap"
    requirement: "DATA-05"
    verification:
      - kind: unit
        ref: "rag-sidecar/tests/test_docling_adapter.py#test_scanned_requests_use_rapidocr_on_onnxruntime_with_full_page_ocr_and_the_baked_models (docling installed)"
        status: pass
      - kind: unit
        ref: "rag-sidecar/tests/test_docling_adapter.py#test_to_ppocr_code_rejects_a_language_outside_the_pp_ocr_v6_set"
        status: pass
      - kind: integration
        ref: "pytest -m real_docling with baked models: text PDF and scanned PNG through the image option, plus a real page-cap rejection (scratch environment, not committed CI)"
        status: pass
    human_judgment: false
  - id: D5
    description: "text_layer_page_share is measured with pypdfium2 before conversion"
    requirement: "DATA-05"
    verification:
      - kind: unit
        ref: "rag-sidecar/tests/test_docling_adapter.py#test_the_text_layer_probe_counts_pages_with_text_and_ignores_the_rest (pypdfium2 installed)"
        status: pass
    human_judgment: false
  - id: D6
    description: "The PR python job installs the light chunking extra and runs the sidecar tests with it; the workflow checker requires both commands"
    requirement: "DATA-05"
    verification:
      - kind: other
        ref: "python3 scripts/ci/check-workflows.py (OK; fails when either command is removed)"
        status: pass
    human_judgment: true
    rationale: "The workflow YAML has not run on a GitHub runner yet; only its structure and the equivalent local commands were verified"
  - id: D7
    description: "OCR quality on real scanned Chinese and Italian documents with PP-OCRv6 (assumption A1)"
    requirement: "DATA-05"
    verification: []
    human_judgment: true
    rationale: "Only an English synthetic PNG was OCRed here; zh and it accuracy, including Italian diacritics, needs real scans (the nightly real-Docling job in 03-25 or manual review). Tesseract stays the documented fallback"

duration: 40min
completed: 2026-11-24
status: complete
---

# Phase 3 Plan 15: Docling adapter Summary

**DoclingDocument to ParseResult adapter with visible repeated table headers (Markdown serializer, cl100k_base HybridChunker), plus a DoclingConverter that runs RapidOCR PP-OCRv6 on onnxruntime for zh/en/it, a pypdfium2 text-layer probe, and light-extra sidecar tests on every PR**

## Performance

- **Duration:** about 40 min for this continuation; Task 1 RED and GREEN were restored from a patch (committed 01:51 UTC)
- **Completed:** 2026-11-24T02:20:00Z
- **Tasks:** 3 of 3
- **Files changed vs plan base:** 11 (4 sidecar source or config files, 4 fixture and builder files, 1 test file, 2 CI files; counted from `git diff --name-only`)

## Accomplishments
- `to_parse_result` chunks with `HybridChunker(OpenAITokenizer(cl100k_base, max_tokens), repeat_table_header, MarkdownTableProvider)`, so every table chunk starts with the header row and the `|---|` row; headings, pages, contextualized text, pictures (page, bbox, area share) and the `docling.json` artifact are mapped into the contract.
- `DoclingConverter` builds one `DocumentConverter` per distinct option set (PDF and image formats share the same `PdfPipelineOptions`), sets `RapidOcrOptions(backend="onnxruntime", lang=["ch"])`, heading-hierarchy inference, table mode, picture images, a 120 s document timeout and the baked artifacts path from settings; full-page OCR when the profile forces it.
- Failure handling: `PARTIAL_SUCCESS` gives `partial` plus the warning `docling_partial_success`; other statuses raise `conversion_failed`, or `page_cap` when the input exceeded the cap; an OCR language outside the PP-OCRv6 set raises `configuration_error` (no fallback).
- `json_docling` inputs are re-chunked with no layout or OCR model and keep the stored `parser` and `parser_version`; the input format is taken from the request or sniffed from the leading bytes.
- `probe.text_layer_page_share` counts pages with at least 10 text characters via pypdfium2, and returns None without pypdfium2, for unreadable files or over-cap documents.
- PR CI `python` job: `uv sync --directory rag-sidecar --locked --extra chunking` and `uv run --directory rag-sidecar --extra chunking pytest -q`; `check-workflows.py` requires both and rejects the heavy `docling` extra in that job.

## Task Commits

1. **Task 1: Recorded DoclingDocument fixtures and the adapter to ParseResult** (TDD)
   - RED: `89d8ef5` (test), restored from a patch; failed on assertions against a skeleton adapter
   - GREEN: `16a412f` (feat), restored from a patch
2. **Task 2: DoclingConverter, OCR language validation and the text-layer probe** (TDD)
   - RED: `eaf25aa` (test) - 22 failed on assertions in the light environment and 28 in the full one, against inert stubs (empty `to_ppocr_code`, a default `PdfPipelineOptions`, a converter returning an empty result)
   - GREEN: `fbb94ed` (feat)
3. **Task 3: PR CI runs the sidecar tests with the chunking extra** - `7e28cd5` (ci)

**Plan metadata:** the commit that adds this SUMMARY (docs: complete plan). `commits: 5` is measured from the plan base `1bb1772` (the pause commit); the ledger file did not exist in this worktree, so it was created at that base.

## Files Created/Modified
- `rag-sidecar/src/rag_sidecar/parse/docling_adapter.py` - adapter, converter, pipeline options, language mapping, input sniffing
- `rag-sidecar/src/rag_sidecar/parse/probe.py` - text-layer page share
- `rag-sidecar/src/rag_sidecar/parse/converter.py` - `ConfigurationError` (error class `configuration_error`)
- `rag-sidecar/tests/test_docling_adapter.py` - 51 tests: contract tests from recorded JSON, converter tests with a fake Docling converter, probe tests, two `real_docling` tests
- `rag-sidecar/tests/fixtures/docling/*` - deterministic builder and three recorded DoclingDocument JSON files
- `rag-sidecar/pyproject.toml` - `real_docling` marker only; no dependency, lock or pin change
- `.github/workflows/pr-smoke.yml`, `scripts/ci/check-workflows.py` - light-extra sidecar tests and their needles

## Decisions Made
See `key-decisions` above. Assumption A2 (research): verified against the installed docling 2.150.1 in a scratch environment synced from the existing lock with `--frozen`. `PdfFormatOption(pipeline_options=...)`, `ImageFormatOption(pipeline_options=...)` and `DocumentConverter(allowed_formats=..., format_options=...)` have the planned keyword-only signatures; `DocumentConverter.format_to_options` exposes the options; `convert(source, raises_on_error, max_num_pages, ...)` takes a Path or `DocumentStream` (the call is strict-validated, so a plain str is rejected); `RapidOcrOptions` takes `mode=OcrMode.FULL_PAGE`, and `force_full_page_ocr` is a deprecated view over `mode`. A page-capped input is rejected as invalid input before any model loads, and `rapidocr` 3.10.0 lists 52 PP-OCRv6 recognition codes including `ch`, `en` and `it`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `ConfigurationError` did not exist**
- **Found during:** Task 2 (RED)
- **Issue:** The plan requires a `ConfigurationError` for unsupported OCR languages, but the sidecar only had `ConversionError` and `PageCapExceeded`; `converter.py` is not in the plan's `files_modified`.
- **Fix:** Added `ConfigurationError(ConversionError)` with error class `configuration_error` next to `PageCapExceeded`.
- **Files modified:** `rag-sidecar/src/rag_sidecar/parse/converter.py`
- **Verification:** `test_to_ppocr_code_rejects_a_language_outside_the_pp_ocr_v6_set`
- **Committed in:** `eaf25aa`

**2. [Rule 3 - Blocking] The request carries no document timeout**
- **Found during:** Task 2
- **Issue:** The plan asks for "the request's document timeout (default 120 s)", but `ParseJobRequest` has no such field, and adding one would change the contract and the generated schemas owned by earlier plans.
- **Fix:** `DoclingConverter(document_timeout_seconds=120.0)` is the single source; the request is unchanged.
- **Files modified:** `rag-sidecar/src/rag_sidecar/parse/docling_adapter.py`
- **Verification:** the options test asserts `document_timeout == 120`
- **Committed in:** `fbb94ed`

**3. [Plan edit] json_docling goes through docling-core, not DocumentConverter**
- **Found during:** Task 2
- **Issue:** Research Pattern 4 suggested submitting the stored JSON through Docling's `JSON_DOCLING` input. That needs the heavy extra, and the stored sidecar metadata (`x_rag_sidecar`) is not part of the Docling JSON schema.
- **Fix:** The stored JSON is validated with `DoclingDocument.model_validate` after the metadata is read, so it needs only docling-core and is testable in the light CI environment. Behaviour matches the plan (no layout or OCR model; parser fields kept).
- **Verification:** `test_a_stored_docling_json_is_rechunked_without_a_pipeline_and_keeps_its_parser_fields`

---

**Total deviations:** 3 (2 Rule 3, 1 plan edit)
**Impact on plan:** No scope creep; the first two close gaps between the plan text and the existing contract.

## Issues Encountered
- Real conversion could only be checked outside the committed CI: in a scratch environment synced from the existing lock (`uv sync --frozen --extra docling`, no relock, outside the worktree) with models fetched by `docling-tools models download`. The two `real_docling` tests pass there (a text PDF; a scanned PNG through the image option with full-page OCR, which read the English text), and a 2-page PDF with `page_cap=1` is rejected as `page_cap`. They skip in the committed CI unless `RAG_SIDECAR_DOCLING_ARTIFACTS` points to baked models.
- OCR quality on Chinese and Italian scans is unmeasured (D7 above).
- A document that is only a heading yields zero chunks from `HybridChunker` (seen on the synthetic scan); the ingest core should treat an empty chunk list as a quality signal.
- The adapter warns `picture_image_unavailable` for pictures with no image data, which happens for every picture when a profile sets `generate_picture_images` false (contract_legal, invoice_receipt); a consumer that treats warnings as failures should ignore it for those profiles.
- Test counts: adapter file 42 passed and 9 skipped in the light environment (docling-core only), 49 passed and 2 skipped with the docling extra; a base environment with no extras skips the module (422 passed, 1 skipped for the whole sidecar suite).

## Known Stubs
None. The inert stubs used for the RED commit were replaced in `fbb94ed`.

## Threat Flags
None. T-03-45 is mitigated here by `max_num_pages`, the per-document timeout and partial results (the pool and page cap stay with 03-12); T-03-46 by the language validation that raises instead of falling back.

## User Setup Required
None - no external service configuration required. Operator note: the real conversion path depends on the baked models from the 03-05 `docling` image target; build it once to confirm.

## Next Phase Readiness
- `default_converter()` now resolves a working `DoclingConverter` wherever the docling extra is installed.
- The nightly real-Docling job (03-25) can run `pytest -m real_docling` with `RAG_SIDECAR_DOCLING_ARTIFACTS` set to the baked model directory.

## Gate Results
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npx vitest run`: 119 files, 1534 tests passed
- `node --import tsx --test tests/*.test.mts`: 143 passed (no langfuse-pins ENOENT in this worktree)
- `node scripts/ci/check-rag-boundary.mjs`: ok; `python3 scripts/ci/check-workflows.py`: OK; `node scripts/check-config.mjs`: ok (93 variables)
- `cd rag-sidecar && uv run --frozen pytest -q`: 464 passed, 9 skipped; `tests/test_torch_cpu_lock.py`: 2 passed, and `rag-sidecar/uv.lock` and `eval/uv.lock` are byte-identical to the plan base
- Acceptance: `MarkdownTableSerializer` 2 (needs >= 1), `RapidOcrOptions` 2 (>= 1), `real_docling` in pyproject 1 (>= 1), `extra chunking` in pr-smoke.yml 2 (>= 2)

---
*Phase: 03-unified-ingestion-embedding-profiles*
*Completed: 2026-11-24*

## Self-Check: PASSED

All 11 changed files exist, commits 89d8ef5, 16a412f, eaf25aa, fbb94ed and 7e28cd5 are ancestors of HEAD, the acceptance counts were re-run, and the stub scan found nothing.
