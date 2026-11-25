# Chunking sweep

Source: fixture; config hash 8f367e07f7c7d6ba917e1db4bf01200cb8b42a516f94d58d295a0ed0f3a39285

- Fixture run: the numbers prove the mechanism (seeded profiles, dual-write, override, gate); the live sweep decides real profiles.
- Scope: dev split only; the test split is never read (D-14). Mode: ingest fixture, compared with the legacy profile built in the same mode (D-21).
- Question kind 'clause' is the clause-tagged subset of context_heavy, reported on its own.
- Recall@k uses k=10. Gate: paired differences against legacy on the overall and language slices, band 0.0200. All runs use the base env plus RAG_PARENT_CHILD=true.
- p256-1024 validator warnings: top_k_parent_over_budget (top-k 8 x parent 1024 = 8192 vs context budget 6000).
- p256-2048 validator warnings: top_k_parent_over_budget (top-k 8 x parent 2048 = 16384 vs context budget 6000).
- Judge answer correctness skipped: judge key not configured (OPENROUTER_API_KEY, OPENAI_API_KEY not set).

## Gate against legacy

| Profile | Gate | Regressions |
| --- | --- | --- |
| legacy | baseline | - |
| p128-512 | failed | language:en correct_refusal_rate -0.1250 (band 0.0200); language:zh correct_refusal_rate -0.1429 (band 0.0200); overall correct_refusal_rate -0.0952 (band 0.0200) |
| p256-1024 | failed | language:en correct_refusal_rate -0.1250 (band 0.0200); language:zh correct_refusal_rate -0.1429 (band 0.0200); overall correct_refusal_rate -0.0952 (band 0.0200) |
| p256-2048 | failed | language:en correct_refusal_rate -0.1250 (band 0.0200); language:zh correct_refusal_rate -0.1429 (band 0.0200); overall correct_refusal_rate -0.0952 (band 0.0200) |

## Overall

| Profile | Slice | Recall@k | MRR | Correct refusal (upper) | False refusal (upper) | Judge | Context tokens | Latency p50 / p95 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| legacy | overall | 0.677 n=96 | 0.576 n=96 | 0.286 (<= 0.487) n=21 | 0.208 (<= 0.288) n=96 | skipped | 695.7 n=117 | 104.0 / 143.0 |
| p128-512 | overall | 0.729 n=96 | 0.637 n=96 | 0.190 (<= 0.384) n=21 | 0.156 (<= 0.230) n=96 | skipped | 787.0 n=117 | 82.0 / 110.0 |
| p256-1024 | overall | 0.729 n=96 | 0.627 n=96 | 0.190 (<= 0.384) n=21 | 0.156 (<= 0.230) n=96 | skipped | 789.1 n=117 | 98.0 / 136.0 |
| p256-2048 | overall | 0.729 n=96 | 0.627 n=96 | 0.190 (<= 0.384) n=21 | 0.156 (<= 0.230) n=96 | skipped | 809.7 n=117 | 97.0 / 125.0 |

## By document type

| Profile | Slice | Recall@k | MRR | Correct refusal (upper) | False refusal (upper) | Judge | Context tokens | Latency p50 / p95 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| legacy | contract_legal | 1.000 n=2 | 1.000 n=2 | - | 0.000 (<= 0.776) n=2 | skipped | 857.5 n=2 | 102.0 / 104.0 |
| p128-512 | contract_legal | 1.000 n=2 | 1.000 n=2 | - | 0.000 (<= 0.776) n=2 | skipped | 812.0 n=2 | 102.0 / 123.0 |
| p256-1024 | contract_legal | 1.000 n=2 | 1.000 n=2 | - | 0.000 (<= 0.776) n=2 | skipped | 857.5 n=2 | 101.0 / 111.0 |
| p256-2048 | contract_legal | 1.000 n=2 | 1.000 n=2 | - | 0.000 (<= 0.776) n=2 | skipped | 857.5 n=2 | 91.0 / 101.0 |
| legacy | financial_report | 1.000 n=1 | 1.000 n=1 | - | 0.000 (<= 0.950) n=1 | skipped | 1583.0 n=1 | 128.0 / 128.0 |
| p128-512 | financial_report | 1.000 n=1 | 1.000 n=1 | - | 0.000 (<= 0.950) n=1 | skipped | 1613.0 n=1 | 63.0 / 63.0 |
| p256-1024 | financial_report | 1.000 n=1 | 1.000 n=1 | - | 0.000 (<= 0.950) n=1 | skipped | 1546.0 n=1 | 89.0 / 89.0 |
| p256-2048 | financial_report | 1.000 n=1 | 1.000 n=1 | - | 0.000 (<= 0.950) n=1 | skipped | 1982.0 n=1 | 97.0 / 97.0 |
| legacy | general | 0.686 n=86 | 0.579 n=86 | 0.286 (<= 0.487) n=21 | 0.221 (<= 0.307) n=86 | skipped | 683.4 n=107 | 104.0 / 140.0 |
| p128-512 | general | 0.733 n=86 | 0.629 n=86 | 0.190 (<= 0.384) n=21 | 0.174 (<= 0.256) n=86 | skipped | 770.3 n=107 | 83.0 / 105.0 |
| p256-1024 | general | 0.733 n=86 | 0.618 n=86 | 0.190 (<= 0.384) n=21 | 0.174 (<= 0.256) n=86 | skipped | 768.0 n=107 | 98.0 / 136.0 |
| p256-2048 | general | 0.733 n=86 | 0.618 n=86 | 0.190 (<= 0.384) n=21 | 0.174 (<= 0.256) n=86 | skipped | 793.9 n=107 | 97.0 / 125.0 |
| legacy | invoice_receipt | 0.667 n=3 | 0.500 n=3 | - | 0.333 (<= 0.865) n=3 | skipped | 575.7 n=3 | 126.0 / 143.0 |
| p128-512 | invoice_receipt | 1.000 n=3 | 1.000 n=3 | - | 0.000 (<= 0.632) n=3 | skipped | 1158.0 n=3 | 77.0 / 79.0 |
| p256-1024 | invoice_receipt | 1.000 n=3 | 1.000 n=3 | - | 0.000 (<= 0.632) n=3 | skipped | 1370.7 n=3 | 101.0 / 113.0 |
| p256-2048 | invoice_receipt | 1.000 n=3 | 1.000 n=3 | - | 0.000 (<= 0.632) n=3 | skipped | 1100.7 n=3 | 109.0 / 112.0 |
| legacy | product_technical | 1.000 n=1 | 1.000 n=1 | - | 0.000 (<= 0.950) n=1 | skipped | 605.0 n=1 | 110.0 / 110.0 |
| p128-512 | product_technical | 1.000 n=1 | 1.000 n=1 | - | 0.000 (<= 0.950) n=1 | skipped | 581.0 n=1 | 74.0 / 74.0 |
| p256-1024 | product_technical | 1.000 n=1 | 1.000 n=1 | - | 0.000 (<= 0.950) n=1 | skipped | 470.0 n=1 | 115.0 / 115.0 |
| p256-2048 | product_technical | 1.000 n=1 | 1.000 n=1 | - | 0.000 (<= 0.950) n=1 | skipped | 470.0 n=1 | 88.0 / 88.0 |
| legacy | scanned_image | 0.000 n=3 | 0.000 n=3 | - | 0.000 (<= 0.632) n=3 | skipped | 881.3 n=3 | 104.0 / 107.0 |
| p128-512 | scanned_image | 0.000 n=3 | 0.000 n=3 | - | 0.000 (<= 0.632) n=3 | skipped | 788.3 n=3 | 75.0 / 78.0 |
| p256-1024 | scanned_image | 0.000 n=3 | 0.000 n=3 | - | 0.000 (<= 0.632) n=3 | skipped | 771.0 n=3 | 100.0 / 102.0 |
| p256-2048 | scanned_image | 0.000 n=3 | 0.000 n=3 | - | 0.000 (<= 0.632) n=3 | skipped | 771.0 n=3 | 103.0 / 104.0 |

## By language

| Profile | Slice | Recall@k | MRR | Correct refusal (upper) | False refusal (upper) | Judge | Context tokens | Latency p50 / p95 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| legacy | en | 0.676 n=34 | 0.539 n=34 | 0.250 (<= 0.600) n=8 | 0.206 (<= 0.352) n=34 | skipped | 569.9 n=42 | 105.0 / 138.0 |
| p128-512 | en | 0.676 n=34 | 0.576 n=34 | 0.125 (<= 0.471) n=8 | 0.206 (<= 0.352) n=34 | skipped | 651.2 n=42 | 79.0 / 116.0 |
| p256-1024 | en | 0.676 n=34 | 0.548 n=34 | 0.125 (<= 0.471) n=8 | 0.206 (<= 0.352) n=34 | skipped | 629.2 n=42 | 103.0 / 140.0 |
| p256-2048 | en | 0.676 n=34 | 0.548 n=34 | 0.125 (<= 0.471) n=8 | 0.206 (<= 0.352) n=34 | skipped | 629.2 n=42 | 99.0 / 125.0 |
| legacy | it | 0.643 n=28 | 0.516 n=28 | 0.333 (<= 0.729) n=6 | 0.214 (<= 0.380) n=28 | skipped | 688.6 n=34 | 101.0 / 135.0 |
| p128-512 | it | 0.750 n=28 | 0.614 n=28 | 0.333 (<= 0.729) n=6 | 0.107 (<= 0.254) n=28 | skipped | 788.0 n=34 | 83.0 / 103.0 |
| p256-1024 | it | 0.750 n=28 | 0.614 n=28 | 0.333 (<= 0.729) n=6 | 0.107 (<= 0.254) n=28 | skipped | 802.2 n=34 | 98.0 / 129.0 |
| p256-2048 | it | 0.750 n=28 | 0.614 n=28 | 0.333 (<= 0.729) n=6 | 0.107 (<= 0.254) n=28 | skipped | 844.5 n=34 | 98.0 / 123.0 |
| legacy | zh | 0.706 n=34 | 0.662 n=34 | 0.286 (<= 0.659) n=7 | 0.206 (<= 0.352) n=34 | skipped | 830.5 n=41 | 105.0 / 147.0 |
| p128-512 | zh | 0.765 n=34 | 0.716 n=34 | 0.143 (<= 0.521) n=7 | 0.147 (<= 0.285) n=34 | skipped | 925.2 n=41 | 77.0 / 110.0 |
| p256-1024 | zh | 0.765 n=34 | 0.716 n=34 | 0.143 (<= 0.521) n=7 | 0.147 (<= 0.285) n=34 | skipped | 942.1 n=41 | 94.0 / 111.0 |
| p256-2048 | zh | 0.765 n=34 | 0.716 n=34 | 0.143 (<= 0.521) n=7 | 0.147 (<= 0.285) n=34 | skipped | 965.7 n=41 | 96.0 / 119.0 |

## By question kind

| Profile | Slice | Recall@k | MRR | Correct refusal (upper) | False refusal (upper) | Judge | Context tokens | Latency p50 / p95 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| legacy | clause | 1.000 n=2 | 1.000 n=2 | - | 0.000 (<= 0.776) n=2 | skipped | 857.5 n=2 | 102.0 / 104.0 |
| p128-512 | clause | 1.000 n=2 | 1.000 n=2 | - | 0.000 (<= 0.776) n=2 | skipped | 812.0 n=2 | 102.0 / 123.0 |
| p256-1024 | clause | 1.000 n=2 | 1.000 n=2 | - | 0.000 (<= 0.776) n=2 | skipped | 857.5 n=2 | 101.0 / 111.0 |
| p256-2048 | clause | 1.000 n=2 | 1.000 n=2 | - | 0.000 (<= 0.776) n=2 | skipped | 857.5 n=2 | 91.0 / 101.0 |
| legacy | context_heavy | 0.933 n=15 | 0.749 n=15 | - | 0.067 (<= 0.279) n=15 | skipped | 831.2 n=15 | 104.0 / 147.0 |
| p128-512 | context_heavy | 0.933 n=15 | 0.782 n=15 | - | 0.067 (<= 0.279) n=15 | skipped | 876.5 n=15 | 83.0 / 123.0 |
| p256-1024 | context_heavy | 0.933 n=15 | 0.738 n=15 | - | 0.067 (<= 0.279) n=15 | skipped | 873.3 n=15 | 98.0 / 136.0 |
| p256-2048 | context_heavy | 0.933 n=15 | 0.738 n=15 | - | 0.067 (<= 0.279) n=15 | skipped | 879.7 n=15 | 95.0 / 138.0 |
| legacy | fact_lookup | 0.971 n=35 | 0.890 n=35 | - | 0.029 (<= 0.129) n=35 | skipped | 969.7 n=35 | 107.0 / 140.0 |
| p128-512 | fact_lookup | 1.000 n=35 | 0.931 n=35 | - | 0.000 (<= 0.082) n=35 | skipped | 1041.3 n=35 | 83.0 / 111.0 |
| p256-1024 | fact_lookup | 1.000 n=35 | 0.922 n=35 | - | 0.000 (<= 0.082) n=35 | skipped | 1069.2 n=35 | 103.0 / 132.0 |
| p256-2048 | fact_lookup | 1.000 n=35 | 0.922 n=35 | - | 0.000 (<= 0.082) n=35 | skipped | 1061.2 n=35 | 101.0 / 118.0 |
| legacy | other | 0.370 n=46 | 0.280 n=46 | 0.286 (<= 0.487) n=21 | 0.391 (<= 0.523) n=46 | skipped | 522.2 n=67 | 101.0 / 147.0 |
| p128-512 | other | 0.457 n=46 | 0.365 n=46 | 0.190 (<= 0.384) n=21 | 0.304 (<= 0.434) n=46 | skipped | 634.1 n=67 | 79.0 / 103.0 |
| p256-1024 | other | 0.457 n=46 | 0.365 n=46 | 0.190 (<= 0.384) n=21 | 0.304 (<= 0.434) n=46 | skipped | 624.0 n=67 | 97.0 / 140.0 |
| p256-2048 | other | 0.457 n=46 | 0.365 n=46 | 0.190 (<= 0.384) n=21 | 0.304 (<= 0.434) n=46 | skipped | 662.6 n=67 | 94.0 / 135.0 |
