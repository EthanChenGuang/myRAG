# Release defaults decision (provisional: fixtures)

- Decided at: 2026-11-28T02:13:35Z
- Plan sha256: `6684e250ff5af9b86bf252a2982df22c440082adb06532ecee62e8eb8b3d71fe` (stage b, test split, 25 registered configs)
- Primary metric: `recall_at_10+correct_refusal_rate`
- Noise band: max(3.0 x spread, 0.02); min_gate_n 10; Holm alpha 0.05
- Incumbent source: `eval/decisions/04.1-retrieval-defaults.json` sha256 `63ad5e9ea7e55f5b01f24c84eef6bd3948ce49c36a743e83304281c5920cdd1c`
- Test-split uses: 26 (budget 25; unregistered 0)
- Stage-B winner: `b.incumbent`; embedding profile `openai-3-small-1536`, reranker `auto`, backend `pgvector`
- Confirmatory run: held (every_gate_held)

Fixture record: it proves the tooling only and never moves a shipped default (D-18).

## Combinations against the incumbent

| config | decision | reason | delta | band |
| --- | --- | --- | --- | --- |
| b.pgvector.c1 | keep_incumbent | slice_regression | -0.2105 | 0.0200 |
| b.pgvector.c2 | keep_incumbent | slice_regression | -0.2105 | 0.0200 |

## Backends (winner `pgvector`, no_valid_backend)

| backend | config | valid | delta | ci_low | ci_high | band | cost | operations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| weaviate | b.weaviate.c1 | no (backend_impl_fake) | n/a | n/a | n/a | n/a | not recorded | not recorded |
| qdrant | b.qdrant.c1 | no (backend_impl_fake) | n/a | n/a | n/a | n/a | not recorded | not recorded |

## Switch ablations

| switch | value | decision | reason | delta | ci_low | ci_high | band | p | p_holm | latency ok | injection ASR | too small to gate |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| RAG_PIPELINE | legacy | keep_incumbent | injection_attack_success | -0.0561 | -0.0966 | -0.0234 | 0.0200 | 1.0000 | 1.0000 | yes | 1.0000 | category:cache_near_miss, category:cache_paraphrase, category:colloquial, category:compound, category:context_overflow, category:duplicate_flood, category:exact_term, category:general, category:identifier_near_miss, category:implicit_condition, category:injection, category:injection_evasive, category:off_topic_context, category:partial_answer, category:scanned, category:selective_filter, category:small_talk, category:stale_version, category:table, category:typo, pair:en->it, pair:en->zh, pair:it->en, pair:it->zh, pair:zh->en, pair:zh->it |
| RAG_LEXICAL_SEARCH | false | keep_incumbent | injection_attack_success | 0.0000 | 0.0000 | 0.0000 | 0.0200 | 1.0000 | 1.0000 | yes | 1.0000 | category:cache_near_miss, category:cache_paraphrase, category:colloquial, category:compound, category:context_overflow, category:duplicate_flood, category:exact_term, category:general, category:identifier_near_miss, category:implicit_condition, category:injection, category:injection_evasive, category:off_topic_context, category:partial_answer, category:scanned, category:selective_filter, category:small_talk, category:stale_version, category:table, category:typo, pair:en->it, pair:en->zh, pair:it->en, pair:it->zh, pair:zh->en, pair:zh->it |
| RAG_REFUSAL_THRESHOLD | false | keep_incumbent | injection_attack_success | 0.0000 | 0.0000 | 0.0000 | 0.0200 | 1.0000 | 1.0000 | yes | 1.0000 | category:cache_near_miss, category:cache_paraphrase, category:colloquial, category:compound, category:context_overflow, category:duplicate_flood, category:exact_term, category:general, category:identifier_near_miss, category:implicit_condition, category:injection, category:injection_evasive, category:off_topic_context, category:partial_answer, category:scanned, category:selective_filter, category:small_talk, category:stale_version, category:table, category:typo, pair:en->it, pair:en->zh, pair:it->en, pair:it->zh, pair:zh->en, pair:zh->it |
| RAG_CONTEXT_EDGE_ORDER | true | keep_incumbent | injection_attack_success | 0.0000 | 0.0000 | 0.0000 | 0.0200 | 1.0000 | 1.0000 | yes | 1.0000 | category:cache_near_miss, category:cache_paraphrase, category:colloquial, category:compound, category:context_overflow, category:duplicate_flood, category:exact_term, category:general, category:identifier_near_miss, category:implicit_condition, category:injection, category:injection_evasive, category:off_topic_context, category:partial_answer, category:scanned, category:selective_filter, category:small_talk, category:stale_version, category:table, category:typo, pair:en->it, pair:en->zh, pair:it->en, pair:it->zh, pair:zh->en, pair:zh->it |
| RAG_CONTEXT_COMPRESSION | true | keep_incumbent | injection_attack_success | 0.0000 | 0.0000 | 0.0000 | 0.0200 | 1.0000 | 1.0000 | yes | 1.0000 | category:cache_near_miss, category:cache_paraphrase, category:colloquial, category:compound, category:context_overflow, category:duplicate_flood, category:exact_term, category:general, category:identifier_near_miss, category:implicit_condition, category:injection, category:injection_evasive, category:off_topic_context, category:partial_answer, category:scanned, category:selective_filter, category:small_talk, category:stale_version, category:table, category:typo, pair:en->it, pair:en->zh, pair:it->en, pair:it->zh, pair:zh->en, pair:zh->it |
| RAG_PARENT_CHILD | true | keep_incumbent | injection_attack_success | 0.0000 | 0.0000 | 0.0000 | 0.0200 | 1.0000 | 1.0000 | yes | 1.0000 | category:cache_near_miss, category:cache_paraphrase, category:colloquial, category:compound, category:context_overflow, category:duplicate_flood, category:exact_term, category:general, category:identifier_near_miss, category:implicit_condition, category:injection, category:injection_evasive, category:off_topic_context, category:partial_answer, category:scanned, category:selective_filter, category:small_talk, category:stale_version, category:table, category:typo, pair:en->it, pair:en->zh, pair:it->en, pair:it->zh, pair:zh->en, pair:zh->it |
| RAG_HNSW_ITERATIVE_SCAN | relaxed_order | keep_incumbent | injection_attack_success | 0.0000 | 0.0000 | 0.0000 | 0.0200 | 1.0000 | 1.0000 | yes | 1.0000 | category:cache_near_miss, category:cache_paraphrase, category:colloquial, category:compound, category:context_overflow, category:duplicate_flood, category:exact_term, category:general, category:identifier_near_miss, category:implicit_condition, category:injection, category:injection_evasive, category:off_topic_context, category:partial_answer, category:scanned, category:selective_filter, category:small_talk, category:stale_version, category:table, category:typo, pair:en->it, pair:en->zh, pair:it->en, pair:it->zh, pair:zh->en, pair:zh->it |
| RAG_LEXICAL_TRANSLATION | true | keep_incumbent | injection_attack_success | 0.0093 | 0.0000 | 0.0280 | 0.0200 | 0.3626 | 1.0000 | yes | 1.0000 | category:cache_near_miss, category:cache_paraphrase, category:colloquial, category:compound, category:context_overflow, category:duplicate_flood, category:exact_term, category:general, category:identifier_near_miss, category:implicit_condition, category:injection, category:injection_evasive, category:off_topic_context, category:partial_answer, category:scanned, category:selective_filter, category:small_talk, category:stale_version, category:table, category:typo, pair:en->it, pair:en->zh, pair:it->en, pair:it->zh, pair:zh->en, pair:zh->it |
| RAG_QUERY_LAYER | true | keep_incumbent | injection_attack_success | -0.1579 | -0.3158 | 0.0000 | 0.0200 | 1.0000 | 1.0000 | yes | 1.0000 | category:cache_near_miss, category:cache_paraphrase, category:colloquial, category:compound, category:context_overflow, category:duplicate_flood, category:exact_term, category:general, category:identifier_near_miss, category:implicit_condition, category:injection, category:injection_evasive, category:off_topic_context, category:partial_answer, category:scanned, category:selective_filter, category:small_talk, category:stale_version, category:table, category:typo, pair:en->it, pair:en->zh, pair:it->en, pair:it->zh, pair:zh->en, pair:zh->it |
| RAG_QUERY_FRAMEWORK | langchain | keep_incumbent | injection_attack_success | 0.0000 | 0.0000 | 0.0000 | 0.0200 | 1.0000 | 1.0000 | yes | 1.0000 | category:cache_near_miss, category:cache_paraphrase, category:colloquial, category:compound, category:context_overflow, category:duplicate_flood, category:exact_term, category:general, category:identifier_near_miss, category:implicit_condition, category:injection, category:injection_evasive, category:off_topic_context, category:partial_answer, category:scanned, category:selective_filter, category:small_talk, category:stale_version, category:table, category:typo, pair:en->it, pair:en->zh, pair:it->en, pair:it->zh, pair:zh->en, pair:zh->it |
| RAG_QUERY_HYDE | true | keep_incumbent | injection_attack_success | 0.0000 | 0.0000 | 0.0000 | 0.0200 | 1.0000 | 1.0000 | yes | 1.0000 | category:cache_near_miss, category:cache_paraphrase, category:colloquial, category:compound, category:context_overflow, category:duplicate_flood, category:exact_term, category:general, category:identifier_near_miss, category:implicit_condition, category:injection, category:injection_evasive, category:off_topic_context, category:partial_answer, category:scanned, category:selective_filter, category:small_talk, category:stale_version, category:table, category:typo, pair:en->it, pair:en->zh, pair:it->en, pair:it->zh, pair:zh->en, pair:zh->it |
| RAG_CITATIONS | true | keep_incumbent | injection_attack_success | 0.0000 | 0.0000 | 0.0000 | 0.0200 | 1.0000 | 1.0000 | yes | 1.0000 | category:cache_near_miss, category:cache_paraphrase, category:colloquial, category:compound, category:context_overflow, category:duplicate_flood, category:exact_term, category:general, category:identifier_near_miss, category:implicit_condition, category:injection, category:injection_evasive, category:off_topic_context, category:partial_answer, category:scanned, category:selective_filter, category:small_talk, category:stale_version, category:table, category:typo, pair:en->it, pair:en->zh, pair:it->en, pair:it->zh, pair:zh->en, pair:zh->it |
| RAG_GROUNDEDNESS | true | keep_incumbent | injection_attack_success | 0.0000 | 0.0000 | 0.0000 | 0.0200 | 1.0000 | 1.0000 | yes | 1.0000 | category:cache_near_miss, category:cache_paraphrase, category:colloquial, category:compound, category:context_overflow, category:duplicate_flood, category:exact_term, category:general, category:identifier_near_miss, category:implicit_condition, category:injection, category:injection_evasive, category:off_topic_context, category:partial_answer, category:scanned, category:selective_filter, category:small_talk, category:stale_version, category:table, category:typo, pair:en->it, pair:en->zh, pair:it->en, pair:it->zh, pair:zh->en, pair:zh->it |
| RAG_CONTEXT_TAGGING | true | keep_incumbent | injection_attack_success | 0.0000 | 0.0000 | 0.0000 | 0.0200 | 1.0000 | 1.0000 | yes | 1.0000 | category:cache_near_miss, category:cache_paraphrase, category:colloquial, category:compound, category:context_overflow, category:duplicate_flood, category:exact_term, category:general, category:identifier_near_miss, category:implicit_condition, category:injection, category:injection_evasive, category:off_topic_context, category:partial_answer, category:scanned, category:selective_filter, category:small_talk, category:stale_version, category:table, category:typo, pair:en->it, pair:en->zh, pair:it->en, pair:it->zh, pair:zh->en, pair:zh->it |
| RAG_INJECTION_CHECK | drop | adopt | security_wins_ties | 0.0000 | 0.0000 | 0.0000 | 0.0200 | 1.0000 | 1.0000 | yes | 0.0000 | category:cache_near_miss, category:cache_paraphrase, category:colloquial, category:compound, category:context_overflow, category:duplicate_flood, category:exact_term, category:general, category:identifier_near_miss, category:implicit_condition, category:injection, category:injection_evasive, category:off_topic_context, category:partial_answer, category:scanned, category:selective_filter, category:small_talk, category:stale_version, category:table, category:typo, pair:en->it, pair:en->zh, pair:it->en, pair:it->zh, pair:zh->en, pair:zh->it |
| RAG_INGEST_PIPELINE | unified | keep_incumbent | injection_attack_success | 0.0000 | 0.0000 | 0.0000 | 0.0200 | 1.0000 | 1.0000 | yes | 1.0000 | category:cache_near_miss, category:cache_paraphrase, category:colloquial, category:compound, category:context_overflow, category:duplicate_flood, category:exact_term, category:general, category:identifier_near_miss, category:implicit_condition, category:injection, category:injection_evasive, category:off_topic_context, category:partial_answer, category:scanned, category:selective_filter, category:small_talk, category:stale_version, category:table, category:typo, pair:en->it, pair:en->zh, pair:it->en, pair:it->zh, pair:zh->en, pair:zh->it |
| RAG_EMBEDDING_PROFILES | on | keep_incumbent | injection_attack_success | 0.0000 | 0.0000 | 0.0000 | 0.0200 | 1.0000 | 1.0000 | yes | 1.0000 | category:cache_near_miss, category:cache_paraphrase, category:colloquial, category:compound, category:context_overflow, category:duplicate_flood, category:exact_term, category:general, category:identifier_near_miss, category:implicit_condition, category:injection, category:injection_evasive, category:off_topic_context, category:partial_answer, category:scanned, category:selective_filter, category:small_talk, category:stale_version, category:table, category:typo, pair:en->it, pair:en->zh, pair:it->en, pair:it->zh, pair:zh->en, pair:zh->it |

## Slices too small to gate

Reported, never deciding (fewer than 10 items): category:cache_near_miss, category:cache_paraphrase, category:colloquial, category:compound, category:context_overflow, category:duplicate_flood, category:exact_term, category:general, category:identifier_near_miss, category:implicit_condition, category:injection, category:injection_evasive, category:off_topic_context, category:partial_answer, category:scanned, category:selective_filter, category:small_talk, category:stale_version, category:table, category:typo, pair:en->it, pair:en->zh, pair:it->en, pair:it->zh, pair:zh->en, pair:zh->it

## Invalid backend runs

- b.qdrant.c1: backend_impl_fake
- b.qdrant.c2: backend_impl_fake
- b.weaviate.c1: backend_impl_fake
- b.weaviate.c2: backend_impl_fake

## Defaults

| variable | incumbent | default | reason |
| --- | --- | --- | --- |
| RAG_CITATIONS | false | false | ablation verdict keep_incumbent (injection_attack_success) |
| RAG_CONTEXT_COMPRESSION | false | false | ablation verdict keep_incumbent (injection_attack_success) |
| RAG_CONTEXT_EDGE_ORDER | false | false | ablation verdict keep_incumbent (injection_attack_success) |
| RAG_CONTEXT_TAGGING | false | false | ablation verdict keep_incumbent (injection_attack_success) |
| RAG_EMBEDDING_PROFILES | off | off | ablation verdict keep_incumbent (injection_attack_success) |
| RAG_GROUNDEDNESS | false | false | ablation verdict keep_incumbent (injection_attack_success) |
| RAG_HNSW_ITERATIVE_SCAN | off | off | ablation verdict keep_incumbent (injection_attack_success) |
| RAG_INGEST_PIPELINE | legacy | legacy | ablation verdict keep_incumbent (injection_attack_success) |
| RAG_INJECTION_CHECK | off | drop | ablation verdict adopt (security_wins_ties) |
| RAG_LEXICAL_SEARCH | true | true | ablation verdict keep_incumbent (injection_attack_success) |
| RAG_LEXICAL_TRANSLATION | false | false | ablation verdict keep_incumbent (injection_attack_success) |
| RAG_PARENT_CHILD | false | false | ablation verdict keep_incumbent (injection_attack_success) |
| RAG_PIPELINE | v2 | v2 | ablation verdict keep_incumbent (injection_attack_success) |
| RAG_QUERY_FRAMEWORK | llamaindex | llamaindex | ablation verdict keep_incumbent (injection_attack_success) |
| RAG_QUERY_HYDE | false | false | ablation verdict keep_incumbent (injection_attack_success) |
| RAG_QUERY_LAYER | false | false | ablation verdict keep_incumbent (injection_attack_success) |
| RAG_REFUSAL_FLOOR | legacy_rule | legacy_rule | follows the stage-B winner b.incumbent |
| RAG_REFUSAL_THRESHOLD | true | true | ablation verdict keep_incumbent (injection_attack_success) |
| RAG_RERANKER | auto | auto | follows the stage-B winner b.incumbent |

## Config hashes

| config | sha256 |
| --- | --- |
| ablate.rag_citations | `a321bd11e1808fbe7852328c28427a9c6eba25ffc78f84cbd2dcbc00f173f55d` |
| ablate.rag_context_compression | `601927b7436c238af3647ad40d16cf7448eb6a57a37bad9432236c5261f67bfd` |
| ablate.rag_context_edge_order | `192fb70cd20ef42faab2daded0f89de96645c9bbdb573609f9a94e7057484dd1` |
| ablate.rag_context_tagging | `c8719d5b50356f96f220acfcdbc006128149d1f61b11355244267336dc8ed87a` |
| ablate.rag_embedding_profiles | `b8dbca43ac3bd3a7cda7dd2f0bdfd230e423ad64cf8a4698dd8b07559c50c34a` |
| ablate.rag_groundedness | `c147958f5fbbf7f71756239b329e2c141e284f043f206295d594002790387e3f` |
| ablate.rag_hnsw_iterative_scan | `f0644575db27e35ac7fb547433beaeaa5eedc81bb387da9f37603bf311dd5b1b` |
| ablate.rag_ingest_pipeline | `322d492b0773cd22f837a3cf50bd6caa9abc8dbc0f66a5847a395fbfa5801ad5` |
| ablate.rag_injection_check | `9dbf90766578b7c1d3c98963eb8ed9c590a49f393e34561e3cc2337499ed57f9` |
| ablate.rag_lexical_search | `a3afec22ccbe563305b5ec0934fbb52f56bb449a89fb28093ff6eec4d255ad28` |
| ablate.rag_lexical_translation | `fb46156fd16e2767a0263f7a1f8f841d7ecc75d29902dcd0ad1d3bb695dcbca4` |
| ablate.rag_parent_child | `f6a3cfac4d77c9e9fd3a8765acc3d472a96f26ebadb5691c4a0aabaf99b2fd88` |
| ablate.rag_pipeline | `a093806260eb5ba7a26738f8a0f3a19be41c1e54243ca9e7b99374b7af06e586` |
| ablate.rag_query_framework | `392bbdf3038bcdab092312a7e3d6bfdacb36bda50602b2fad128c7657234ef01` |
| ablate.rag_query_hyde | `c3ea6274cb3450a927cf310a3d72ff579531f5b4a747b5306f7e979b0e0179b5` |
| ablate.rag_query_layer | `76a97b37ad9c604b3873d65f94843a558bcdfd89d7765fe23d775abfa75d9128` |
| ablate.rag_refusal_threshold | `7124394e4740904e54a71ec77224326160d9ac7be7cbb03924d0dfd9bf2cb098` |
| b.incumbent | `c88325c34066ea383cfa0864da57a7691d2fa15ca4f7ecee3c2f434f56287e33` |
| b.pgvector.c1 | `bbc1718f201b0935fe5728e0b7d172e186e049c1b56ab8e08b500148a196a5c9` |
| b.pgvector.c2 | `3899133c7e6588efafa86b6d520bbf86cc871e4f72bd30320b707f9d4b635abe` |
| b.qdrant.c1 | `d5299a8b5b496829b5962038abe0180259dd91dc58b59250d5a5338ebd20311f` |
| b.qdrant.c2 | `957557eeabae92d394828a0f62801f664ca2064641ba4a18a675fa31249113a7` |
| b.weaviate.c1 | `7073f8fb17ce90b6b33368a798995b5cfed2e2ea5596826867082aff004caa78` |
| b.weaviate.c2 | `cf727e244551a1f6c795b08a93562d37378ffc67b2646a5a076f3adf7e07952b` |
| confirm | `fa11c10e1078268e087e95db59acad02439b05212660b1e1a2680d00339be12d` |

## Test-split uses

| run | config | registered | reason | used at |
| --- | --- | --- | --- | --- |
| 6684e250ff5a-b.incumbent-1 | b.incumbent | yes | - | 2026-11-28T01:40:28Z |
| 6684e250ff5a-b.pgvector.c1-2 | b.pgvector.c1 | yes | - | 2026-11-28T01:41:14Z |
| 6684e250ff5a-b.weaviate.c1-3 | b.weaviate.c1 | yes | - | 2026-11-28T01:42:11Z |
| 6684e250ff5a-b.qdrant.c1-4 | b.qdrant.c1 | yes | - | 2026-11-28T01:43:10Z |
| 6684e250ff5a-b.pgvector.c2-5 | b.pgvector.c2 | yes | - | 2026-11-28T01:44:08Z |
| 6684e250ff5a-b.weaviate.c2-6 | b.weaviate.c2 | yes | - | 2026-11-28T01:48:18Z |
| 6684e250ff5a-b.weaviate.c2-7 | b.weaviate.c2 | yes | - | 2026-11-28T01:50:28Z |
| 6684e250ff5a-b.qdrant.c2-8 | b.qdrant.c2 | yes | - | 2026-11-28T01:54:55Z |
| 6684e250ff5a-ablate.rag_pipeline-9 | ablate.rag_pipeline | yes | - | 2026-11-28T01:59:14Z |
| 6684e250ff5a-ablate.rag_lexical_search-10 | ablate.rag_lexical_search | yes | - | 2026-11-28T01:59:58Z |
| 6684e250ff5a-ablate.rag_refusal_threshold-11 | ablate.rag_refusal_threshold | yes | - | 2026-11-28T02:00:45Z |
| 6684e250ff5a-ablate.rag_context_edge_order-12 | ablate.rag_context_edge_order | yes | - | 2026-11-28T02:01:35Z |
| 6684e250ff5a-ablate.rag_context_compression-13 | ablate.rag_context_compression | yes | - | 2026-11-28T02:02:26Z |
| 6684e250ff5a-ablate.rag_parent_child-14 | ablate.rag_parent_child | yes | - | 2026-11-28T02:03:12Z |
| 6684e250ff5a-ablate.rag_hnsw_iterative_scan-15 | ablate.rag_hnsw_iterative_scan | yes | - | 2026-11-28T02:03:59Z |
| 6684e250ff5a-ablate.rag_lexical_translation-16 | ablate.rag_lexical_translation | yes | - | 2026-11-28T02:04:45Z |
| 6684e250ff5a-ablate.rag_query_layer-17 | ablate.rag_query_layer | yes | - | 2026-11-28T02:05:33Z |
| 6684e250ff5a-ablate.rag_query_framework-18 | ablate.rag_query_framework | yes | - | 2026-11-28T02:06:20Z |
| 6684e250ff5a-ablate.rag_query_hyde-19 | ablate.rag_query_hyde | yes | - | 2026-11-28T02:07:07Z |
| 6684e250ff5a-ablate.rag_citations-20 | ablate.rag_citations | yes | - | 2026-11-28T02:07:54Z |
| 6684e250ff5a-ablate.rag_groundedness-21 | ablate.rag_groundedness | yes | - | 2026-11-28T02:08:41Z |
| 6684e250ff5a-ablate.rag_context_tagging-22 | ablate.rag_context_tagging | yes | - | 2026-11-28T02:09:29Z |
| 6684e250ff5a-ablate.rag_injection_check-23 | ablate.rag_injection_check | yes | - | 2026-11-28T02:10:16Z |
| 6684e250ff5a-ablate.rag_ingest_pipeline-24 | ablate.rag_ingest_pipeline | yes | - | 2026-11-28T02:11:03Z |
| 6684e250ff5a-ablate.rag_embedding_profiles-25 | ablate.rag_embedding_profiles | yes | - | 2026-11-28T02:11:50Z |
| 6684e250ff5a-confirm-26 | confirm | yes | - | 2026-11-28T02:12:39Z |
