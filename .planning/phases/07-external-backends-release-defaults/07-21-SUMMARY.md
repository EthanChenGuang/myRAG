---
phase: 07-external-backends-release-defaults
plan: 21
subsystem: infra
tags: [vendor-inventory, data-flow, check-config, ci, adm-04]

requires:
  - phase: 07-external-backends-release-defaults
    provides: "VendorDataFlow contract and JSON Schema (07-17), provider metadata on managed url and secret entries (07-18), pr-smoke ts job (07-16)"
provides:
  - "config/rag/vendor-data-flow.json: the D-20 inventory of 16 vendors (the 15 named in D-20 plus the operator fine-tune endpoint)"
  - "scripts/rag/gen-vendor-doc.mjs: validator (JSON Schema subset plus the model rules), deterministic Markdown renderer, --check mode"
  - "docs/vendor-data-flow.md: the generated document"
  - "check-config rule: a managed url or secret provider without an inventory entry is a violation"
  - "pr-smoke ts job: runs gen-vendor-doc --check and its self-tests"
affects: [07-27, 07-33, adm-04, README_RAG_PIPELINE]

actuals:
  tokens: 9960
  tasks: 2
  commits: 6

tech-stack:
  added: []
  patterns:
    - "Hand-edited config validated in plain node against the exported JSON Schema (no tsx), with the Pydantic model validators mirrored in JS"

key-files:
  created:
    - config/rag/vendor-data-flow.json
    - scripts/rag/gen-vendor-doc.mjs
    - docs/vendor-data-flow.md
    - scripts/tests/gen-vendor-doc.node-test.mjs
  modified:
    - scripts/check-config.mjs
    - scripts/check-config.test.mjs
    - .github/workflows/pr-smoke.yml
    - rag-sidecar/src/rag_sidecar/contracts/release.py
    - rag-sidecar/tests/test_release_contracts.py

key-decisions:
  - "VendorDataFlow no longer rejects one host under two vendors (release.py, model validator only; JSON Schema and Zod unchanged, gen:schemas leaves no diff). The eval judge reaches openrouter.ai and api.openai.com, which the openrouter and openai entries also list; hosts stay unique within an entry"
  - "In-deployment providers exempt from the check-config rule: app (signing secrets that never leave the deployment), sidecar (the deployment's own service), webhook (the monitor alert webhook sends metrics, counts and ids, none of the seven content kinds). Constant IN_DEPLOYMENT_PROVIDERS in scripts/check-config.mjs"
  - "ft_endpoint gets an inventory entry (query and chunk_text go to an operator-chosen host); its host is the placeholder ft-endpoint.operator.invalid (RFC 2606 .invalid) because the host is set by RAG_FT_SLOT_A/B_BASE_URL"
  - "Weaviate and Qdrant list their managed-cloud domains (weaviate.cloud, cloud.qdrant.io); cluster hosts are subdomains taken from WEAVIATE_URL / QDRANT_URL, and a self-hosted cluster is the operator's own host"
  - "prompt_guard: the contract needs at least one content kind and has no 'none'. Listed as chunk_text (what the local scorer reads); the entry name says that nothing is uploaded and scoring runs in the sidecar. Prompt Guard is not configured (05.1-18 and 05.1-25 skipped)"
  - "Vendors with no single enabling variable (exa: per-request webSearch toggle; openrouter: core generation; judge: operator-run eval harness) have switch null, shown as '-'"
  - "opt_in false for openrouter, openai (embeddings via RAG_OPENAI_EMBEDDINGS_VIA=openai by default) and llamacloud (RAG_PARSER_ALLOW_CLOUD=true by default); every other vendor is opt-in"
  - "multi_tenant requires_ack for vectara (RAG_GROUNDEDNESS_VECTARA_MULTI_TENANT_ACK) and lakera (RAG_INJECTION_LAKERA_MULTI_TENANT_ACK); allowed elsewhere. Retention and training are to_verify for every vendor"
  - "A missing inventory file reports each non-exempt provider; invalid JSON is its own violation. The check-config tests copy the inventory into the real-tree fixture"

patterns-established:
  - "New managed url or secret variable: give it a provider id and an inventory entry (vendor id or providers list), then run node scripts/rag/gen-vendor-doc.mjs"

requirements-completed: [ADM-04]

coverage:
  - id: D1
    description: "Validated vendor data-flow inventory with every D-20 vendor and host; Weaviate and Qdrant list vectors and lexical_text"
    requirement: ADM-04
    verification:
      - kind: unit
        ref: "scripts/tests/gen-vendor-doc.node-test.mjs#the committed inventory names every D-20 vendor, each with at least one host"
        status: pass
      - kind: unit
        ref: "rag-sidecar/tests/test_release_contracts.py::TestVendorDataFlow::test_committed_inventory_validates"
        status: pass
  - id: D2
    description: "Generated docs/vendor-data-flow.md; --check fails on a stale doc, invalid entries exit 2"
    requirement: ADM-04
    verification:
      - kind: unit
        ref: "scripts/tests/gen-vendor-doc.node-test.mjs"
        status: pass
  - id: D3
    description: "check-config fails for a managed url or secret provider without an inventory entry; pr-smoke runs the generator check"
    requirement: ADM-04
    verification:
      - kind: unit
        ref: "scripts/check-config.test.mjs#vendor inventory: a managed secret whose provider has no inventory entry is reported (D-20)"
        status: pass
      - kind: other
        ref: "uv run --all-extras --frozen --directory eval python ../scripts/ci/check-workflows.py"
        status: pass

duration: 1 session
completed: 2026-11-27
---

# Phase 7 Plan 21: Vendor data-flow inventory Summary

The inventory of which content reaches which external host is now data. It is validated and rendered into a generated document, and CI enforces it: no managed provider key or URL can exist without an inventory entry.

## Precondition

- Every plan in depends_on, including transitive ones (333 plans), has a SUMMARY on this branch.
- 05-VERIFICATION.md, 05.1-VERIFICATION.md and 06-VERIFICATION.md are all `status: human_needed`.

## Tasks

| Task | Commits |
| --- | --- |
| 1 Inventory, generator, document | `124f4c5d` test (RED: 14 failing assertions on a stub inventory and a stub generator), `a1310853` test (RED: a shared host and the committed inventory fail VendorDataFlow), `6458a7a9` feat |
| 2 check-config rule and CI step | `5b78b84f` test (RED: 3 of 6 new cases failed, the pass-by-design cases passed), `080a5c76` feat |

## Inventory content (from the call sites)

| Vendor | Hosts | Content | Switch |
| --- | --- | --- | --- |
| anthropic | api.anthropic.com | query, chunk_text, answer | RAG_CLAUDE_CITATIONS |
| cohere | api.cohere.com | query, chunk_text | RAG_RERANKER |
| deepinfra | api.deepinfra.com | query, chunk_text | RAG_BGE_M3_SERVING |
| exa | api.exa.ai | query | - |
| ft_endpoint | ft-endpoint.operator.invalid | query, chunk_text | RAG_FINETUNE |
| judge | openrouter.ai, api.openai.com | query, chunk_text, answer | - |
| lakera | api.lakera.ai | chunk_text | RAG_INJECTION_LAKERA (ack) |
| langfuse | cloud.langfuse.com | traces | LANGFUSE_ENABLED |
| llamacloud | api.cloud.llamaindex.ai | file_bytes | RAG_PARSER_ALLOW_CLOUD |
| openai | api.openai.com | query, chunk_text, file_bytes | RAG_OPENAI_EMBEDDINGS_VIA |
| openrouter | openrouter.ai | query, chunk_text, answer | - |
| prompt_guard | huggingface.co | chunk_text (see decisions) | RAG_INJECTION_PROMPT_GUARD |
| qdrant | cloud.qdrant.io | vectors, lexical_text | RAG_RETRIEVAL_BACKEND |
| vectara | api.vectara.io | chunk_text, answer | RAG_GROUNDEDNESS_VECTARA_OPT_IN (ack) |
| voyage | api.voyageai.com | query, chunk_text | RAG_RERANKER |
| weaviate | weaviate.cloud | vectors, lexical_text | RAG_RETRIEVAL_BACKEND |

## Behaviour changes

- `node scripts/check-config.mjs` now fails when a managed `url` or `secret` entry names a provider with no inventory entry (`<NAME> [manifest] provider <id> has no vendor data-flow entry in config/rag/vendor-data-flow.json`). On the real tree it passes. Removing the cohere entry gives exactly the two COHERE_* violations (mutation check).
- `VendorDataFlow` (Pydantic) accepts a host listed under two vendors. Runtime behaviour is unchanged: no switch is added and no product code changes.

## Deviations

- **[Rule 3 - blocking] Contract relaxation outside files_modified.** `rag-sidecar/src/rag_sidecar/contracts/release.py` dropped the cross-vendor host uniqueness check, and `rag-sidecar/tests/test_release_contracts.py` gained two tests. D-20 requires the judge entry, and the judge reaches hosts that the openrouter and openai entries already list, so the inventory could not validate. Generated schemas and Zod are unchanged (`npm run gen:schemas` leaves no diff), so there is no overlap with 07-40's generated files.
- The inventory has 16 entries, one more than D-20 names: ft_endpoint is included because check-config would otherwise fail on RAG_FT_* providers.

## Gates run

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npx vitest run`: no TS module changed and no vitest file imports a changed module, so no vitest target applies
- `node scripts/ci/check-rag-boundary.mjs`, `node scripts/check-config.mjs`, `node scripts/ci/check-language-literals.mjs`, `node scripts/ci/check-settings-classification.mjs`: pass
- `node --test scripts/check-config.test.mjs scripts/tests/gen-vendor-doc.node-test.mjs`: 99 pass
- `node scripts/rag/gen-vendor-doc.mjs --check`: pass
- `uv run --all-extras --frozen --directory eval python ../scripts/ci/check-workflows.py`: OK
- rag-sidecar pytest: `tests/test_release_contracts.py` (42), `tests/test_contract_export.py tests/test_contract_models.py` (80): pass
- `npm run gen:schemas`: no diff
- Not applicable: rag-db (no SQL), test-rag (no retrieval, ingest or generation change), UI design check (no UI)

## Operator actions

- Live check: confirm the retention and training terms per vendor and replace `to_verify` (all 16 entries). Confirm the Weaviate/Qdrant cluster hosts and the Lakera region host of the deployment.
- README_RAG_PIPELINE.md (07-27) links docs/vendor-data-flow.md (D-20).

## Deferred

- A `none` content kind in VendorDataFlow, so download-only hosts such as prompt_guard (huggingface.co) do not need a placeholder kind. This is a contract change with schema and Zod regeneration, so it belongs to a later contracts plan.
