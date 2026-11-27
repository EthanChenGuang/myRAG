---
phase: 05-verified-citations-groundedness
plan: 26
subsystem: testing
tags: [live-verification, anthropic, citations, hhem, docker, groundedness, judge, faithfulness]

requires:
  - phase: 05-verified-citations-groundedness
    provides: "05-25 folded setup files and full gate run; 05-01..05-24 citation strategies, groundedness sidecar, hhem image, nightly judge tier"
provides:
  - "Recorded verdicts for the Phase 5 live verification items that could run in this environment (Task 1, Task 3, Task 4 step 2 on the fixture golden set with OpenRouter)"
  - "Fix: the hhem sidecar image ships config/rag (it exited at startup before)"
  - "Operator-pending list for the items that need keys or the live database (Task 2, Task 4 steps 1 and 3, the Claude-strategy nightly leg)"
affects: [phase-7-defaults, 05.1, gap-closure-websearch-claude-path]

actuals:
  tokens: 9000
  tasks: 4
  commits: 5

tech-stack:
  added: []
  patterns: []

key-files:
  created:
    - .planning/phases/05-verified-citations-groundedness/05-26-TASK1-RESULTS.md
    - .planning/phases/05-verified-citations-groundedness/05-26-SUMMARY.md
  modified:
    - rag-sidecar/Dockerfile
    - rag-sidecar/tests/test_image_config.py

key-decisions:
  - "RAG_GROUNDEDNESS_MAX_PREMISE_TOKENS stays 3000: peak RSS 1.7 GB and p50 4.2 s on 4 vCPU at 3k tokens; 6k tokens costs 3.7 GB and 14.8 s"
  - "The 5000 ms p95 HHEM budget holds only with about 4 vCPU; on 2 vCPU a 3k premise takes about 7.8 s (report-only, groundedness runs in after(), inside the 20000 ms timeout)"
  - "RAG_GROUNDEDNESS_VECTARA_MULTI_TENANT_ACK stays false: no Vectara key, retention terms not recorded"
  - "CLAUDE_WEB_SEARCH_ELIGIBLE stays false until the gap-closure plan for webSearch turns on the direct Claude path lands (A1 holds)"
  - "groundedness-thresholds.json keeps the 0.5 defaults: no real labelled pair set exists under eval/golden/private/"

patterns-established: []

requirements-completed: []

duration: see Performance
completed: 2026-11-27
status: partial
---

# Phase 5 Plan 26: Live verification summary

**On real streams the direct Claude path and chunk-alias both cite correctly, and A1 holds. The HHEM image builds and scores offline. It would not start until a config-copy fix (now on this branch). The 3000-token premise cap is confirmed. The live-generator nightly gives identical retrieval with and without citations and 0 invalid citations. Vectara, Langfuse, the live `rag_answer_records` check and the Claude-strategy nightly leg are operator-pending.**

## Performance

- Task 1 ran in earlier sessions on 2026-11-26 (results in `05-26-TASK1-RESULTS.md`).
- Tasks 3 and 4 ran in this session on 2026-11-27, 01:50–03:30Z, which resumed from an interrupted executor.
- Tasks: 4 checkpoints. 1 and 3 are complete. 2 is operator-pending. 4 is partial (step 2 done on the fixture golden set; steps 1 and 3 are operator-pending).

## Task commits

1. **Task 1: Anthropic spike.** `0a1b8383` and `114bde4d` record the results; they were merged into train 26 from `exec/05-26-t1`.
2. **Task 2: Vectara and Langfuse.** No commit; operator-pending.
3. **Task 3: HHEM image.** `6fb980d2` is the RED test and `a881a710` the fix: the hhem stage copies `config/`.
4. **Task 4: nightly, judge and calibration.** No code. The outputs are under the gitignored `eval/out/05-26-nightly/` and are recorded below.

## Task 1: Anthropic spike (complete; full record in 05-26-TASK1-RESULTS.md)

- **Model ids.** `GET /v1/models` lists all three mapped ids: `claude-opus-5-5`, `claude-sonnet-5-5` and `claude-haiku-5-5`. OpenRouter lists the three OpenRouter ids (A6 closed).
- **Citations on real streams.** 9 of 9 direct turns took `claude-citations` with no fallback. They covered plain, adaptive reasoning and zh on each model. Every citation mapped to the right block with Anthropic's `cited_text`. The median TTFT was 848 ms on the direct path and 1126 ms on OpenRouter (single samples, report-only, D-23).
- **Ineligible turns.** webSearch and MCP turns take chunk-alias on OpenRouter.
- **A1 holds.** Citations and tool use coexist, both with server web search and on the AI SDK client-tool path over 2 steps. That opens a gap-closure plan for webSearch turns on the direct path. `CLAUDE_WEB_SEARCH_ELIGIBLE` stays false until then.
- **Fallback.** An unreachable `ANTHROPIC_BASE_URL` falls back once, in 49 ms, with `citation_strategy_fallback:error`. A bad key gives `status_401`.
- **A5 (8 s first-token timeout).** Every direct first token arrived within 1.8 s, so the 8 s timeout is kept.

## Task 3: HHEM-2.1-Open image (complete)

Environment: cloud container, 4 vCPU, 15 GB RAM, dockerd started locally. Docker Hub answered 429, so the same pinned digest (`python:3.12-slim@sha256:5e2bdb1b…`) was pulled from `mirror.gcr.io`. The proxy CA was added in a scratch copy of the build context only; the committed Dockerfile is unchanged apart from the fix.

1. **Build.** `docker build --target hhem` succeeded. The bake step reported "pinned HHEM and flan-t5-base files baked and loaded offline". It checks the flan-t5-base revision `7bcac572…` and the HHEM safetensors sha256 `634de18a…` and fails on any mismatch. Image size: 1.56 GB content, 5.15 GB on disk.
   - **A4 closed.** The tokenizer loads without `sentencepiece` or `protobuf`, so no new package and no gap plan are needed.
   - **Defect found and fixed.** The hhem stage did not copy `config/`, so the container exited at startup with `RagConfigMissing` (`language-packs.json`). Fixed in `a881a710`. The RED test `6fb980d2` fails on the old Dockerfile (`test_every_image_stage_copies_the_config_next_to_src[hhem]`) and passes now.
2. **Offline run.** `docker run --network none` with the shared secret: `GET /ready` returned `{"status":"ready","scorers":["hhem_2_1_open"]}`.
3. **Latency and memory.** Synthetic, domain-neutral English premises in three premise texts, one hypothesis, 6 calls per size. Latency is HTTP from inside the container. Peak memory is VmHWM of the server process; it is cumulative, so each row is the peak up to that size.

   | Premise (cl100k tokens) | 4 vCPU p50 / max ms | Peak RSS (4 vCPU) | 2 vCPU, 2 GB limit, p50 / max ms | Peak RSS (2 vCPU) |
   | ---: | ---: | ---: | ---: | ---: |
   | 1004 | 871 / 904 | 924 MiB | 1510 / 1727 | 949 MiB |
   | 3006 | 4206 / 4551 | 1688 MiB | 7775 / 7882 | 1698 MiB |
   | 6007 | 14759 / 14788 | 3737 MiB | not run | — |

   - Startup RSS is 77 MiB. The model loads on the first call, which took 4.1 s at 1k.
   - Every call returned `status: scored`, `scorer: hhem_2_1_open`, `truncated: false`. The sidecar does not truncate; the app applies the cap before sending.
   - No OOM under the 2 GB limit.
   - **A3.** Partly held. At the 3000-token cap, memory is 1.7 GB, not the predicted 1–1.5 GB but inside the 2 GB note. The 5 s budget holds on 4 vCPU (max 4.55 s) and not on 2 vCPU (about 7.8 s).
   - **A8.** Memory grows faster than linearly: 0.9, 1.7 and 3.7 GB at 1k, 3k and 6k. That matches the eager-attention arithmetic of P-10, so the cap cannot rise.
   - **Decision.** The cap stays 3000 and the 2 GB memory note stands. Host sizing for the 5000 ms p95 budget is about 4 vCPU. On 2 vCPU, latency is about 7.8 s, still inside `RAG_GROUNDEDNESS_TIMEOUT_MS=20000` and off the answer path. AGENTS.md is not edited (docs only on request). The sizing note is recorded here for the Phase 7 defaults work.
4. **Default image size.** The default (`runtime`) target was built at the last commit before Phase 5 (`666092a2`) and at 05-17 (`64142f1a`, where Phase 5 added the hhem stage): 342,548,900 bytes and 342,577,062 bytes. **Phase 5 adds 28 KB, so it passes.**
   - The current tree's default image is 562 MB. The growth comes from Phase 3.2's `--extra hidden-text` in the runtime stage, not from Phase 5. Recorded for information only.

## Task 4: nightly tier, Faithfulness and calibration (partial)

**Step 2 (run).** The live generator was OpenRouter `anthropic/claude-haiku-5.5`, through the proxy. The run used the committed fixture golden set: 308 items, single-tenant, PGlite. There is no real golden set (`eval/golden/private/` does not exist).

- `npx tsx eval/harness/run-nightly.mts --generator live --generator-model anthropic/claude-haiku-5.5 --out eval/out/05-26-nightly/off`: 308 traces, Pydantic-valid traces and manifest, exit 0.
- The same command with `--citations` and `--out eval/out/05-26-nightly/chunk-alias`: 308 traces, valid, exit 0.
- `rag_eval.runner score` on both legs. Pre-generation metrics are **identical** in all 14 overall values: recall@5 0.621, recall@10 0.621, MRR 0.603, nDCG 0.606, correct refusal 0.368, false refusal 0.277, k_zero 48, and the rest. So citations change nothing before generation.

| Leg | Strategy | Items | Generation p50 / p95 ms | invalid_citation_rate | citation_coverage | cited_gold_hit | Faithfulness |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| off | none | 210 answered | 2099 / 3702 | — | — | — | FAITH_OFF |
| citations | chunk-alias | 208 | 2266 / 3889 | 0.000 (n=292) | 0.981 | 0.898 | FAITH_CA |

JUDGE_NOTE

**Claude-strategy leg (`RAG_CLAUDE_CITATIONS=true`).** Operator-pending. The standing instruction for this run allows OpenRouter, Cohere and Voyage only. An Anthropic key variable exists in the session from Task 1, and it was deliberately not used.

**Step 1 (live `rag_answer_records`).** Operator-pending. The Supabase connector call needed an approval that nobody could answer overnight. The orchestrator said to skip it. A Management API query was then refused by the session's permission policy and was not retried. Nothing was applied or read on any live database, and production was not touched.

**Step 3 (live calibration).** There is no real labelled pair set under `eval/golden/private/`. **The 0.5 defaults in `eval/config/groundedness-thresholds.json` stay.**

## Research assumptions A1–A8

| # | Outcome |
| --- | --- |
| A1 | **Holds** on real streams (Task 1). Gap-closure plan needed: make webSearch (Exa client tool) turns eligible for `claude-citations` |
| A2 | **Open.** Langfuse tag merge; operator-pending (no Langfuse keys) |
| A3 | **Partly holds.** 1.7 GB, not 1–1.5 GB; 5 s only on about 4 vCPU (Task 3) |
| A4 | **Holds.** No sentencepiece or protobuf needed (Task 3) |
| A5 | **Holds.** Every direct TTFT was ≤1.8 s against the 8 s gate (Task 1) |
| A6 | **Holds.** All OpenRouter and Anthropic ids are listed (Task 1) |
| A7 | **Open.** Langfuse CATEGORICAL score; operator-pending |
| A8 | **Consistent with eager attention.** Superlinear memory growth; the cap stays (Task 3) |

## Decisions made (autonomy, owner's standing instruction 2026-11-27)

- **Recommended options taken.** The premise cap stays 3000. The 0.5 groundedness thresholds stay. `RAG_GROUNDEDNESS_VECTARA_MULTI_TENANT_ACK` stays false. `CLAUDE_WEB_SEARCH_ELIGIBLE` stays false.
- **Judge embeddings.** The judge's Ragas embeddings client was pointed at OpenRouter with `OPENAI_BASE_URL=https://openrouter.ai/api/v1`, so no request went to OpenAI directly. OpenRouter serves `text-embedding-3-small` with the same output.
- **Generator.** `anthropic/claude-haiku-5.5` on OpenRouter was used for the nightly. It is a mapped model and differs from the judge family (openai), which the family check requires.

## Deviations from plan

1. **Bug fix (blocking Task 3).** The hhem image had no `config/rag`. The test and fix are in `6fb980d2` and `a881a710`, from the earlier session of this plan.
2. **The build environment needed scratch-only changes.** These were the GCR mirror for the pinned base digest and the proxy CA. Neither is committed.
3. **The golden set is the committed fixture set, not a real one.** No real set exists, and the plan's "real golden set" comparison is operator-pending.
4. **The plan says only the SUMMARY and tool-written config are committed.** The Task 1 results file and the hhem fix are also on the branch. They come from earlier sessions of this plan.

## Operator pending

1. **Task 2: Vectara.** Set `VECTARA_API_KEY` in the sidecar only, in a single-tenant test deployment with synthetic documents, and set `RAG_GROUNDEDNESS=true` and `RAG_GROUNDEDNESS_VECTARA_OPT_IN=true`. Then:
   - run about 20 en and zh calls and record p50 and p95 against 8000 ms;
   - send about 20 source texts and one very long premise, and record any limit errors;
   - record the data-retention terms. Only if they are acceptable, decide `RAG_GROUNDEDNESS_VECTARA_MULTI_TENANT_ACK=true`.
2. **Task 2: Langfuse (A2, A7).** Check the `groundedness` NUMERIC and `groundedness_label` CATEGORICAL scores, check that `user_feedback` is overwritten when a vote changes, and check that the `review_candidate` and `review:feedback_negative` tags are merged and not replaced.
3. **Task 4 step 1, on the eval project (`fsgaeysipkukqoocgzbx`) first, then production after a backup.** Apply `0501` and the mode's `0502` (`bash scripts/setup-database.sh --list-migrations <mode>`). Then run this SQL to confirm:
   ```sql
   select c.relrowsecurity,
          has_table_privilege('anon','public.rag_answer_records','select') as anon_select,
          has_table_privilege('authenticated','public.rag_answer_records','insert') as auth_insert,
          (select json_agg(json_build_object('p',polname,'cmd',polcmd,'qual',pg_get_expr(polqual,polrelid)))
             from pg_policy where polrelid = c.oid) as policies
   from pg_class c where c.oid = 'public.rag_answer_records'::regclass;
   ```
   - Expected result: RLS is on, `anon_select` is false, `auth_insert` is false, and there is one select policy for the own user only.
   - With the real anon key, `GET /rest/v1/rag_answer_records?select=id` must be refused.
   - With two real test users, neither may read the other's rows. Record outcomes and SQLSTATEs only.
4. **Task 4 step 2, Claude strategy.** With `ANTHROPIC_API_KEY` set, run `RAG_CLAUDE_CITATIONS=true npx tsx eval/harness/run-nightly.mts --generator live --generator-model anthropic/claude-haiku-5.5 --citations --out eval/out/05-26-nightly/claude`. Then run `uv run --directory eval python -m rag_eval.judge.run` on its traces and compare Faithfulness with the two legs above.
5. **Task 4 step 2, real golden set.** Rerun all legs once a real golden set exists.
6. **Task 4 step 3.** Once a real labelled pair set exists, run `uv run --directory eval python -m rag_eval.calibrate groundedness --pairs <file> --scorer sidecar --out eval/out/live-calibration`. If the holdout passes, rerun it with `--write`.

## Gates run

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors.
- `node scripts/ci/check-rag-boundary.mjs`, `node scripts/check-config.mjs`, `node scripts/ci/check-language-literals.mjs` and `node scripts/ci/check-settings-classification.mjs`: all exit 0.
- `uv run pytest -q tests/test_image_config.py` (rag-sidecar): 19 passed. With the pre-fix Dockerfile: 1 failed (`[hhem]`) and 18 passed.
- Vitest, rag-db and test-rag: not run. No TypeScript, SQL or retrieval code changed.

## Next phase readiness

- One gap-closure plan is needed: webSearch turns on the direct Claude path (A1).
- Phase 7 needs the HHEM host sizing note (about 4 vCPU for the 5 s budget at the 3000-token cap).
