# Phase 5 Plan Check (pass 1)

**Verdict:** ISSUES (0 blockers, 1 warning, 2 info) - execution may proceed after the warning is addressed or accepted.

## Coverage
- GEN-01..07 and EVAL-16 each claimed by plans with concrete tasks (05-PLAN-INDEX requirement table matches plan frontmatter); ROADMAP SC 1-6 each map to automated tasks plus 05-26 live checks.
- D-01..D-26 covered; deferred ideas absent.
- Waves = max(in-phase deps)+1; no cycles; cross-phase deps (03-05, 03.1-04/27/37/51, 04-xx) are declared. Phase 3.1 and 4 are not yet executed (no SUMMARYs), so HEAD-measured gate baselines will shift; plans already state they run after both phases.

## Security review (all PASS)
- rag_answer_records: RLS on, select-own only, no write policies, REVOKE from PUBLIC/anon, service_role writes; guarded by grep + PGlite tests in both modes (05-06 T2).
- Identical 404 for missing/foreign record, never 403 (05-09 T2); feedback on foreign answer 404 (05-21 T1); setAnswerFeedback filters user_id (05-09 T1).
- Nullable chat_id attach: only caller's unlinked rows, org not-distinct-from chat's, ids listed in a chat the caller owns (05-09 T1, 05-13, 05-21). Acceptable resolution; FK + cascade kept.
- Vectara fail-closed in multi-tenant via allowVectaraFor + ACK switch default false (05-14); sidecar only calls Vectara on allow_vectara + key (05-12).
- HHEM: revision pinned, trust_remote_code with local_files_only, HF_HUB_OFFLINE=1, flan-t5-base commit + safetensors sha256 asserted at bake (05-12, 05-17).
- ANTHROPIC_API_KEY: password input, never logged/never in thrown messages (05-02).
- Switches off => byte-identical SSE (05-08, 05-13, 05-16); strict refusal unchanged with citations on (05-08 T2); post-start errors keep formatErrorSSE (05-16).
- Planner resolutions (nullable chat_id, adaptive thinking without effort, webSearch off Claude path pending spike, 404/empty-refusal fallback reasons, no answerId on refusals, feedbackEnabled, src/translations/answer-quality.ts) are consistent with CONTEXT; none contradict a locked decision.

## Warnings

**W1 [dependency/pins] hhem extra must resolve against the existing lock without moving docling's torch or failing exclude-newer** - 05-05 Task 3
- Evidence: rag-sidecar/uv.lock has torch 2.15.0 with `source = { registry = "https://pypi.org/simple" }` (transitive via docling/accelerate); no download.pytorch.org entry exists. `[tool.uv.sources] torch = pytorch-cpu` only binds direct deps, so Phase 3's "reuse the CPU index" assumption is not what the lock holds today. Declaring `torch==<approved>` directly in the hhem extra will repoint the single universal-lock torch entry (also used by the docling extra) to the CPU index, and with `exclude-newer = 2026-11-17` the CPU index (no upload-time metadata) may yield no candidates and fail `uv lock`. `torch==<approved>` is also left open while docling locks 2.15.0.
- Example fix (non-binding): pin `torch==2.15.0` (matching the lock), add a torch/torchvision exclude-newer-package exemption or document why it's unneeded, and add a boundary-test case asserting the docling extra's torch version/source after relock (or declare the change intentional in the plan).

## Info
- I1: rag-sidecar/tests/test_dependency_boundary.py does not exist at HEAD; it is created by 03.1-04 (declared dependency of 05-05/05-17), so 05-05/05-12 verify commands depend on Phase 3.1 completing.
- I2: transformers 5.23.0, huggingface_hub 1.33.0, docling 2.150.1 pins in plans match the current uv.lock/pyproject.

## Orchestrator resolution (2026-11-24)
- W1: fixed upstream in Phase 3 (commit "fix(03-05): resolve torch and torchvision from the CPU index"). `torch==2.15.0` and `torchvision==0.29.2` are now direct pins in the sidecar `docling` extra, resolved from the pytorch-cpu index, exempt from `exclude-newer`; `rag-sidecar/tests/test_torch_cpu_lock.py` fails if any torch entry leaves the CPU index or any nvidia/triton/cuda package is locked. 05-05 Task 3 must pin `torch==2.15.0` (same as docling) in the `hhem` extra, keep the same exemption, and run that lock test after relocking; the `<approved>` placeholder becomes 2.15.0.
- I1: accepted; 05-05 and 05-12 run after Phase 3.1 (03.1-04 creates `test_dependency_boundary.py`).
