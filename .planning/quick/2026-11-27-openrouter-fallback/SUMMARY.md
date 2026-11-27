---
quick: quick-openrouter-fallback
branch: exec/quick-openrouter-fallback
base: origin/ci/merge-train-36
status: complete
date: 2026-11-27
---

# Quick task: OpenRouter fallback for eval judge embeddings and BGE-M3

## Commits
- 4838bde4 feat(eval): route judge embeddings through OpenRouter with RAG_EVAL_OPENAI_VIA (Task 1)
- 0b0dd67d WIP(rag): RAG_BGE_M3_VIA route through OpenRouter and verify-route probe (Task 2)
- a9932a65 fix(rag): neutral synthetic probe texts in verify-route (Task 2, domain-neutrality fix)

## Behaviour changes
- `RAG_EVAL_OPENAI_VIA=openai|openrouter` (default `openai`, unchanged behaviour) in `eval/src/rag_eval/judge/openai_route.py`; used by judge.run, judge_calibration, ragas_drafter, the draft CLI and the chunking sweep. The workflows (nightly judge, answer-rules, tenant-nightly, judge-calibration, rag-release-gate) accept OpenRouter-only judge keys and default to `openrouter` when the OpenAI secret is absent (`vars.RAG_EVAL_OPENAI_VIA` overrides).
- `RAG_BGE_M3_VIA=deepinfra|openrouter` (default `deepinfra`, unchanged behaviour). `openrouter` uses `OPENROUTER_API_KEY`, pins the DeepInfra upstream (`{order:[DeepInfra], allow_fallbacks:false}`); any other upstream is refused as a model mismatch. Vectors written that way record `embedding_host=openrouter`. Synced to env.ts, init-env.js, config-server.js, the Config UI (select and en/zh/it labels), env-manifest, settings-classification (ingestion, reembed), rag-affecting.generated.json, eval rag-eval-env.json and AGENTS.md.
- `npm run rag:embedding -- verify-route bge-m3 [--reference f] [--write-reference f] [--out f]`: embeds four fixed neutral probe texts through OpenRouter and compares them with DeepInfra (live, or a reference file); `match` needs min cosine 0.999. It prints routes, hosts, cosines and the verdict only.

## Gates run
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `node scripts/ci/check-rag-boundary.mjs`, `node scripts/check-config.mjs`, `node scripts/ci/check-language-literals.mjs`, `node scripts/ci/check-settings-classification.mjs`: pass
- `npx vitest run tests/ui tests/rag/embeddings tests/api/config-gate-writers.test.ts tests/rag/ingest`: 179 files, 3429 passed, 1 skipped
- `npx vitest run tests/rag/embeddings/bge-m3-via.test.ts` after the probe-text fix: 14 passed
- Full `npx vitest run` (env.ts changed): see the final report
- `node --test scripts/tests/*.node-test.mjs`: 326 passed
- eval pytest (test_openai_route, test_judge_offline, test_judge_calibration): 49 passed; earlier session 152 + 60 passed
- `check-workflows.py`: OK
- Lint: only pre-existing errors on untouched lines

## Live checks
- verify-route ran once against the live hosts from this session: openrouter `http_401`, deepinfra `http_401`, verdict `not_compared`. The session has no OpenRouter or DeepInfra credential, so no vectors were compared. No 402 seen. An earlier manual check (previous session) got 1024-dim unit-norm vectors from OpenRouter `BAAI/bge-m3` with `provider: DeepInfra`, while DeepInfra direct answered 402.
- Stored-vector comparison on the eval project fsgaeysipkukqoocgzbx: refused (`execute_sql`: no permission). Not done.

## Operator actions
1. On the eval project, run `select profile_id, embedding_host, embedding_model, dims, count(*) from public.chunk_embeddings where profile_id = 'bge-m3-1024' group by 1,2,3,4;`.
2. With real keys in `.env.local`: `npm run rag:embedding -- verify-route bge-m3 --out route.json`. If DeepInfra can be paid, add `--write-reference bge-m3-ref.json` to keep its vectors. Without DeepInfra, pass `--reference` with DeepInfra-made vectors for the four probe texts (the file carries the sha256 of each text). Serve `bge-m3-1024` through OpenRouter only after the verdict is `match`.
3. The CLI loads the Supabase settings at start, even for verify-route, which reads no data; set them as usual.

## Decisions
- Based on merge-train-36, not main, because judge_calibration.py and tenant_nightly.py exist only there.
- tenant_nightly needed no code change; the workflow job got RAG_EVAL_OPENAI_VIA.
- build_ragas_live keeps its old call shape (a string third argument means a direct OpenAI key); an EmbeddingRoute picks OpenRouter.
- RAG_BGE_M3_VIA is ragAffecting like its siblings, which changes the config-gate settings hash once. It is classified ingestion/reembed; the ingest fingerprint keeps its fixed parts schema, so existing fingerprints are unchanged.
- The profile id stays bge-m3-1024.
- The verify-route probe texts were replaced with neutral synthetic sentences (the first version had domain examples, which the owner rule forbids).
- The handoff stays in this folder; STATE.md and HANDOFF.json are untouched.

## Deferred
- Task 3 (Batch API) not done: 03.1-54 Task 3.1 stays DEFERRED.
- The live route comparison and the stored-vector query (operator actions 1 and 2).
