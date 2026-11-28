# Live check order (owner) — 2026-11-28
Every live check runs on EVAL (fsgaeysipkukqoocgzbx) unless a step says prod.

## Step 0 — prerequisites (in progress)
- 0.1 EVAL catches up on SQL: t38, t39, 0989, 0991, t40, t41, then t42 and t43 once they merge (owner desk).
- 0.2 Prod SQL in the same order (backup first).
- 0.3 Set NANGO_WEBHOOK_SECRET; approve the eval preview deploy so EVAL runs the latest main.

## Step 1 — one-time owner actions (they unblock the later steps)
- 1.1 05.3-49: branch protection (backend-canary required), repo secrets, Vercel promotion settings.
- 1.2 07-32: Vercel plan / drain scheduler (decided: pg_cron + pg_net); Weaviate/Qdrant hosting, region and read-only keys.
- 1.3 06.2-13: approve the language-ID package and model (package approval gate).
- 1.4 Migration push checks. These are mostly covered by the train SQL in 0.1/0.2; tick them after confirming: 04.3-53 (09xx), 05.2-39 (5.2), 06.2-19 (6.2), 06.3-24 T2 (0720–0729, 0746 + anon probe).

## Step 2 — live checks you can run now (independent of each other)
- 2.1 06.3-25: SharePoint/OneDrive via Nango, delete/restore a file (soft, then purge), one live purge.
- 2.2 04.4-15: BM25 vs ts_rank_cd on real questions, plus the real-Postgres latency benchmark.
- 2.3 04.3-54: two-mode canaries, a real Drive folder and Dropbox re-authorization.
- 2.4 03.3-26: Phase 3.3 boilerplate residue measured on real data.
- 2.5 03.1.1-15: real model facts and index builds.
- 2.6 06-46: Phase 6 live items (Redis task 4 is unblocked).
- 2.7 05.2-40 and 05.1.1-23 live legs: real log rows, real-JWT two-tenant reads, real promotion.
- 2.8 05.3-50: owner ratifications H-5..H-10.
- 2.9 06.1-19: fine-tune on real data, GPU and endpoint (G-1 is fixed).

## Step 3 — waits on code or on the previous step
- 3.1 07-33: hosted backend canary plus the live regression (fill the null prices in price-table.json first; incumbent = shipped values).
- 3.2 07-50: Phase 7 rev-4 live checks (red-team runner file + RAG_EVAL_SECRET).
- 3.3 05.2.1-25: after 05.2.1-24 (unblocked once the must_keep fix lands).
- 3.4 06.2-33: after 06.2-30, 31 and 32.
- 3.5 06.3-26: after 06.3-25 (SharePoint permission mapping code).

## Ongoing / human only
- Native-speaker review of 26 zh/it golden items.
- Re-run the walkthrough to read finishReason.
- Before turning on switches: retention purge schedule (O-1), RAG_EMBED_FEEDBACK_SECRET (O-3).
