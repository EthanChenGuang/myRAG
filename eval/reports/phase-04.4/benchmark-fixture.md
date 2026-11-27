# Phase 4.4 lexical scoring benchmark: fixture (PGlite)

> PGlite is single-threaded WebAssembly Postgres, so these timings are not the budget measurement: they show ratios and plans only. The budget measurement is the real-Postgres run of plan 04.4-15 (eval project, 30000, 300000 and 1000000 chunks).

Corpus size run: 30000 chunks.

Command:

```
node --import tsx scripts/rag/bench-lexical-bm25.mts --chunks 30000 --queries 12 --seed 44 --out eval/reports/phase-04.4
```

## Settings

- Corpus: neutralLexicalCorpus (tests/helpers/neutral-lexical-corpus.ts), seed 44, vocabulary 20000, 80–400 tokens per chunk, Zipf exponent 1, one document per 20 chunks, legacy chunking profile, no embeddings.
- After seeding, `ANALYZE` on `document_chunks` and `documents` (planner statistics as autovacuum leaves them on a live table).
- Statistics: `rag_lexstats_enable` then `rag_lexstats_rebuild` on the throwaway tenant; removed afterwards with `rag_lexstats_disable` and a chunk and document delete.
- ts_rank_cd: the lexical leg of `hybrid_search_chunks` (`p_dense_limit = 0`, `p_lexical_limit = 75`).
- BM25: `rag_bm25_search_chunks` (`p_lexical_limit = 75`, `p_candidate_limit = 500`, k1 1.2, b 0.75); the uncapped reference uses `p_candidate_limit = 0` and runs once per query.
- 12 queries (3 per shape), 3 warm-up and 15 measured runs per mode per query; p50 and p95 pool the measured runs of a shape. Timings are client round trips.
- Overlap@k: share of the uncapped top k found in the capped top k.

## Search stage budgets (eval/config/latency-budgets.json, unchanged)

| profile | search budget |
|---|---|
| chat | 400 ms |
| embed | 400 ms |
| voice | 300 ms |

## 30000 chunks

Statistics hold 30000 chunks. Seeding took 31 s, the rebuild 6396 ms.

| shape | queries | terms | matched rows (median, range) | matched share of corpus | candidates scored | ts_rank_cd p50 / p95 ms | BM25 p50 / p95 ms | BM25 / ts_rank_cd p50 | uncapped BM25 ms (median) | overlap@10 mean (min) | overlap@50 mean (min) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| rare_single | 3 | 1 (1–1) | 126 (37–149) | 0.0042 (0.0012–0.005) | 126 (37–149) | 7.97 / 9.96 | 29.45 / 35.28 | 3.7 | 27.32 | 1 (1) | 1 (1) |
| mixed_rare_common | 3 | 4 (4–4) | 27756 (26633–29969) | 0.9252 (0.8878–0.999) | 500 (500–500) | 469.06 / 593.84 | 713.42 / 890.82 | 1.52 | 6028.45 | 1 (1) | 1 (1) |
| many_terms | 3 | 8 (8–8) | 6050 (4720–7499) | 0.2017 (0.1573–0.25) | 500 (500–500) | 268.44 / 326.9 | 451.99 / 565.72 | 1.68 | 1705.48 | 1 (1) | 1 (1) |
| common_only | 3 | 3 (3–3) | 29827 (29691–29945) | 0.9942 (0.9897–0.9982) | 500 (500–500) | 405.74 / 511.44 | 577.34 / 768.65 | 1.42 | 5910.41 | 0.5 (0.3) | 0.5 (0.36) |

Mean overlap@50 over all queries: 0.875 (D-24 gates the fixture mean at 0.95). Matched-set sizes above are the input to the D-27 document-frequency pruning decision; pruning is not built.

Cleanup (rows left for the throwaway tenant): document_chunks 0, documents 0, rag_lexical_stats_state 0, rag_lexical_stats_pending 0, rag_lexical_df 0, rag_lexical_corpus 0, auth.users 0.

### Plans

EXPLAIN (ANALYZE, BUFFERS) of the statement each function executes, captured with auto_explain (nested statements, parameters not logged) for the first query of each shape. Terms and the tenant key are redacted.

#### rare_single: ts_rank_cd lexical leg

```
WindowAgg  (cost=1551.56..2132.05 rows=75 width=744) (actual time=3.308..3.753 rows=37.00 loops=1)
  Window: window1 AS (ORDER BY t.score, t.hid ROWS UNBOUNDED PRECEDING)
  Storage: Memory  Maximum Storage: 19kB
  Buffers: shared hit=640 read=2 written=2, local hit=1
  CTE hits
    ->  Limit  (cost=1542.96..1543.15 rows=75 width=20) (actual time=3.269..3.302 rows=37.00 loops=1)
          Buffers: shared hit=418 read=2 written=2, local hit=1
          ->  Sort  (cost=1542.96..1543.15 rows=75 width=20) (actual time=3.267..3.282 rows=37.00 loops=1)
                Sort Key: (ts_rank_cd(c_1.lexical_tsv, '''<term>'''::tsquery, 1)) DESC, c_1.id
                Sort Method: quicksort  Memory: 19kB
                Buffers: shared hit=418 read=2 written=2, local hit=1
                ->  Hash Join  (cost=1012.68..1540.63 rows=75 width=20) (actual time=2.830..3.240 rows=37.00 loops=1)
                      Hash Cond: (c_1.document_id = d_1.id)
                      Buffers: shared hit=418 read=2 written=2, local hit=1
                      ->  Hash Join  (cost=918.93..1446.49 rows=75 width=101) (actual time=0.829..0.937 rows=37.00 loops=1)
                            Hash Cond: (c_1.doc_type = ep.doc_type)
                            Join Filter: ((c_1.chunking_profile_id = ep.profile_id) OR ((ep.profile_id <> 'legacy'::text) AND (c_1.chunking_profile_id = 'legacy'::text) AND (c_1.chunk_kind = ANY ('{image,invoice_header}'::text[]))) OR ((ep.profile_id <> 'legacy'::text) AND (c_1.chunking_profile_id = 'legacy'::text) AND (NOT EXISTS(SubPlan 1))))
                            Buffers: shared hit=244 read=2 written=2, local hit=1
                            ->  Bitmap Heap Scan on document_chunks c_1  (cost=889.13..1416.30 rows=150 width=121) (actual time=0.798..0.870 rows=37.00 loops=1)
                                  Recheck Cond: (lexical_tsv @@ '''<term>'''::tsquery)
                                  Filter: (is_current AND (status = ANY ('{ready,variant}'::text[])) AND (tenant_key = '<tenant>'::text))
                                  Heap Blocks: exact=37
                                  Buffers: shared hit=244 read=2 written=2
                                  ->  Bitmap Index Scan on idx_document_chunks_lexical_tsv  (cost=0.00..889.09 rows=150 width=0) (actual time=0.773..0.774 rows=37.00 loops=1)
                                        Index Cond: (lexical_tsv @@ '''<term>'''::tsquery)
                                        Index Searches: 1
                                        Buffers: shared hit=207 read=2 written=2
                            ->  Hash  (cost=18.80..18.80 rows=880 width=64) (actual time=0.020..0.020 rows=6.00 loops=1)
                                  Buckets: 1024  Batches: 1  Memory Usage: 5kB
                                  Buffers: local hit=1
                                  ->  Seq Scan on _hybrid_eff_profile ep  (cost=0.00..18.80 rows=880 width=64) (actual time=0.010..0.013 rows=6.00 loops=1)
                                        Buffers: local hit=1
                            SubPlan 1
                              ->  Index Scan using idx_document_chunks_document_id on document_chunks c2  (cost=0.29..84.73 rows=20 width=0) (never executed)
                                    Index Cond: (document_id = c_1.document_id)
                                    Filter: (is_current AND (tenant_key = '<tenant>'::text) AND (chunking_profile_id = ep.profile_id))
                                    Index Searches: 0
                      ->  Hash  (cost=75.00..75.00 rows=1500 width=16) (actual time=1.964..1.965 rows=1500.00 loops=1)
                            Buckets: 2048  Batches: 1  Memory Usage: 67kB
                            Buffers: shared hit=60
                            ->  Seq Scan on documents d_1  (cost=0.00..75.00 rows=1500 width=16) (actual time=0.009..1.060 rows=1500.00 loops=1)
                                  Buffers: shared hit=60
  ->  Nested Loop  (cost=0.56..587.21 rows=75 width=651) (actual time=3.297..3.664 rows=37.00 loops=1)
        Buffers: shared hit=640 read=2 written=2, local hit=1
        ->  Nested Loop  (cost=0.29..564.38 rows=75 width=600) (actual time=3.287..3.501 rows=37.00 loops=1)
              Buffers: shared hit=529 read=2 written=2, local hit=1
              ->  CTE Scan on hits t  (cost=0.00..1.50 rows=75 width=20) (actual time=3.273..3.324 rows=37.00 loops=1)
                    Storage: Memory  Maximum Storage: 18kB
                    Buffers: shared hit=418 read=2 written=2, local hit=1
              ->  Index Scan using document_chunks_pkey on document_chunks c  (cost=0.29..7.50 rows=1 width=580) (actual time=0.003..0.003 rows=1.00 loops=37)
                    Index Cond: (id = t.hid)
                    Index Searches: 37
                    Buffers: shared hit=111
        ->  Index Scan using documents_pkey on documents d  (cost=0.28..0.30 rows=1 width=67) (actual time=0.003..0.003 rows=1.00 loops=37)
              Index Cond: (id = c.document_id)
              Index Searches: 37
              Buffers: shared hit=111
```

#### rare_single: BM25 statement

```
Sort  (cost=3963.47..3963.66 rows=75 width=728) (actual time=16.112..16.133 rows=37.00 loops=1)
  Sort Key: ((row_number() OVER <term>)::integer)
  Sort Method: quicksort  Memory: 38kB
  Buffers: shared hit=867
  CTE q
    ->  Function Scan on u  (cost=0.01..0.02 rows=1 width=72) (actual time=0.013..0.014 rows=1.00 loops=1)
  CTE cand
    ->  Limit  (cost=2204.53..2204.91 rows=150 width=24) (actual time=2.861..2.890 rows=37.00 loops=1)
          Buffers: shared hit=420
          ->  Sort  (cost=2204.53..2204.91 rows=150 width=24) (actual time=2.860..2.875 rows=37.00 loops=1)
                Sort Key: ((SubPlan 2)) DESC, c_2.id
                Sort Method: quicksort  Memory: 19kB
                Buffers: shared hit=420
                ->  Hash Semi Join  (cost=985.13..2199.11 rows=150 width=24) (actual time=2.422..2.835 rows=37.00 loops=1)
                      Hash Cond: (c_2.doc_type = ep.doc_type)
                      Join Filter: ((c_2.chunking_profile_id = ep.profile_id) OR ((ep.profile_id <> 'legacy'::text) AND (c_2.chunking_profile_id = 'legacy'::text) AND (c_2.chunk_kind = ANY ('{image,invoice_header}'::text[]))) OR ((ep.profile_id <> 'legacy'::text) AND (c_2.chunking_profile_id = 'legacy'::text) AND (NOT EXISTS(SubPlan 3))))
                      Buffers: shared hit=420
                      ->  Hash Join  (cost=982.88..1510.44 rows=150 width=121) (actual time=2.356..2.439 rows=37.00 loops=1)
                            Hash Cond: (c_2.document_id = d_1.id)
                            Buffers: shared hit=306
                            ->  Bitmap Heap Scan on document_chunks c_2  (cost=889.13..1416.30 rows=150 width=121) (actual time=0.583..0.642 rows=37.00 loops=1)
                                  Recheck Cond: (lexical_tsv @@ '''<term>'''::tsquery)
                                  Filter: (is_current AND (status = ANY ('{ready,variant}'::text[])) AND (tenant_key = '<tenant>'::text))
                                  Heap Blocks: exact=37
                                  Buffers: shared hit=246
                                  ->  Bitmap Index Scan on idx_document_chunks_lexical_tsv  (cost=0.00..889.09 rows=150 width=0) (actual time=0.559..0.560 rows=37.00 loops=1)
                                        Index Cond: (lexical_tsv @@ '''<term>'''::tsquery)
                                        Index Searches: 1
                                        Buffers: shared hit=209
                            ->  Hash  (cost=75.00..75.00 rows=1500 width=16) (actual time=1.766..1.767 rows=1500.00 loops=1)
                                  Buckets: 2048  Batches: 1  Memory Usage: 67kB
                                  Buffers: shared hit=60
                                  ->  Seq Scan on documents d_1  (cost=0.00..75.00 rows=1500 width=16) (actual time=0.008..0.420 rows=1500.00 loops=1)
                                        Buffers: shared hit=60
                      ->  Hash  (cost=1.00..1.00 rows=100 width=64) (actual time=0.011..0.012 rows=6.00 loops=1)
                            Buckets: 1024  Batches: 1  Memory Usage: 5kB
                            ->  Function Scan on jsonb_each_text ep  (cost=0.00..1.00 rows=100 width=64) (actual time=0.006..0.008 rows=6.00 loops=1)
                      SubPlan 2
                        ->  Aggregate  (cost=0.03..0.04 rows=1 width=8) (actual time=0.009..0.009 rows=1.00 loops=37)
                              Buffers: shared hit=114
                              ->  CTE Scan on q  (cost=0.00..0.02 rows=1 width=40) (actual time=0.001..0.001 rows=1.00 loops=37)
                                    Storage: Memory  Maximum Storage: 17kB
                      SubPlan 3
                        ->  Index Scan using idx_document_chunks_document_id on document_chunks c2  (cost=0.29..84.73 rows=20 width=0) (never executed)
                              Index Cond: (document_id = c_2.document_id)
                              Filter: (is_current AND (tenant_key = '<tenant>'::text) AND (chunking_profile_id = ep.profile_id))
                              Index Searches: 0
  ->  Nested Loop  (cost=1127.76..1756.21 rows=75 width=728) (actual time=15.768..16.078 rows=37.00 loops=1)
        Buffers: shared hit=867
        ->  Nested Loop  (cost=1127.48..1733.00 rows=75 width=592) (actual time=15.757..15.940 rows=37.00 loops=1)
              Buffers: shared hit=756
              ->  Limit  (cost=1127.19..1169.37 rows=75 width=28) (actual time=15.748..15.795 rows=37.00 loops=1)
                    Buffers: shared hit=645
                    ->  WindowAgg  (cost=1127.19..1211.55 rows=150 width=28) (actual time=15.746..15.781 rows=37.00 loops=1)
                          Window: window1 AS (ORDER BY ((SubPlan 6)), cand.hid ROWS UNBOUNDED PRECEDING)
                          Storage: Memory  Maximum Storage: 17kB
                          Buffers: shared hit=645
                          ->  Sort  (cost=1127.17..1127.55 rows=150 width=24) (actual time=15.741..15.751 rows=37.00 loops=1)
                                Sort Key: ((SubPlan 6)) DESC, cand.hid
                                Sort Method: quicksort  Memory: 18kB
                                Buffers: shared hit=645
                                ->  Nested Loop  (cost=0.29..1121.75 rows=150 width=24) (actual time=3.161..15.718 rows=37.00 loops=1)
                                      Buffers: shared hit=645
                                      ->  CTE Scan on cand  (cost=0.00..3.00 rows=150 width=16) (actual time=2.862..2.906 rows=37.00 loops=1)
                                            Storage: Memory  Maximum Storage: 18kB
                                            Buffers: shared hit=420
                                      ->  Index Scan using document_chunks_pkey on document_chunks c_1  (cost=0.29..6.92 rows=1 width=85) (actual time=0.004..0.004 rows=1.00 loops=37)
                                            Index Cond: (id = cand.hid)
                                            Index Searches: 37
                                            Buffers: shared hit=111
                                      SubPlan 6
                                        ->  Aggregate  (cost=0.53..0.54 rows=1 width=8) (actual time=0.340..0.340 rows=1.00 loops=37)
                                              Buffers: shared hit=114
                                              ->  Hash Join  (cost=0.26..0.51 rows=1 width=24) (actual time=0.230..0.338 rows=1.00 loops=37)
                                                    Hash Cond: (x.lexeme = q_1.tok)
                                                    Buffers: shared hit=114
                                                    ->  WindowAgg  (cost=0.23..0.33 rows=10 width=48) (actual time=0.205..0.273 rows=202.84 loops=37)
                                                          Window: window1 AS ()
                                                          Storage: Memory  Maximum Storage: 31kB
                                                          Buffers: shared hit=114
                                                          ->  Function Scan on unnest x  (cost=0.00..0.10 rows=10 width=64) (actual time=0.072..0.113 rows=202.84 loops=37)
                                                                Buffers: shared hit=114
                                                    ->  Hash  (cost=0.02..0.02 rows=1 width=40) (actual time=0.003..0.004 rows=1.00 loops=1)
                                                          Buckets: 1024  Batches: 1  Memory Usage: 5kB
                                                          ->  CTE Scan on q q_1  (cost=0.00..0.02 rows=1 width=40) (actual time=0.001..0.001 rows=1.00 loops=1)
                                                                Storage: Memory  Maximum Storage: 17kB
              ->  Index Scan using document_chunks_pkey on document_chunks c  (cost=0.29..7.50 rows=1 width=580) (actual time=0.003..0.003 rows=1.00 loops=37)
                    Index Cond: (id = cand.hid)
                    Index Searches: 37
                    Buffers: shared hit=111
        ->  Index Scan using documents_pkey on documents d  (cost=0.28..0.30 rows=1 width=67) (actual time=0.002..0.002 rows=1.00 loops=37)
              Index Cond: (id = c.document_id)
              Index Searches: 37
              Buffers: shared hit=111
```

#### mixed_rare_common: ts_rank_cd lexical leg

```
WindowAgg  (cost=7262.78..7843.27 rows=75 width=744) (actual time=536.479..537.262 rows=75.00 loops=1)
  Window: window1 AS (ORDER BY t.score, t.hid ROWS UNBOUNDED PRECEDING)
  Storage: Memory  Maximum Storage: 18kB
  Buffers: shared hit=179056, local hit=1
  CTE hits
    ->  Limit  (cost=7254.19..7254.37 rows=75 width=20) (actual time=536.423..536.481 rows=75.00 loops=1)
          Buffers: shared hit=178606, local hit=1
          ->  Sort  (cost=7254.19..7291.67 rows=14992 width=20) (actual time=536.421..536.442 rows=75.00 loops=1)
                Sort Key: (ts_rank_cd(c_1.lexical_tsv, '''<term>'' | ''<term>'' | ''<term>'' | ''<term>'''::tsquery, 1)) DESC, c_1.id
                Sort Method: top-N heapsort  Memory: 26kB
                Buffers: shared hit=178606, local hit=1
                ->  Hash Join  (cost=123.55..6712.31 rows=14992 width=20) (actual time=0.862..522.901 rows=29969.00 loops=1)
                      Hash Cond: (c_1.document_id = d_1.id)
                      Buffers: shared hit=178606, local hit=1
                      ->  Hash Join  (cost=29.80..6541.62 rows=14992 width=101) (actual time=0.043..184.790 rows=29969.00 loops=1)
                            Hash Cond: (c_1.doc_type = ep.doc_type)
                            Join Filter: ((c_1.chunking_profile_id = ep.profile_id) OR ((ep.profile_id <> 'legacy'::text) AND (c_1.chunking_profile_id = 'legacy'::text) AND (c_1.chunk_kind = ANY ('{image,invoice_header}'::text[]))) OR ((ep.profile_id <> 'legacy'::text) AND (c_1.chunking_profile_id = 'legacy'::text) AND (NOT (ANY ((c_1.document_id = (hashed SubPlan 2).col1) AND (ep.profile_id = (hashed SubPlan 2).col2))))))
                            Buffers: shared hit=92217, local hit=1
                            ->  Seq Scan on document_chunks c_1  (cost=0.00..6356.00 rows=29984 width=121) (actual time=0.027..159.134 rows=29969.00 loops=1)
                                  Filter: (is_current AND (status = ANY ('{ready,variant}'::text[])) AND (lexical_tsv @@ '''<term>'' | ''<term>'' | ''<term>'' | ''<term>'''::tsquery) AND (tenant_key = '<tenant>'::text))
                                  Rows Removed by Filter: 31
                                  Buffers: shared hit=92217
                            ->  Hash  (cost=18.80..18.80 rows=880 width=64) (actual time=0.009..0.010 rows=6.00 loops=1)
                                  Buckets: 1024  Batches: 1  Memory Usage: 5kB
                                  Buffers: local hit=1
                                  ->  Seq Scan on _hybrid_eff_profile ep  (cost=0.00..18.80 rows=880 width=64) (actual time=0.003..0.005 rows=6.00 loops=1)
                                        Buffers: local hit=1
                            SubPlan 2
                              ->  Seq Scan on document_chunks c2  (cost=0.00..6206.00 rows=30000 width=23) (never executed)
                                    Filter: (is_current AND (tenant_key = '<tenant>'::text))
                      ->  Hash  (cost=75.00..75.00 rows=1500 width=16) (actual time=0.785..0.786 rows=1500.00 loops=1)
                            Buckets: 2048  Batches: 1  Memory Usage: 67kB
                            Buffers: shared hit=60
                            ->  Seq Scan on documents d_1  (cost=0.00..75.00 rows=1500 width=16) (actual time=0.004..0.408 rows=1500.00 loops=1)
                                  Buffers: shared hit=60
  ->  Nested Loop  (cost=0.56..587.21 rows=75 width=651) (actual time=536.463..537.133 rows=75.00 loops=1)
        Buffers: shared hit=179056, local hit=1
        ->  Nested Loop  (cost=0.29..564.38 rows=75 width=600) (actual time=536.450..536.898 rows=75.00 loops=1)
              Buffers: shared hit=178831, local hit=1
              ->  CTE Scan on hits t  (cost=0.00..1.50 rows=75 width=20) (actual time=536.428..536.517 rows=75.00 loops=1)
                    Storage: Memory  Maximum Storage: 20kB
                    Buffers: shared hit=178606, local hit=1
              ->  Index Scan using document_chunks_pkey on document_chunks c  (cost=0.29..7.50 rows=1 width=580) (actual time=0.004..0.004 rows=1.00 loops=75)
                    Index Cond: (id = t.hid)
                    Index Searches: 75
                    Buffers: shared hit=225
        ->  Index Scan using documents_pkey on documents d  (cost=0.28..0.30 rows=1 width=67) (actual time=0.002..0.002 rows=1.00 loops=75)
              Index Cond: (id = c.document_id)
              Index Searches: 75
              Buffers: shared hit=225
```

#### mixed_rare_common: BM25 statement

```
Sort  (cost=152430.10..152430.28 rows=75 width=728) (actual time=990.971..990.998 rows=75.00 loops=1)
  Sort Key: ((row_number() OVER <term>)::integer)
  Sort Method: quicksort  Memory: 68kB
  Buffers: shared hit=445533
  CTE q
    ->  Function Scan on u  (cost=0.01..0.07 rows=4 width=72) (actual time=0.008..0.013 rows=4.00 loops=1)
  CTE cand
    ->  Limit  (cost=148742.36..148743.61 rows=500 width=24) (actual time=783.959..784.404 rows=500.00 loops=1)
          Buffers: shared hit=442033
          ->  Sort  (cost=148742.36..148817.32 rows=29984 width=24) (actual time=783.956..784.172 rows=500.00 loops=1)
                Sort Key: ((SubPlan 2)) DESC, c_2.id
                Sort Method: top-N heapsort  Memory: 77kB
                Buffers: shared hit=442033
                ->  Nested Loop  (cost=2.54..147248.28 rows=29984 width=24) (actual time=0.105..770.152 rows=29969.00 loops=1)
                      Buffers: shared hit=442033
                      ->  Hash Semi Join  (cost=2.25..142443.94 rows=29984 width=101) (actual time=0.050..178.434 rows=29969.00 loops=1)
                            Hash Cond: (c_2.doc_type = ep.doc_type)
                            Join Filter: ((c_2.chunking_profile_id = ep.profile_id) OR ((ep.profile_id <> 'legacy'::text) AND (c_2.chunking_profile_id = 'legacy'::text) AND (c_2.chunk_kind = ANY ('{image,invoice_header}'::text[]))) OR ((ep.profile_id <> 'legacy'::text) AND (c_2.chunking_profile_id = 'legacy'::text) AND (NOT (ANY ((c_2.document_id = (hashed SubPlan 4).col1) AND (ep.profile_id = (hashed SubPlan 4).col2))))))
                            Buffers: shared hit=92217
                            ->  Seq Scan on document_chunks c_2  (cost=0.00..6356.00 rows=29984 width=121) (actual time=0.032..152.716 rows=29969.00 loops=1)
                                  Filter: (is_current AND (status = ANY ('{ready,variant}'::text[])) AND (lexical_tsv @@ '''<term>'' | ''<term>'' | ''<term>'' | ''<term>'''::tsquery) AND (tenant_key = '<tenant>'::text))
                                  Rows Removed by Filter: 31
                                  Buffers: shared hit=92217
                            ->  Hash  (cost=1.00..1.00 rows=100 width=64) (actual time=0.012..0.013 rows=6.00 loops=1)
                                  Buckets: 1024  Batches: 1  Memory Usage: 5kB
                                  ->  Function Scan on jsonb_each_text ep  (cost=0.00..1.00 rows=100 width=64) (actual time=0.007..0.008 rows=6.00 loops=1)
                            SubPlan 4
                              ->  Seq Scan on document_chunks c2  (cost=0.00..6206.00 rows=30000 width=23) (never executed)
                                    Filter: (is_current AND (tenant_key = '<tenant>'::text))
                      ->  Memoize  (cost=0.29..0.31 rows=1 width=16) (actual time=0.001..0.001 rows=1.00 loops=29969)
                            Cache Key: c_2.document_id
                            Cache Mode: logical
                            Hits: 28469  Misses: 1500  Evictions: 0  Overflows: 0  Memory Usage: 147kB
                            Buffers: shared hit=4500
                            ->  Index Only Scan using documents_pkey on documents d_1  (cost=0.28..0.30 rows=1 width=16) (actual time=0.003..0.003 rows=1.00 loops=1500)
                                  Index Cond: (id = c_2.document_id)
                                  Heap Fetches: 1500
                                  Index Searches: 1500
                                  Buffers: shared hit=4500
                      SubPlan 2
                        ->  Aggregate  (cost=0.11..0.12 rows=1 width=8) (actual time=0.017..0.017 rows=1.00 loops=29969)
                              Buffers: shared hit=345316
                              ->  CTE Scan on q  (cost=0.00..0.08 rows=4 width=40) (actual time=0.000..0.002 rows=4.00 loops=29969)
                                    Storage: Memory  Maximum Storage: 17kB
  ->  Nested Loop  (cost=3041.00..3684.08 rows=75 width=728) (actual time=989.914..990.896 rows=75.00 loops=1)
        Buffers: shared hit=445533
        ->  Nested Loop  (cost=3040.72..3660.87 rows=75 width=592) (actual time=989.898..990.626 rows=75.00 loops=1)
              Buffers: shared hit=445308
              ->  Limit  (cost=3040.43..3097.24 rows=75 width=28) (actual time=989.888..990.259 rows=75.00 loops=1)
                    Buffers: shared hit=445083
                    ->  WindowAgg  (cost=3040.43..3419.16 rows=500 width=28) (actual time=989.887..990.234 rows=75.00 loops=1)
                          Window: window1 AS (ORDER BY ((SubPlan 6)), cand.hid ROWS UNBOUNDED PRECEDING)
                          Storage: Memory  Maximum Storage: 17kB
                          Buffers: shared hit=445083
                          ->  Sort  (cost=3040.41..3041.66 rows=500 width=24) (actual time=989.880..989.897 rows=75.00 loops=1)
                                Sort Key: ((SubPlan 6)) DESC, cand.hid
                                Sort Method: quicksort  Memory: 36kB
                                Buffers: shared hit=445083
                                ->  Nested Loop  (cost=0.29..3018.00 rows=500 width=24) (actual time=784.748..989.137 rows=500.00 loops=1)
                                      Buffers: shared hit=445083
                                      ->  CTE Scan on cand  (cost=0.00..10.00 rows=500 width=16) (actual time=783.964..784.759 rows=500.00 loops=1)
                                            Storage: Memory  Maximum Storage: 40kB
                                            Buffers: shared hit=442033
                                      ->  Index Scan using document_chunks_pkey on document_chunks c_1  (cost=0.29..5.28 rows=1 width=85) (actual time=0.005..0.005 rows=1.00 loops=500)
                                            Index Cond: (id = cand.hid)
                                            Index Searches: 500
                                            Buffers: shared hit=1500
                                      SubPlan 6
                                        ->  Aggregate  (cost=0.73..0.74 rows=1 width=8) (actual time=0.400..0.401 rows=1.00 loops=500)
                                              Buffers: shared hit=1550
                                              ->  Hash Join  (cost=0.36..0.64 rows=4 width=24) (actual time=0.254..0.397 rows=2.11 loops=500)
                                                    Hash Cond: (x.lexeme = q_1.tok)
                                                    Buffers: shared hit=1550
                                                    ->  WindowAgg  (cost=0.23..0.33 rows=10 width=48) (actual time=0.252..0.334 rows=214.63 loops=500)
                                                          Window: window1 AS ()
                                                          Storage: Memory  Maximum Storage: 32kB
                                                          Buffers: shared hit=1550
                                                          ->  Function Scan on unnest x  (cost=0.00..0.10 rows=10 width=64) (actual time=0.087..0.153 rows=214.63 loops=500)
                                                                Buffers: shared hit=1550
                                                    ->  Hash  (cost=0.08..0.08 rows=4 width=40) (actual time=0.013..0.014 rows=4.00 loops=1)
                                                          Buckets: 1024  Batches: 1  Memory Usage: 5kB
                                                          ->  CTE Scan on q q_1  (cost=0.00..0.08 rows=4 width=40) (actual time=0.003..0.006 rows=4.00 loops=1)
                                                                Storage: Memory  Maximum Storage: 17kB
              ->  Index Scan using document_chunks_pkey on document_chunks c  (cost=0.29..7.50 rows=1 width=580) (actual time=0.004..0.004 rows=1.00 loops=75)
                    Index Cond: (id = cand.hid)
                    Index Searches: 75
                    Buffers: shared hit=225
        ->  Index Scan using documents_pkey on documents d  (cost=0.28..0.30 rows=1 width=67) (actual time=0.002..0.002 rows=1.00 loops=75)
              Index Cond: (id = c.document_id)
              Index Searches: 75
              Buffers: shared hit=225
```

#### many_terms: ts_rank_cd lexical leg

```
WindowAgg  (cost=6665.35..7245.85 rows=75 width=744) (actual time=324.051..324.869 rows=75.00 loops=1)
  Window: window1 AS (ORDER BY t.score, t.hid ROWS UNBOUNDED PRECEDING)
  Storage: Memory  Maximum Storage: 19kB
  Buffers: shared hit=115233, local hit=1
  CTE hits
    ->  Limit  (cost=6656.76..6656.95 rows=75 width=20) (actual time=323.998..324.061 rows=75.00 loops=1)
          Buffers: shared hit=114783, local hit=1
          ->  Sort  (cost=6656.76..6665.31 rows=3419 width=20) (actual time=323.996..324.017 rows=75.00 loops=1)
                Sort Key: (ts_rank_cd(c_1.lexical_tsv, '''<term>'' | ''<term>'' | ''<term>'' | ''<term>'' | ''<term>'' | ''<term>'' | ''<term>'' | ''<term>'''::tsquery, 1)) DESC, c_1.id
                Sort Method: top-N heapsort  Memory: 26kB
                Buffers: shared hit=114783, local hit=1
                ->  Hash Join  (cost=123.55..6533.19 rows=3419 width=20) (actual time=1.408..318.992 rows=7499.00 loops=1)
                      Hash Cond: (c_1.document_id = d_1.id)
                      Buffers: shared hit=114783, local hit=1
                      ->  Hash Join  (cost=29.80..6421.89 rows=3419 width=101) (actual time=0.052..189.422 rows=7499.00 loops=1)
                            Hash Cond: (c_1.doc_type = ep.doc_type)
                            Join Filter: ((c_1.chunking_profile_id = ep.profile_id) OR ((ep.profile_id <> 'legacy'::text) AND (c_1.chunking_profile_id = 'legacy'::text) AND (c_1.chunk_kind = ANY ('{image,invoice_header}'::text[]))) OR ((ep.profile_id <> 'legacy'::text) AND (c_1.chunking_profile_id = 'legacy'::text) AND (NOT (ANY ((c_1.document_id = (hashed SubPlan 2).col1) AND (ep.profile_id = (hashed SubPlan 2).col2))))))
                            Buffers: shared hit=92217, local hit=1
                            ->  Seq Scan on document_chunks c_1  (cost=0.00..6356.00 rows=6837 width=121) (actual time=0.036..180.501 rows=7499.00 loops=1)
                                  Filter: (is_current AND (status = ANY ('{ready,variant}'::text[])) AND (lexical_tsv @@ '''<term>'' | ''<term>'' | ''<term>'' | ''<term>'' | ''<term>'' | ''<term>'' | ''<term>'' | ''<term>'''::tsquery) AND (tenant_key = '<tenant>'::text))
                                  Rows Removed by Filter: 22501
                                  Buffers: shared hit=92217
                            ->  Hash  (cost=18.80..18.80 rows=880 width=64) (actual time=0.010..0.011 rows=6.00 loops=1)
                                  Buckets: 1024  Batches: 1  Memory Usage: 5kB
                                  Buffers: local hit=1
                                  ->  Seq Scan on _hybrid_eff_profile ep  (cost=0.00..18.80 rows=880 width=64) (actual time=0.004..0.005 rows=6.00 loops=1)
                                        Buffers: local hit=1
                            SubPlan 2
                              ->  Seq Scan on document_chunks c2  (cost=0.00..6206.00 rows=30000 width=23) (never executed)
                                    Filter: (is_current AND (tenant_key = '<tenant>'::text))
                      ->  Hash  (cost=75.00..75.00 rows=1500 width=16) (actual time=1.289..1.290 rows=1500.00 loops=1)
                            Buckets: 2048  Batches: 1  Memory Usage: 67kB
                            Buffers: shared hit=60
                            ->  Seq Scan on documents d_1  (cost=0.00..75.00 rows=1500 width=16) (actual time=0.004..0.405 rows=1500.00 loops=1)
                                  Buffers: shared hit=60
  ->  Nested Loop  (cost=0.56..587.21 rows=75 width=651) (actual time=324.036..324.724 rows=75.00 loops=1)
        Buffers: shared hit=115233, local hit=1
        ->  Nested Loop  (cost=0.29..564.38 rows=75 width=600) (actual time=324.023..324.485 rows=75.00 loops=1)
              Buffers: shared hit=115008, local hit=1
              ->  CTE Scan on hits t  (cost=0.00..1.50 rows=75 width=20) (actual time=324.002..324.097 rows=75.00 loops=1)
                    Storage: Memory  Maximum Storage: 20kB
                    Buffers: shared hit=114783, local hit=1
              ->  Index Scan using document_chunks_pkey on document_chunks c  (cost=0.29..7.50 rows=1 width=580) (actual time=0.004..0.004 rows=1.00 loops=75)
                    Index Cond: (id = t.hid)
                    Index Searches: 75
                    Buffers: shared hit=225
        ->  Index Scan using documents_pkey on documents d  (cost=0.28..0.30 rows=1 width=67) (actual time=0.002..0.002 rows=1.00 loops=75)
              Index Cond: (id = c.document_id)
              Index Searches: 75
              Buffers: shared hit=225
```

#### many_terms: BM25 statement

```
Sort  (cost=43250.98..43251.17 rows=75 width=728) (actual time=620.980..621.008 rows=75.00 loops=1)
  Sort Key: ((row_number() OVER <term>)::integer)
  Sort Method: quicksort  Memory: 62kB
  Buffers: shared hit=275818
  CTE q
    ->  Function Scan on u  (cost=0.01..0.15 rows=8 width=72) (actual time=0.012..0.020 rows=8.00 loops=1)
  CTE cand
    ->  Limit  (cost=39413.67..39414.92 rows=500 width=24) (actual time=438.402..439.118 rows=500.00 loops=1)
          Buffers: shared hit=272325
          ->  Sort  (cost=39413.67..39430.77 rows=6837 width=24) (actual time=438.401..438.571 rows=500.00 loops=1)
                Sort Key: ((SubPlan 2)) DESC, c_2.id
                Sort Method: top-N heapsort  Memory: 77kB
                Buffers: shared hit=272325
                ->  Hash Semi Join  (cost=96.00..39072.99 rows=6837 width=24) (actual time=0.971..433.201 rows=7499.00 loops=1)
                      Hash Cond: (c_2.doc_type = ep.doc_type)
                      Join Filter: ((c_2.chunking_profile_id = ep.profile_id) OR ((ep.profile_id <> 'legacy'::text) AND (c_2.chunking_profile_id = 'legacy'::text) AND (c_2.chunk_kind = ANY ('{image,invoice_header}'::text[]))) OR ((ep.profile_id <> 'legacy'::text) AND (c_2.chunking_profile_id = 'legacy'::text) AND (NOT (ANY ((c_2.document_id = (hashed SubPlan 4).col1) AND (ep.profile_id = (hashed SubPlan 4).col2))))))
                      Buffers: shared hit=272325
                      ->  Hash Join  (cost=93.75..6467.75 rows=6837 width=121) (actual time=0.883..172.731 rows=7499.00 loops=1)
                            Hash Cond: (c_2.document_id = d_1.id)
                            Buffers: shared hit=92277
                            ->  Seq Scan on document_chunks c_2  (cost=0.00..6356.00 rows=6837 width=121) (actual time=0.070..164.477 rows=7499.00 loops=1)
                                  Filter: (is_current AND (status = ANY ('{ready,variant}'::text[])) AND (lexical_tsv @@ '''<term>'' | ''<term>'' | ''<term>'' | ''<term>'' | ''<term>'' | ''<term>'' | ''<term>'' | ''<term>'''::tsquery) AND (tenant_key = '<tenant>'::text))
                                  Rows Removed by Filter: 22501
                                  Buffers: shared hit=92217
                            ->  Hash  (cost=75.00..75.00 rows=1500 width=16) (actual time=0.808..0.809 rows=1500.00 loops=1)
                                  Buckets: 2048  Batches: 1  Memory Usage: 67kB
                                  Buffers: shared hit=60
                                  ->  Seq Scan on documents d_1  (cost=0.00..75.00 rows=1500 width=16) (actual time=0.005..0.435 rows=1500.00 loops=1)
                                        Buffers: shared hit=60
                      ->  Hash  (cost=1.00..1.00 rows=100 width=64) (actual time=0.012..0.013 rows=6.00 loops=1)
                            Buckets: 1024  Batches: 1  Memory Usage: 5kB
                            ->  Function Scan on jsonb_each_text ep  (cost=0.00..1.00 rows=100 width=64) (actual time=0.007..0.008 rows=6.00 loops=1)
                      SubPlan 2
                        ->  Aggregate  (cost=0.22..0.23 rows=1 width=8) (actual time=0.033..0.033 rows=1.00 loops=7499)
                              Buffers: shared hit=180048
                              ->  CTE Scan on q  (cost=0.00..0.16 rows=8 width=40) (actual time=0.000..0.002 rows=8.00 loops=7499)
                                    Storage: Memory  Maximum Storage: 17kB
                      SubPlan 4
                        ->  Seq Scan on document_chunks c2  (cost=0.00..6206.00 rows=30000 width=23) (never executed)
                              Filter: (is_current AND (tenant_key = '<tenant>'::text))
  ->  Nested Loop  (cost=3171.00..3833.58 rows=75 width=728) (actual time=620.205..620.904 rows=75.00 loops=1)
        Buffers: shared hit=275818
        ->  Nested Loop  (cost=3170.72..3810.37 rows=75 width=592) (actual time=620.189..620.646 rows=75.00 loops=1)
              Buffers: shared hit=275593
              ->  Limit  (cost=3170.43..3246.74 rows=75 width=28) (actual time=620.179..620.264 rows=75.00 loops=1)
                    Buffers: shared hit=275368
                    ->  WindowAgg  (cost=3170.43..3679.16 rows=500 width=28) (actual time=620.177..620.240 rows=75.00 loops=1)
                          Window: window1 AS (ORDER BY ((SubPlan 6)), cand.hid ROWS UNBOUNDED PRECEDING)
                          Storage: Memory  Maximum Storage: 17kB
                          Buffers: shared hit=275368
                          ->  Sort  (cost=3170.41..3171.66 rows=500 width=24) (actual time=620.170..620.186 rows=75.00 loops=1)
                                Sort Key: ((SubPlan 6)) DESC, cand.hid
                                Sort Method: quicksort  Memory: 36kB
                                Buffers: shared hit=275368
                                ->  Nested Loop  (cost=0.29..3148.00 rows=500 width=24) (actual time=438.847..619.840 rows=500.00 loops=1)
                                      Buffers: shared hit=275368
                                      ->  CTE Scan on cand  (cost=0.00..10.00 rows=500 width=16) (actual time=438.407..439.442 rows=500.00 loops=1)
                                            Storage: Memory  Maximum Storage: 40kB
                                            Buffers: shared hit=272325
                                      ->  Index Scan using document_chunks_pkey on document_chunks c_1  (cost=0.29..5.28 rows=1 width=85) (actual time=0.005..0.005 rows=1.00 loops=500)
                                            Index Cond: (id = cand.hid)
                                            Index Searches: 500
                                            Buffers: shared hit=1500
                                      SubPlan 6
                                        ->  Aggregate  (cost=0.99..1.00 rows=1 width=8) (actual time=0.353..0.354 rows=1.00 loops=500)
                                              Buffers: shared hit=1543
                                              ->  Hash Join  (cost=0.49..0.81 rows=8 width=24) (actual time=0.274..0.351 rows=2.15 loops=500)
                                                    Hash Cond: (x.lexeme = q_1.tok)
                                                    Buffers: shared hit=1543
                                                    ->  WindowAgg  (cost=0.23..0.33 rows=10 width=48) (actual time=0.224..0.306 rows=199.65 loops=500)
                                                          Window: window1 AS ()
                                                          Storage: Memory  Maximum Storage: 32kB
                                                          Buffers: shared hit=1543
                                                          ->  Function Scan on unnest x  (cost=0.00..0.10 rows=10 width=64) (actual time=0.077..0.122 rows=199.65 loops=500)
                                                                Buffers: shared hit=1543
                                                    ->  Hash  (cost=0.16..0.16 rows=8 width=40) (actual time=0.009..0.010 rows=8.00 loops=1)
                                                          Buckets: 1024  Batches: 1  Memory Usage: 5kB
                                                          ->  CTE Scan on q q_1  (cost=0.00..0.16 rows=8 width=40) (actual time=0.001..0.004 rows=8.00 loops=1)
                                                                Storage: Memory  Maximum Storage: 17kB
              ->  Index Scan using document_chunks_pkey on document_chunks c  (cost=0.29..7.50 rows=1 width=580) (actual time=0.004..0.004 rows=1.00 loops=75)
                    Index Cond: (id = cand.hid)
                    Index Searches: 75
                    Buffers: shared hit=225
        ->  Index Scan using documents_pkey on documents d  (cost=0.28..0.30 rows=1 width=67) (actual time=0.002..0.002 rows=1.00 loops=75)
              Index Cond: (id = c.document_id)
              Index Searches: 75
              Buffers: shared hit=225
```

#### common_only: ts_rank_cd lexical leg

```
WindowAgg  (cost=7261.20..7841.69 rows=75 width=744) (actual time=492.043..492.881 rows=75.00 loops=1)
  Window: window1 AS (ORDER BY t.score, t.hid ROWS UNBOUNDED PRECEDING)
  Storage: Memory  Maximum Storage: 18kB
  Buffers: shared hit=178519, local hit=1
  CTE hits
    ->  Limit  (cost=7252.61..7252.79 rows=75 width=20) (actual time=491.974..492.020 rows=75.00 loops=1)
          Buffers: shared hit=178069, local hit=1
          ->  Sort  (cost=7252.61..7290.00 rows=14958 width=20) (actual time=491.971..491.994 rows=75.00 loops=1)
                Sort Key: (ts_rank_cd(c_1.lexical_tsv, '''<term>'' | ''<term>'' | ''<term>'''::tsquery, 1)) DESC, c_1.id
                Sort Method: top-N heapsort  Memory: 26kB
                Buffers: shared hit=178069, local hit=1
                ->  Hash Join  (cost=123.55..6711.96 rows=14958 width=20) (actual time=0.914..477.785 rows=29691.00 loops=1)
                      Hash Cond: (c_1.document_id = d_1.id)
                      Buffers: shared hit=178069, local hit=1
                      ->  Hash Join  (cost=29.80..6541.44 rows=14958 width=101) (actual time=0.043..190.138 rows=29691.00 loops=1)
                            Hash Cond: (c_1.doc_type = ep.doc_type)
                            Join Filter: ((c_1.chunking_profile_id = ep.profile_id) OR ((ep.profile_id <> 'legacy'::text) AND (c_1.chunking_profile_id = 'legacy'::text) AND (c_1.chunk_kind = ANY ('{image,invoice_header}'::text[]))) OR ((ep.profile_id <> 'legacy'::text) AND (c_1.chunking_profile_id = 'legacy'::text) AND (NOT (ANY ((c_1.document_id = (hashed SubPlan 2).col1) AND (ep.profile_id = (hashed SubPlan 2).col2))))))
                            Buffers: shared hit=92217, local hit=1
                            ->  Seq Scan on document_chunks c_1  (cost=0.00..6356.00 rows=29916 width=121) (actual time=0.026..165.843 rows=29691.00 loops=1)
                                  Filter: (is_current AND (status = ANY ('{ready,variant}'::text[])) AND (lexical_tsv @@ '''<term>'' | ''<term>'' | ''<term>'''::tsquery) AND (tenant_key = '<tenant>'::text))
                                  Rows Removed by Filter: 309
                                  Buffers: shared hit=92217
                            ->  Hash  (cost=18.80..18.80 rows=880 width=64) (actual time=0.010..0.011 rows=6.00 loops=1)
                                  Buckets: 1024  Batches: 1  Memory Usage: 5kB
                                  Buffers: local hit=1
                                  ->  Seq Scan on _hybrid_eff_profile ep  (cost=0.00..18.80 rows=880 width=64) (actual time=0.003..0.005 rows=6.00 loops=1)
                                        Buffers: local hit=1
                            SubPlan 2
                              ->  Seq Scan on document_chunks c2  (cost=0.00..6206.00 rows=30000 width=23) (never executed)
                                    Filter: (is_current AND (tenant_key = '<tenant>'::text))
                      ->  Hash  (cost=75.00..75.00 rows=1500 width=16) (actual time=0.840..0.841 rows=1500.00 loops=1)
                            Buckets: 2048  Batches: 1  Memory Usage: 67kB
                            Buffers: shared hit=60
                            ->  Seq Scan on documents d_1  (cost=0.00..75.00 rows=1500 width=16) (actual time=0.004..0.445 rows=1500.00 loops=1)
                                  Buffers: shared hit=60
  ->  Nested Loop  (cost=0.56..587.21 rows=75 width=651) (actual time=492.023..492.741 rows=75.00 loops=1)
        Buffers: shared hit=178519, local hit=1
        ->  Nested Loop  (cost=0.29..564.38 rows=75 width=600) (actual time=492.006..492.445 rows=75.00 loops=1)
              Buffers: shared hit=178294, local hit=1
              ->  CTE Scan on hits t  (cost=0.00..1.50 rows=75 width=20) (actual time=491.979..492.055 rows=75.00 loops=1)
                    Storage: Memory  Maximum Storage: 20kB
                    Buffers: shared hit=178069, local hit=1
              ->  Index Scan using document_chunks_pkey on document_chunks c  (cost=0.29..7.50 rows=1 width=580) (actual time=0.004..0.004 rows=1.00 loops=75)
                    Index Cond: (id = t.hid)
                    Index Searches: 75
                    Buffers: shared hit=225
        ->  Index Scan using documents_pkey on documents d  (cost=0.28..0.30 rows=1 width=67) (actual time=0.002..0.002 rows=1.00 loops=75)
              Index Cond: (id = c.document_id)
              Index Searches: 75
              Buffers: shared hit=225
```

#### common_only: BM25 statement

```
Sort  (cost=151248.17..151248.36 rows=75 width=728) (actual time=1092.969..1093.021 rows=75.00 loops=1)
  Sort Key: ((row_number() OVER <term>)::integer)
  Sort Method: quicksort  Memory: 52kB
  Buffers: shared hit=357614
  CTE q
    ->  Function Scan on u  (cost=0.01..0.06 rows=3 width=72) (actual time=0.008..0.011 rows=3.00 loops=1)
  CTE cand
    ->  Limit  (cost=147597.82..147599.07 rows=500 width=24) (actual time=700.294..701.046 rows=500.00 loops=1)
          Buffers: shared hit=354093
          ->  Sort  (cost=147597.82..147672.61 rows=29916 width=24) (actual time=700.292..700.638 rows=500.00 loops=1)
                Sort Key: ((SubPlan 2)) DESC, c_2.id
                Sort Method: top-N heapsort  Memory: 77kB
                Buffers: shared hit=354093
                ->  Nested Loop  (cost=2.54..146107.14 rows=29916 width=24) (actual time=0.092..683.981 rows=29691.00 loops=1)
                      Buffers: shared hit=354093
                      ->  Hash Semi Join  (cost=2.25..142135.31 rows=29916 width=101) (actual time=0.045..189.307 rows=29691.00 loops=1)
                            Hash Cond: (c_2.doc_type = ep.doc_type)
                            Join Filter: ((c_2.chunking_profile_id = ep.profile_id) OR ((ep.profile_id <> 'legacy'::text) AND (c_2.chunking_profile_id = 'legacy'::text) AND (c_2.chunk_kind = ANY ('{image,invoice_header}'::text[]))) OR ((ep.profile_id <> 'legacy'::text) AND (c_2.chunking_profile_id = 'legacy'::text) AND (NOT (ANY ((c_2.document_id = (hashed SubPlan 4).col1) AND (ep.profile_id = (hashed SubPlan 4).col2))))))
                            Buffers: shared hit=92217
                            ->  Seq Scan on document_chunks c_2  (cost=0.00..6356.00 rows=29916 width=121) (actual time=0.027..160.682 rows=29691.00 loops=1)
                                  Filter: (is_current AND (status = ANY ('{ready,variant}'::text[])) AND (lexical_tsv @@ '''<term>'' | ''<term>'' | ''<term>'''::tsquery) AND (tenant_key = '<tenant>'::text))
                                  Rows Removed by Filter: 309
                                  Buffers: shared hit=92217
                            ->  Hash  (cost=1.00..1.00 rows=100 width=64) (actual time=0.011..0.013 rows=6.00 loops=1)
                                  Buckets: 1024  Batches: 1  Memory Usage: 5kB
                                  ->  Function Scan on jsonb_each_text ep  (cost=0.00..1.00 rows=100 width=64) (actual time=0.006..0.008 rows=6.00 loops=1)
                            SubPlan 4
                              ->  Seq Scan on document_chunks c2  (cost=0.00..6206.00 rows=30000 width=23) (never executed)
                                    Filter: (is_current AND (tenant_key = '<tenant>'::text))
                      ->  Memoize  (cost=0.29..0.31 rows=1 width=16) (actual time=0.001..0.001 rows=1.00 loops=29691)
                            Cache Key: c_2.document_id
                            Cache Mode: logical
                            Hits: 28191  Misses: 1500  Evictions: 0  Overflows: 0  Memory Usage: 147kB
                            Buffers: shared hit=4500
                            ->  Index Only Scan using documents_pkey on documents d_1  (cost=0.28..0.30 rows=1 width=16) (actual time=0.003..0.003 rows=1.00 loops=1500)
                                  Index Cond: (id = c_2.document_id)
                                  Heap Fetches: 1500
                                  Index Searches: 1500
                                  Buffers: shared hit=4500
                      SubPlan 2
                        ->  Aggregate  (cost=0.08..0.09 rows=1 width=8) (actual time=0.014..0.014 rows=1.00 loops=29691)
                              Buffers: shared hit=257376
                              ->  CTE Scan on q  (cost=0.00..0.06 rows=3 width=40) (actual time=0.000..0.001 rows=3.00 loops=29691)
                                    Storage: Memory  Maximum Storage: 17kB
  ->  Nested Loop  (cost=3008.50..3646.70 rows=75 width=728) (actual time=1091.662..1092.854 rows=75.00 loops=1)
        Buffers: shared hit=357614
        ->  Nested Loop  (cost=3008.22..3623.49 rows=75 width=592) (actual time=1091.641..1092.365 rows=75.00 loops=1)
              Buffers: shared hit=357389
              ->  Limit  (cost=3007.93..3059.87 rows=75 width=28) (actual time=1091.625..1091.794 rows=75.00 loops=1)
                    Buffers: shared hit=357164
                    ->  WindowAgg  (cost=3007.93..3354.16 rows=500 width=28) (actual time=1091.623..1091.745 rows=75.00 loops=1)
                          Window: window1 AS (ORDER BY ((SubPlan 6)), cand.hid ROWS UNBOUNDED PRECEDING)
                          Storage: Memory  Maximum Storage: 17kB
                          Buffers: shared hit=357164
                          ->  Sort  (cost=3007.91..3009.16 rows=500 width=24) (actual time=1091.615..1091.648 rows=75.00 loops=1)
                                Sort Key: ((SubPlan 6)) DESC, cand.hid
                                Sort Method: quicksort  Memory: 36kB
                                Buffers: shared hit=357164
                                ->  Nested Loop  (cost=0.29..2985.50 rows=500 width=24) (actual time=701.161..1089.940 rows=500.00 loops=1)
                                      Buffers: shared hit=357164
                                      ->  CTE Scan on cand  (cost=0.00..10.00 rows=500 width=16) (actual time=700.299..701.777 rows=500.00 loops=1)
                                            Storage: Memory  Maximum Storage: 40kB
                                            Buffers: shared hit=354093
                                      ->  Index Scan using document_chunks_pkey on document_chunks c_1  (cost=0.29..5.28 rows=1 width=85) (actual time=0.009..0.009 rows=1.00 loops=500)
                                            Index Cond: (id = cand.hid)
                                            Index Searches: 500
                                            Buffers: shared hit=1500
                                      SubPlan 6
                                        ->  Aggregate  (cost=0.66..0.67 rows=1 width=8) (actual time=0.761..0.761 rows=1.00 loops=500)
                                              Buffers: shared hit=1571
                                              ->  Hash Join  (cost=0.33..0.59 rows=3 width=24) (actual time=0.472..0.755 rows=3.00 loops=500)
                                                    Hash Cond: (x.lexeme = q_1.tok)
                                                    Buffers: shared hit=1571
                                                    ->  WindowAgg  (cost=0.23..0.33 rows=10 width=48) (actual time=0.466..0.660 rows=229.26 loops=500)
                                                          Window: window1 AS ()
                                                          Storage: Memory  Maximum Storage: 32kB
                                                          Buffers: shared hit=1571
                                                          ->  Function Scan on unnest x  (cost=0.00..0.10 rows=10 width=64) (actual time=0.160..0.254 rows=229.26 loops=500)
                                                                Buffers: shared hit=1571
                                                    ->  Hash  (cost=0.06..0.06 rows=3 width=40) (actual time=0.011..0.012 rows=3.00 loops=1)
                                                          Buckets: 1024  Batches: 1  Memory Usage: 5kB
                                                          ->  CTE Scan on q q_1  (cost=0.00..0.06 rows=3 width=40) (actual time=0.002..0.005 rows=3.00 loops=1)
                                                                Storage: Memory  Maximum Storage: 17kB
              ->  Index Scan using document_chunks_pkey on document_chunks c  (cost=0.29..7.50 rows=1 width=580) (actual time=0.006..0.006 rows=1.00 loops=75)
                    Index Cond: (id = cand.hid)
                    Index Searches: 75
                    Buffers: shared hit=225
        ->  Index Scan using documents_pkey on documents d  (cost=0.28..0.30 rows=1 width=67) (actual time=0.004..0.004 rows=1.00 loops=75)
              Index Cond: (id = c.document_id)
              Index Searches: 75
              Buffers: shared hit=225
```
