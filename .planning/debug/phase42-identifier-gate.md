---
status: resolved
trigger: "Phase 4.2 identifier gate (D-32) fails: identifier extraction finds no asked identifier in 8/12 gated queries; near_miss_dropped 0; filter on drops cross_lingual/table/language:it recall."
created: 2026-11-27
updated: 2026-11-27
---

## Symptoms
- expected: identifier gate passes (precision 1.0 and leakage 0.0 on all 12 gated items, no slice drop vs v2-default).
- actual: precision/leakage measured on 4 of 12 items; cross_lingual, table and language:it drop beyond the noise band.
- repro: `uv run --directory eval python -m rag_eval.phase42_gate --spec eval/config/phase42-gates.json --out <dir> --only identifier` (about 2 minutes, reproduced locally).

## Evidence
- Query-side extraction finds the asked identifier in 9 of the 12 gated questions; `asked: 0` only on the three `tenant_pattern` items (`qj.Xuv.qor`, `wx.Yem.git`, `kz.Owa.fud`). The other `asked: 0` traces in the hand-off are the 141 descriptive (non-identifier) items.
- "Measured on 4 of 12" comes from `_identifier_fields` returning nothing when any kept chunk lacks `identifiers_norm`. No producer fills `kept[].identifiers_norm` in the eval route, so only the 4 refused items (no kept chunks) were measured.
- `near_miss_dropped` 0 is expected: the search legs are already filtered to chunks carrying the found identifier, so no look-alike reaches the guard.
- en-identifier-near-miss-001 and it-table-002: the filtered pool holds only chunks with the asked identifier at dense similarity 0.21 to 0.23; the legacy_rule floor's pool is then empty and strict mode refuses (en-001 refuses in the reference too).
- en-table-002: local_bm25 scores 0 for all three filtered candidates. Its pool-relative IDF is negative for terms in every pool document, and under the filter the identifier tokens are in every document by construction, so the one discriminating term is cancelled.
- xl-it-zh-01 (cross_lingual): the question asks GV-MS-2024-0057; the scanned fixture holds GV-MS-2O24-0057 (OCR letter O). The resolve marks it missing and strict mode refuses with identifier_not_found.

## Resolution
- root_cause: (1) eval trace never carried kept-chunk identifiers; (2) tenant patterns matched the question literally, so case/separator variants (equal under D-31) were not asked; (3) the similarity floors ignored the exact identifier evidence of a filtered search; (4) the pool-statistics reranker received constant identifier tokens; (5) OCR digit look-alikes made an existing identifier look absent.
- fix: see PR body (fix/phase42-identifier-gate).
- verification: identifier gate PASS (precision 1.0 n=12, leakage 0.0 n=12, no offenders).
