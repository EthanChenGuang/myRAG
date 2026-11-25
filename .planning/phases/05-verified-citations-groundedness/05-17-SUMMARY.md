---
phase: 05-verified-citations-groundedness
plan: 17
subsystem: rag-sidecar
tags: [groundedness, hhem, docker, supply-chain, huggingface]

requires:
  - phase: 05-verified-citations-groundedness
    provides: approved hhem extra and HF revisions (05-05), LocalHhemScorer and HHEM_MODEL_REVISION (05-12)
  - phase: 03-unified-ingestion-embedding-profiles
    provides: multi-stage Dockerfile with the docling target and slim last stage (03-05)
  - phase: 03.1-tiered-parsing-incremental-queue-bulk-backfill
    provides: test_image_boundary.py as of 03.1-04
provides:
  - rag_sidecar.groundedness.bake (bake, main, FLAN_T5_REVISION, HHEM_SAFETENSORS_SHA256, PINNED_SHA256)
  - Docker target hhem (opt-in; the default last stage `runtime` is unchanged)
affects: [05-25, 05-26]

actuals:
  tasks: 2
  commits: 5
plan_head_before: 0cf86ec
plan_head_after: see git log exec/05-17

tech-stack:
  added: []
  patterns:
    - "Build-time bake: pinned snapshot_download, commit assertions on the snapshot directory and on refs/main, sha256 per file, then one offline load in a child process with HF_HUB_OFFLINE=1 and TRANSFORMERS_OFFLINE=1"
    - "BakeError subclasses SystemExit, so an uncaught failure prints the message and exits 1"

key-files:
  created:
    - rag-sidecar/src/rag_sidecar/groundedness/bake.py
    - rag-sidecar/tests/test_hhem_bake.py
  modified:
    - rag-sidecar/Dockerfile
    - rag-sidecar/tests/test_image_boundary.py

key-decisions:
  - "The bake pins sha256 for eight files, not just model.safetensors: the five flan-t5-base files and both HHEM remote-code files (configuration_hhem_v2.py, modeling_hhem_v2.py), with the hashes from 05-05-PACKAGE-VERIFICATION.md. The HHEM config.json is covered by the revision pin only (no reviewed hash)"
  - "The bake refuses any HHEM_MODEL_REVISION other than the reviewed de9a5e6…, before downloading anything, so the image can only contain reviewed remote code"
  - "flan-t5-base is downloaded at revision main (what the remote code resolves offline) and the bake asserts both the snapshot directory name and refs/main equal 7bcac572…"
  - "HHEM download is limited to config.json, configuration_hhem_v2.py, modeling_hhem_v2.py and model.safetensors; flan-t5 to the five config and tokenizer files (no .bin pickle, .h5, .msgpack or weights)"
  - "The offline load runs in a child process with offline env vars, because huggingface_hub reads HF_HUB_OFFLINE at import time; the child also runs one predict to prove the tokenizer works"
  - "A loader error mentioning sentencepiece or protobuf fails with a message saying sentencepiece was rejected in 05-05 and must not be added. The plan text calls this a conditional approval, but 05-05 recorded a rejection"
  - "hhem stage: HF_HOME=/opt/hf; ENV HF_HUB_OFFLINE=1 and TRANSFORMERS_OFFLINE=1 come after the bake RUN; chown -R 10001 on HF_HOME (transformers writes HF_HOME/modules for remote code); USER 10001"

requirements-completed: []
requirements-progressed: [GEN-05]
---

# Phase 5 Plan 17: hhem Docker target and pinned bake Summary

Operators can now build the sidecar with local HHEM-2.1-Open scoring by running `docker build --target hhem rag-sidecar`. The build downloads only the reviewed files, checks commits and hashes, and proves the model loads offline. Otherwise it fails. The default image is unchanged.

## What was built

- `bake.py`: `python -m rag_sidecar.groundedness.bake` downloads `google/flan-t5-base@main` (five files) and `vectara/hallucination_evaluation_model@HHEM_MODEL_REVISION` (four files) into `HF_HOME/hub`. It then:
  - asserts the resolved commits;
  - checks eight sha256 hashes;
  - loads and runs the model once in an offline child process.

  It fails with exit 1 and a `[HHEM bake]` message naming the expected and found values. Downloads, hashing and the loader can be injected. Importing the module loads no torch, transformers or huggingface_hub.
- Dockerfile `hhem` stage, between `docling` and `runtime`:
  - `uv sync --locked --no-dev --extra hhem`;
  - the bake as the only step that needs network beyond the package installs;
  - offline runtime variables;
  - `HF_HOME` owned by uid 10001.

  `runtime` stays the last stage and the default build.
- Image-boundary tests check the hhem stage layout and order (HF_HOME, then bake, then offline env, then USER) and the chown. They also check that no other stage, including the default one, contains any hhem extra, bake, HF download or HF env.

## Tasks and commits

| Task | Commits |
|------|---------|
| 1. Bake with pinned revisions and hash check | `10bba7d` test (RED), `f956680` feat (GREEN) |
| 2. hhem target and image-boundary tests | `5639488` test (RED), `64142f1` feat (GREEN) |

RED commits failed on assertions: 19 bake tests (a stub module with the constants and no-op functions) and 4 image-boundary tests (`no hhem stage in ['docling', 'runtime']`).

## Verification

- `pytest tests/test_hhem_bake.py tests/test_image_boundary.py tests/test_dependency_boundary.py tests/test_groundedness.py`: all pass.
- Real bake outside Docker: hhem extra installed from the lock into a scratch venv (`uv sync --locked --no-dev --extra hhem`), then the real bake. Exit 0: commits matched, all eight hashes matched, offline load and predict succeeded. The local scorer, run with `HF_HUB_OFFLINE=1`, scored a consistent pair 0.907 and a contradiction 0.044.
- **Research assumption A4 is closed:** the flan-t5 tokenizer loads under transformers 5.23.0 without sentencepiece.
- Real image builds, run against a local dockerd:
  - `docker build --target hhem` passes, and the bake runs inside the build.
  - The default `docker build` passes.
  - `rag-sidecar:ci` is 342 MB (85 MB compressed) and has no torch or transformers.
  - `rag-sidecar:hhem` is 5.15 GB (1.56 GB compressed).
  - `docker run --network none rag-sidecar:hhem` runs as uid 10001; `/opt/hf` is owned by 10001; `build_scorers` gives `['hhem_2_1_open']`; a contradiction scores 0.044.
  - The builds needed the session proxy CA, which the build container does not trust. Without it, both the default and the hhem build fail at the first `uv sync`. I built from an uncommitted copy of the Dockerfile in the scratchpad that adds the CA, with `--network host`. The committed Dockerfile has no proxy or CA lines.
- Gates:
  - `npx next typegen && npx tsc --noEmit`: 0 errors.
  - vitest: 4596 passed, 1 skipped.
  - `tests/*.test.mts`: 172 passed.
  - `tests/rag-db/*.test.mts`: see the final report.
  - RAG boundary script and its 38 tests: pass.
  - `check-config` and `check-workflows`: OK.
  - rag-sidecar pytest: 1420 passed, 11 skipped.
  - eval pytest: 735 passed.
- The first sidecar run had 30 timing failures (test_ingest_escalation and others) while the Docker build ran in parallel. A rerun with no load passed in full.
- Not run, because nothing in scope changed: `npm run gen:schemas` (no contracts) and `npm run test-rag` (no retrieval, ingest or golden-set changes).

## Deviations

1. **More hashes than planned** (Rule 2, security): hashes are checked for the remote-code `.py` files and the five flan-t5 files, in addition to the safetensors file.
2. **Unreviewed revision rejected:** a non-default `HHEM_MODEL_REVISION` fails the bake instead of being downloaded.
3. **sentencepiece wording:** the plan says the missing-dependency message should name a "conditional sentencepiece approval". 05-05 recorded a rejection, so the message says sentencepiece was rejected and must not be added.
4. **Live checks run early:** the real bake and image builds were done here although the plan left them to 05-26. They passed. 05-26 can still repeat them on the operator's host.

## Operator actions

- To deploy local scoring, build `docker build --target hhem rag-sidecar` on a host with network access to huggingface.co and download.pytorch.org. Plan about 2 GB of memory for the scorer; the AGENTS.md note on that is plan 05-25.
- If Vectara later enables gating on the HHEM repo, a rebuild needs an HF token at build time. The image itself never needs one.

## Deferred

- AGENTS.md note on memory sizing for the hhem image: plan 05-25.
- Live latency at 1k/3k/6k premise tokens (P-10): plan 05-26.
