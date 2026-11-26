# myRAG orchestrator handoff (2026-11-26 ~11:00Z)

You take over as the **execution orchestrator** for the myRAG GSD project from the previous orchestrator session (session_01SEn5g9gV3RHr18oaonxqof), which the owner is closing. Reply to the owner in **Simplified Chinese**, short and plain. Read `standing-rules.md` in this folder first: it is the owner's standing instructions and overrides defaults.

## Who/what
- Repo: github.com/EthanChenGuang/myRAG. `main` is production. Trunk branch `claude/ecstatic-hamilton-86gtwv` must always equal main (`git push origin origin/main:refs/heads/claude/ecstatic-hamilton-86gtwv` after every merge; never commit on trunk).
- Production app: Vercel project `myrag` (https://myrag.laoxiang.app), team_tHRDIP8AtALXIH4nKvMjUBwg, scope `chenguangregis-gmailcoms-projects`. Deploy method (CLI token is proxy-injected):
  ```
  rm -rf $S/deploy && mkdir -p $S/deploy && git archive origin/main | tar -x -C $S/deploy && cd $S/deploy
  npx --yes vercel@latest link --yes --project myrag --scope chenguangregis-gmailcoms-projects --token proxyinjected
  rm -f .env.local
  npx --yes vercel@latest deploy --prod --yes --token proxyinjected --scope chenguangregis-gmailcoms-projects > $S/deploy.out 2>&1
  ```
  Check `"readyState": "READY"` in the output. Curl to the site may hit Vercel's bot checkpoint (403/200 alternating) — not an outage.
- Supabase (org biyibndjlhbghshpmwua, **free plan**):
  - Production `ppvywaxrycaxrtrrditl` (myRAG) — **multi-tenant** schema (not single-tenant!). Live migrations are applied from the orchestrator with the Supabase MCP `apply_migration` (owner pre-authorized). Combine a train's migrations into one call to cut approval prompts. Never bypass the MCP confirmation through the raw API.
  - `fsgaeysipkukqoocgzbx` = **myrag-medical** (medical eval DB; multi-tenant schema identical to prod at main d2a3dd6e; still MISSING 0707 and 0821 — apply them there too).
  - `bwvhzitzeqgafibczldw` by-luggage: paused by owner request. Other two old projects inactive.
  - A Supabase personal access token is saved as a network secret for `api.supabase.com` (proxy-injected; Management API works with plain curl, e.g. PATCH /v1/projects/{ref}).
- Owner autonomy: full autonomy for merges (when 16 CI checks green), live migrations, deploys, env vars, up to 15 parallel executors. Ask only for genuine decisions; always give a clickable URL when asking for any token/key.

## Production state
- main = 4b05dade (train 23 merged, deployed READY). Live migrations through 0820, 0704, 0705, 0707, 0821 (last applied as `train23_0707_vector_sync_reconcile_and_0821_translation_query_state`).
- Retrieval default stays `RAG_PIPELINE=legacy` (04.1 decision record `not_flipped`; the 04.1-09..12 chain was closed on that path). Production embedding profile active: openai-3-small-1536 (Qwen3/Voyage profiles exist but are `available`).
- Voice button hidden via Vercel env `NEXT_PUBLIC_VOICE_MODE_ENABLED=false` (LiveKit keys missing; Fly agent unreachable).
- Recent UI fixes shipped (send button touch handling, thinking indicator, composer, toasts); owner has not yet confirmed on phone.

## Execution pipeline (how work flows)
1. Executors = cloud sessions created with `create_session` (model opus, tags `myrag-exec`, `phase-X`), one plan each (or a short stacked chain), branch `exec/<plan>`, base = trunk or the exec branch holding unmerged dependencies. Brief template: `tools/executor-brief-template.md` (fill {PLAN}; add phase notes). Executors push and stop; they never open PRs.
2. Find runnable plans: `python3 tools/ready2.py <running plan ids...>` from the repo root after `git fetch origin` (it counts SUMMARYs on trunk + origin/exec/* + origin/ci/*). `auto=false` plans need a human checkpoint; `tools/blockers.py` / `tools/missdeps.py` explain blockers. Holds are listed inside ready2.py.
3. Merge trains: when ~8–10 plans are done, a subagent (opus) merges their exec branches with `--no-ff` onto origin/main into `ci/merge-train-N`, runs the FULL gate set (tsc, full vitest, tests/*.test.mts, tests/rag-e2e, tests/rag-db, every ts-checks step in .github/workflows/pr-smoke.yml incl. check-language-literals and check-settings-classification, check-workflows, sidecar+eval pytest, gen:schemas no diff, test-rag fixture + ingest), appends a section to `.planning/LIVE-MIGRATION-LOG-2026-11-25.md`, pushes. Orchestrator opens the PR, subscribes, merges at 16/16 green (expectedHeadSha = full SHA), applies the train's migrations live, syncs trunk, deploys.
4. A rolling check reminder (send_later / trigger) every 25–30 min while work is in flight. The previous session's trigger `trig_01Dbo1EWAoUoh2foydG7GjPX` fires into the OLD session; delete it and create your own.

## Running right now (executors; find them with list_sessions tags ["myrag-exec"])
| plan | session | base → branch |
|---|---|---|
| 04.2-01 | session_01SEn5g9MmA5vSjfjB6kFDUj | exec/04.1-12 → exec/04.2-01 |
| 04.2-02 | session_01SEn5g7CwXZx7HmyffXjhhd | exec/04.1-12 → exec/04.2-02 |
| 04.2-03 | session_01SEn5g8GGEwevGuTJjJuVpY | exec/04.1-12 → exec/04.2-03 |
| 04.2-04 | session_01SEn5g7HwumAHqXfQ292Uqm | exec/04.1-12 → exec/04.2-04 (may report a stemmer package needing owner approval) |
| 04.1.1-01 | session_01SEn5g9Dse9qAFetckeSoio | exec/04.1-12 → exec/04.1.1-01 |
| 04.1.1-02 | session_01SEn5g9R6LbtQSDnTTScejt | exec/04.1-12 → exec/04.1.1-02 |
| 04.1.1-03 | session_01SEn5g7iDfSXgy19yg61oAx | exec/04.1-12 → exec/04.1.1-03 |
| 03.2-58 | session_01SEn5g846FTGNNPDrfV4ocW | exec/03.2-40 → exec/03.2-58 |
| 03.2-62 | session_01SEn5g8APGJzXBDKx6isQEV | exec/03.2-61 → exec/03.2-62 |
Archive each when it reports completed (read its final report first: operator actions, migrations).

## Done but not merged (train 24 candidates)
- exec/04.1-13 (04.1-13), exec/04.1-12 (04.1-09..12 chain, contains 04.1-13), exec/03.2-40 (migration **0822**; operator: apply + run rescan; contains 03.2-36 already merged), exec/03.2-61 (contains 03.2-60, merged) + whichever of the 9 above finish. Build train 24 when ~8–10 are ready.
- Held: 03.2-66 (needs exec/03.2-40 and exec/03.2-51 both on trunk → after train 24).
- Human-checkpoint plans remaining (~40): batch them for the owner. 06-22 package install can't happen before 2026-12-04 (package-age rule).
- Known flaky: rag-sidecar `test_preflight_hidden_text.py::test_off_makes_no_check...` compares a wall-clock ms field (follow-up for 03.2-36).
- Progress: 792 plans total; ~410 done; dependency depth ~31 waves.

## Medical evaluation track (owner priority: medical → legal → finance)
- Owner decisions: one Supabase project per domain, kept forever and switchable via a per-domain site URL (`myrag-medical`, later `myrag-legal`, `myrag-finance`; legal/finance need Supabase **Pro** — remind the owner to upgrade before legal; owner pays in the dashboard). Embeddings for medical: **Qwen3-Embedding-8B as primary + OpenAI text-embedding-3-small as comparison** (owner approved). Accuracy test on a generic golden set: owner said not now — only the domain corpora.
- Corpus: 790 AIFA PDFs (395 products, 100 ingredients, RCP+FI each, 11,655 pages, ~11.2M tokens), split 80/20 by active ingredient (train 632 PDFs / test 158). Manifest + scripts in `eval-medical/` here; PDFs are NOT in git — re-download with `eval-medical/scripts/fetch.py` (sequential, 0.7 s delay; listing `https://drive.aifa.gov.it/farmaci/confezioni_fornitura.csv`; docs `https://api.aifa.gov.it/aifa-bdf-eif-be/1.0.0/organizzazione/<ditta>/farmaci/<cod_farmaco>/stampati?ts=RCP|FI`). Verify sha256 against manifest. License: AIFA open data CC BY 4.0 (credit "Fonte: AIFA – Agenzia Italiana del Farmaco, Banca Dati Farmaci, dati aperti CC BY 4.0, estrazione del 26/11/2026"); PDFs are internal eval material only. **Never commit corpus, golden sets or domain strings to the repo** (domain-neutrality rule).
- Research report on the best setup (embedding, reranker, chunking, metadata, hybrid search, fine-tuning): `research/意大利语医疗RAG最佳方案.md` (+ notes). Use it to configure the medical ingest.
- Next steps: (1) apply 0707+0821 to myrag-medical; (2) decide ingest path (eval harness / rag:backfill against myrag-medical in **multi-tenant** mode — eval/config/rag-eval-env.json says single-tenant, override for this DB); (3) dry-run first, report pages/size/cost to owner (expected ~150–200 MB with Qwen3 1024 halfvec; free-plan limit 500 MB); (4) ingest Qwen3 + OpenAI profiles; (5) generate the medical golden set (~300 Q: direct 30%, multi-passage 15%, numeric/table 15%, cross-lingual zh/en→it 15%, colloquial 10%, no-answer 15%) from the TEST split only, with closed-book filter, uniqueness check, owner spot-check ~45 Q; (6) baseline run, then improvements one at a time (v2 hybrid, reranker, citations, terminology, parsing), each compared to the last; (7) per-domain site URL (separate Vercel project pointing at myrag-medical).

## Other pending
- Task: when the owner re-uploads the CV, back up and delete the old CV document and chunks, then re-test (personal data: never commit it or quote its contents).
- Owner to confirm phone UI fixes.
