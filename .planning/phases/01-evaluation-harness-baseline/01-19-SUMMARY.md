---
phase: 01-evaluation-harness-baseline
plan: 19
subsystem: testing
tags: [python, golden-set, drafting, claude, ragas, supabase, tenant-isolation, pydantic, eval]

requires:
  - phase: 01-evaluation-harness-baseline
    provides: "01-06 chunk_matches_span, normalize_text, freeze_splits and split manifest; 01-13 golden_io and load_corpus; 01-07/01-08 fixture corpora; 01-18 judge config and telemetry opt-out pattern"
provides:
  - "rag_eval.draft.sources: WorkspaceDocument, DirectoryWorkspaceSource, tenant-filtered SupabaseWorkspaceSource"
  - "rag_eval.draft.verify: verify_proposal, index_documents (every drafted span checked with chunk_matches_span)"
  - "rag_eval.draft.writer: write_drafted_items, assert_private_path, PrivatePathError, DraftedEntry, DraftOutcome, PRIVATE_DIR (private-path guard, dedup, deterministic ids, frozen splits, byte-stable output, notes sidecar)"
  - "rag_eval.draft.config + eval/config/draft.json: DraftConfig, load_draft_config (claude-sonnet-5-5, 50..200 items, zh/en/it, 3 personas, 4 Ragas styles, 3 lengths)"
  - "rag_eval.draft.claude_drafter.draft_with_claude and rag_eval.draft.ragas_drafter.draft_with_ragas, rows_to_proposals, plan_buckets, build_pinned_synthesizer"
  - "python -m rag_eval.draft CLI (exit codes 0/2/3/6)"
affects: [01-20, 01-22, live golden-set drafting, EVAL-05 live check]

plan_head_before: d3199ac00ca472583d62a136937ffa96428f63d
plan_head_after: 554cd6b993e7fef29c937bc855410cf3bd0227e7

actuals:
  tokens: 18400
  tasks: 2
  commits: 3

tech-stack:
  added: []
  patterns:
    - "Private-output guard runs before any other work and fails closed: path resolves under eval/golden/private/, git check-ignore exits 0, git ls-files is empty, and any git failure refuses the write"
    - "Service-role reads need exactly one validated UUID scope, filter every documents request by it, fetch chunks only for returned document ids and drop foreign rows"
    - "Drafters return DraftOutcome(entries, rejected) so rejections are counted by reason without logging document text"
    - "Per-item drafting metadata (drafter, Ragas style, length, persona) goes to a gitignored <out>.notes.json sidecar because GoldenItem forbids extra fields"

key-files:
  created:
    - eval/src/rag_eval/draft/__init__.py
    - eval/src/rag_eval/draft/__main__.py
    - eval/src/rag_eval/draft/config.py
    - eval/src/rag_eval/draft/sources.py
    - eval/src/rag_eval/draft/verify.py
    - eval/src/rag_eval/draft/writer.py
    - eval/src/rag_eval/draft/claude_drafter.py
    - eval/src/rag_eval/draft/ragas_drafter.py
    - eval/src/rag_eval/draft/cli.py
    - eval/config/draft.json
    - eval/tests/test_draft_sources.py
    - eval/tests/test_draft_writer.py
    - eval/tests/test_draft_cli.py
  modified: []

key-decisions:
  - "Claude drafting sends no temperature and no forced tool_choice: claude-sonnet-5-5 rejects non-default sampling values and forced tool_choice with HTTP 400, so the request uses tool_choice auto plus an instruction to call the tool, and the tool input is validated with DraftedItemBatch.model_validate (falling back to per-item validation to salvage valid items)"
  - "Ragas generate_fn is called once with a list of (style, length, count) buckets and the personas; the live implementation builds the knowledge graph once and pins each bucket's style and length through a SingleHopSpecificQuerySynthesizer subclass that overrides convert_to_scenario"
  - "Style, length and persona go to a <out>.notes.json sidecar next to the private output instead of a new GoldenItem field, so the shared Pydantic/Zod contract is untouched; real user-style categories (colloquial, ambiguous, typo) are Phase 2 (EVAL-14) and are asked of Claude only as wording styles inside the existing seven categories"
  - "write_drafted_items takes optional manifest_path and notes_path (both also checked as private) so tests never touch the real eval/golden/private/split-manifest.json"
  - "Directory sources accept corpus/<lang> as well as corpus/: a lone language directory is read through load_corpus with that language only, so chunks equal rag_eval.corpus output"
  - "Supabase chunk text has the stored 'Document: ... Chunk n of m. Content:' prefix removed and is ordered by metadata.chunk_index; documents without chunks are dropped"

patterns-established:
  - "Two-stage validation of drafted evidence: contract validation in the writer (invalid items counted) after verbatim-span verification in verify"

requirements-completed: []

coverage:
  - id: D1
    description: "Drafted items whose quote is not a normalized substring of a chunk of the named document, or that name an unknown document, are rejected with chunk_matches_span, in the Claude path and the Ragas path"
    requirement: EVAL-05
    verification:
      - kind: unit
        ref: "eval/tests/test_draft_writer.py::test_verify_*; eval/tests/test_draft_cli.py::test_claude_stub_proposals_keep_only_valid_unique_verified_items, ::test_ragas_rows_become_verbatim_span_proposals_with_style_and_persona_notes"
        status: pass
    human_judgment: false
  - id: D2
    description: "Output can only land in the gitignored eval/golden/private/ (resolved path check, git check-ignore, empty git ls-files, fail closed on git errors); the CLI exits 6 and writes nothing otherwise"
    requirement: EVAL-05
    verification:
      - kind: unit
        ref: "eval/tests/test_draft_writer.py::test_write_refuses_* (outside path, traversal, tracked file, not ignored, git failure); eval/tests/test_draft_cli.py::test_cli_output_outside_the_private_directory_exits_6"
        status: pass
    human_judgment: false
  - id: D3
    description: "Supabase reads are tenant-scoped: exactly one UUID scope, scope filter on every documents request, chunks fetched only for returned ids in batches of 100, foreign chunk rows dropped, service key only in headers and never in errors"
    requirement: EVAL-05
    verification:
      - kind: unit
        ref: "eval/tests/test_draft_sources.py (httpx.MockTransport recorder, 15 cases)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Ids are draft-<lang>-<10 hex of sha256(normalized question)>, splits come from freeze_splits and the private manifest, an id already in the manifest keeps its split, adjacent duplicate questions are skipped, output is sorted by id and byte-identical on re-run"
    requirement: EVAL-05
    verification:
      - kind: unit
        ref: "eval/tests/test_draft_writer.py::test_ids_come_from_the_normalized_question_and_splits_are_frozen, ::test_duplicate_questions_are_skipped_*, ::test_output_is_sorted_by_id_and_byte_identical_on_rerun; eval/tests/test_draft_cli.py::test_cli_rerun_is_byte_identical"
        status: pass
    human_judgment: false
  - id: D5
    description: "Empty workspace exits 2 with 'no documents' before any LLM call and creates no file; --n outside 50..200 exits 2; missing Anthropic, OpenRouter/OpenAI or Supabase credentials exit 3"
    requirement: EVAL-05
    verification:
      - kind: unit
        ref: "eval/tests/test_draft_cli.py::test_cli_empty_workspace_exits_2_before_any_llm_call, ::test_cli_n_outside_the_range_exits_2, ::test_cli_missing_anthropic_key_exits_3, ::test_cli_missing_ragas_keys_exit_3, ::test_cli_supabase_source_needs_exactly_one_scope_and_credentials"
        status: pass
    human_judgment: false
  - id: D6
    description: "The Ragas drafter spreads items across query styles (perfect grammar, poor grammar, web-search-like, misspelled), short/medium/long lengths and three personas, records style/length/persona per item, and Claude is asked for colloquial, ambiguous and no_answer questions"
    requirement: EVAL-05
    verification:
      - kind: unit
        ref: "eval/tests/test_draft_cli.py::test_ragas_generate_is_called_with_more_than_one_style_length_and_persona, ::test_plan_buckets_spreads_small_counts_over_distinct_styles, ::test_pinned_synthesizer_forces_style_and_length, ::test_claude_request_names_categories_languages_and_the_real_user_mix"
        status: pass
    human_judgment: false
  - id: D7
    description: "Live run with ANTHROPIC_API_KEY, OPENROUTER_API_KEY, OPENAI_API_KEY and a real workspace yields 50-200 reviewable items across zh/en/it and all seven categories; the claude-sonnet-5-5 request and the Ragas TestsetGenerator wiring work as configured; the user reviews every item and sets approved or rejected"
    requirement: EVAL-05
    verification: []
    human_judgment: true
    rationale: "Needs live keys, a real knowledge base and the user's review of every drafted item; none exist in this environment"
---

# Phase 1 Plan 19: Golden-Set Drafting Tool Summary

**`python -m rag_eval.draft` drafts 50-200 span-labelled golden items from a directory or a tenant-scoped Supabase workspace with Claude and Ragas (mixed query styles and personas), rejects any non-verbatim quote, freezes splits, and can write only to the gitignored `eval/golden/private/`, proven offline with stub drafters and a mock Supabase transport**

## Performance

- **Tasks:** 2 (Task 1 as RED then GREEN commits; Task 2 as one commit with its tests)
- **Files modified:** 13 (all created)
- **Suites:** eval pytest 166 passed (59 new: 33 in Task 1, 26 in Task 2), rag-sidecar pytest 131 passed, `npm test` 67 passed, `npm run test-rag` valid

## Accomplishments
- `SupabaseWorkspaceSource` refuses zero or two scopes, validates scope values as UUIDs, puts the scope on every documents request (organization: `organization_id=eq.<org>`; personal: `user_id=eq.<uid>` plus `organization_id=is.null`; single-tenant: `organization_id=is.null` and only with the explicit flag), pages by 1000, fetches chunks only for returned ids in batches of 100 and drops foreign rows; the key is sent only in headers and errors carry only the HTTP status.
- `write_drafted_items` runs the three private-path checks (resolved path under `eval/golden/private/`, `git check-ignore`, empty `git ls-files`; any git failure refuses) before anything else, then dedups on `normalize_text(question)`, assigns `draft-<lang>-<10 hex>` ids, takes splits from the private manifest or the frozen hash rule, and writes sorted, byte-stable JSONL.
- `draft_with_claude` batches documents under a character budget, asks for items through one tool whose schema is `DraftedItemBatch`, covers all seven categories and the real-user mix (colloquial, ambiguous, typos, no_answer), and salvages valid items when some fail validation; refusals and missing tool calls are reported as rejections.
- `draft_with_ragas` plans (style, length, count) buckets over four styles and three lengths, passes three personas, and converts rows to proposals by locating the context chunk, quoting the sentence closest to the reference answer, detecting zh/it/en, and classifying table/exact_term/general; the live path builds the knowledge graph once and pins each bucket's style through a synthesizer subclass.
- The CLI prints drafted, rejected (by reason, document names masked) and written counts plus language and category tallies, never document text, and writes `<out>.notes.json` with drafter, style, length and persona per item.

## Task Commits

1. **Task 1: Workspace sources, quote verification and private writer** - `3cb24b0` (test, RED), `6687fd4` (feat, GREEN)
2. **Task 2: Drafters, config, CLI** - `554cd6b` (feat, with its tests)

`commits: 3` is the measured `rev-list` count since the plan began.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] The plan's Claude request shape would be rejected by claude-sonnet-5-5**
- **Found during:** Task 2 (checking the Claude API reference before wiring the call)
- **Issue:** The plan asks for `temperature 0` and a single tool; claude-sonnet-5-5 returns HTTP 400 for non-default `temperature` and for forced `tool_choice` (`any`/`tool`).
- **Fix:** The request sends no `temperature`, uses `tool_choice: {"type": "auto"}` with the tool named in the prompt, and validates the tool input with `DraftedItemBatch.model_validate` (per-item fallback). Determinism of the tool output is not guaranteed; byte-stability is guaranteed for the writer given the same proposals.
- **Files modified:** `eval/src/rag_eval/draft/claude_drafter.py`
- **Commit:** `554cd6b`

**2. [Rule 2 - Missing critical functionality] Style, length and persona have no slot in GoldenItem**
- **Found during:** Task 2
- **Issue:** The revision note asks to record style and persona per item; `GoldenItem` forbids extra fields and the contract is shared with the Zod schemas.
- **Fix:** A sorted, byte-stable `<out>.notes.json` sidecar in the same gitignored directory (also path-checked), keyed by item id.
- **Commit:** `554cd6b`

**3. [Plan shape] Extra optional parameters and a config schema beyond the plan's list**
- `write_drafted_items(..., manifest_path=, notes_path=)` and the CLI `--split-manifest` and `--config` options exist so tests never touch the real manifest; `DraftConfig` also carries `batch_chars`, `ragas_styles`, `ragas_lengths` and `personas` (from the revision note).

**4. [Plan shape] Task 2 had no separate RED commit**
- The Task 2 tests passed on the first run after implementation and were committed with it; Task 1 has the RED then GREEN pair.

## Issues Encountered
`httpx` and `anthropic` live in the `draft` extra and `ragas` in `judge`/`draft`; the draft tests need those extras installed (they are in this environment's `eval/.venv`). A fresh CI environment must sync with the `draft` extra.

## User Setup Required
Live drafting (coverage D7) is manual: set `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, then

`uv run --directory eval python -m rag_eval.draft --source supabase --org <org-uuid> --out eval/golden/private/golden-v1.jsonl --n 120`

Review every item in the output (set `review_status` to approved or rejected), check `git status` shows nothing under `eval/golden/private`, and confirm the `claude-sonnet-5-5` request and the Ragas `TestsetGenerator` wiring (LangChain wrappers around the OpenRouter judge model and OpenAI embeddings) work, correcting `eval/config/draft.json` or the wiring if not. The Ragas live path was only constructed offline (no network call); the Supabase REST filters were proven against a mock transport, not a live project.

## Next Phase Readiness
EVAL-05 stays Pending until the live drafting run and the user's review (D7). EVAL-03 was already complete from earlier plans. Items drafted here are `claude_draft` or `ragas_generated` and are coverage items, not representative of real users (EVAL-14 in Phase 2 adds the colloquial, ambiguous and typo categories and provenance slicing).

## Known Stubs
None. The stub Claude client and stub Ragas generate function live only in `eval/tests/test_draft_cli.py`.

## Threat Flags
None beyond the plan's threat model (T-01-27 to T-01-30 are mitigated and covered by the tests above; T-01-SC unchanged, no new dependencies).

## Self-Check: PASSED
