# Phase 3.3 coordinator summary (plan 03.3-25, 2026-11-27)

Branch exec/03.3-25. Every hand-off file of the phase, with topic, owner and status.

| File | Topic | Owner | Status |
|---|---|---|---|
| 03.3-02-lexical-version-bit.md | D-33 lexical version bit: +4 for quantity, versions 6 to 9 (`lexicalVersionFor`) | coordinator with Phase 4.2 | open: confirm no 4.2 plan gives 6 to 9 another meaning |
| 03.3-02-settings-classification.md | classification of the six switches (D-03) | coordinator | closed: classified as recorded; reopen only on owner request |
| 03.3-02-ui-stored-line.md | Config UI help line naming `rag:attributes` | coordinator (UI follow-up) | open: `rag:attributes` is in package.json, the span is not yet in scripts/config-ui/index.html |
| 03.3-09-unit-lists.md | two unit lists (registry `quantity` block and the terminology aliases, D-32) | coordinator | open: keep both in step until one is chosen |
| 03.3-10-impact-dry-run-marker.md | impact marker for `RAG_SECTION_RULES=on` | coordinator (contracts) | open |
| 03.3-16-indexer-signatures.md | indexer signatures for the identifier feed | record only | closed |
| 03.3-17-operations.md | header rewrite sites, in-step rule, stale listing, rechunk classification | record only; AGENTS.md section 6 carries the operator rules | closed |
| 03.3-18-explicit-filter-routes.md | route-level 400 for an explicit `attributes` filter | coordinator, owners of src/lib/rag/index.ts | open |
| 03.3-19-exact-id-leg.md | exact-id leg stands down under a hard attribute filter (pitfall 7) | coordinator | open (documented behaviour) |
| 03.3-20-upstream.md | baseline ownership: ingest baseline re-recorded once by 03.3-20 (63c89813) | coordinator | closed: not re-recorded by 03.3-25 |
| 03.3-21-agents-line.md | AGENTS.md line for TPL-07 | 03.3-25 | closed: in AGENTS.md section 6 |
| 03.3-21-upstream-signatures.md | resolver and refusal signatures | record only | closed |
| 03.3-23-fragment-cap.md | declared fragment longer than the shipped fragment cap (en, it variant files) | coordinator; plan 03.3-26 (real residue) | open |
| 03.3-23-gates.md | v2 ingest refusal floor read every templated gate as 0 | 03.3-25 | closed: ingest fixture floor 0.1599 (eval/config/fixture-score-calibration.ingest.json) |
| 03.3-24-phase43-access.md | Phase 3.3 resolver reads need `p_access_keys` / `p_access_all` | Phase 4.3 | open: 4.3 not on trunk; 1019 unused, 1010 spare |
| 03.3-24-phase63-purge.md | `rag_purge_hook_doc_attributes` (1009) for the purge inventory | Phase 6.3 (06.3-19) | open |
| 03.3-24-tenant-delete.md | `rag_tenant_rule_data_delete` (1009), nothing calls it yet | coordinator (tenant offboarding) | open |
| 03.3-25-requirement-TPL-01.md | variant gate | 03.3-25 | resolved: 1.000 (heading-line section paths) |
| 03.3-25-requirement-TPL-03.md | named_document gate | 03.3-25 | resolved: recall 1.000, wrong@1 0.000, cited 1.000 |
| 03.3-25-requirement-TPL-06.md | named_document gate | 03.3-25 | resolved (as TPL-03) |
| 03.3-25-requirement-TPL-07.md | quantity gate | 03.3-25 | resolved: 1.000 (quantity companion tokens) |
| 03.3-25-requirement-TPL-09.md | no_other_slice_drop fails on 1 of 11 cache_near_miss items (attribute header, D-26) | plan 03.3-26 | open: decision (b), must-check on real items; reopen D-26 if the real run drops beyond the band |

## Gate note

eval/reports/phase-03.3/gates.json: off_identity, boilerplate_share, named_document, variant and quantity pass. no_other_slice_drop is
FAIL in fixture mode (it-cache-near-miss-005, fused rank 5 to 6, RRF 0.02914 vs 0.02921). Orchestrator decision (b): D-26 unchanged,
gates and band unchanged, must-check in plan 03.3-26.

## D-33 version values

Lexical version 2 with every switch off; +1 dictionary, +2 Italian stemming, +4 quantity (6 to 9 with `RAG_LEXICAL_QUANTITY` on).
Plan 03.3-25 changed the quantity token output (companion number and unit tokens) inside versions 6 to 9; no stored row of a live
deployment carries those versions yet (the switch is off by default). An operator who has run `rag:relex` with the switch on runs it again.

## Operator order

Migrations 1001 to 1009 in number order, after the 08xx and 09xx blocks; all common files (no mode-specific variant). Then, per switch:
`rag:rules` / `rag:attributes` imports (report first), `rag:rechunk` or `rag:rebuild` for rule, cleaning or header changes,
`rag:relex` and `python -m rag_eval.calibrate refusal` for `RAG_LEXICAL_QUANTITY`.
