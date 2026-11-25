# Phase 4.1 live rerank check (G7, report-only)

Status: **pending_live**

Vendor requests: 0 of a cap of 600. Dev split: 117 of 117 items used (whole split).
Golden sha256 `ad75386e9c38478fbc608549ed09d96b72be70647b7f1ad11890f9aa1dfb2a04`; baseline sha256 `734ad7d03cb62e7acc652355d7a6b4bd55d02dd3ac363547007249625fdcd51a`.
Noise band: Recall@10 0.02, MRR 0.02. Rerank p95 budgets: chat 600 ms, voice 250 ms.

> Fixture evidence only: a small synthetic corpus in three languages, retrieved with the lexical fixture embedder, so the candidate lists the rerankers see differ from production. The numbers show whether hosted rerank is worse than the local paths on this fixture and how fast the vendors answer 75 candidates; they are not a production quality estimate.

## Offline references (same items, threshold refusal off)

| Reference | Run config | Run id | n | Recall@10 | MRR | Recall@10 by language |
| --- | --- | --- | --- | --- | --- | --- |
| local_bm25 | v2-default-no-cells | e98fff72-b34c-476a-b582-84f616b553f0 | 96 | 0.906 | 0.766 | en 0.971, it 0.793, zh 0.938 |
| none | v2-default-fallback-none-no-cells | d7fa4693-4218-41c2-99e8-a0e31d3e00d5 | 96 | 0.906 | 0.773 | en 0.971, it 0.793, zh 0.938 |

## Hosted rerankers

No live pass has run yet: the live checks are an operator action (see the plan 04.1-08 SUMMARY).

## G7 verdicts (inputs for plan 04.1-07)

- auto_chat_cohere: **not_run**
- auto_voice_cohere: **not_run**
- alternative_chat_voyage: **not_run**
- alternative_voice_voyage: **not_run**

## Indicative refusal fit (Task 3)

skipped: skipped for now: it follows the live checks, which plan 588 requests for the dev split in force, so it will be skipped (at or above 450)

Nothing here writes eval/config/refusal-thresholds.json or eval/config/retrieval-params.json.
