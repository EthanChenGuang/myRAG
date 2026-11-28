---
quick_id: 261127-idn
slug: identifier-neutral-names
status: complete
date: 2026-11-28
branch: exec/quick-idn-neutral-names
base: origin/ci/merge-train-39
source: Phase 4.2 VERIFICATION W-5(j)
key-files:
  created:
    - scripts/ci/check-identifier-domain-words.mjs
    - scripts/ci/identifier-domain-words.json
    - scripts/tests/check-identifier-domain-words.node-test.mjs
  renamed:
    - src/lib/rag/ids/tax-ids.ts -> src/lib/rag/ids/checksum-ids.ts
    - tests/rag/tax-id-vectors.test.ts -> tests/rag/checksum-id-vectors.test.ts
  modified:
    - src/lib/rag/ids/shapes.ts
    - src/lib/rag/retrieval/exact-id.ts
    - tests/rag/exact-id.test.ts
    - tests/rag/backend/request-fields.test.ts
    - .github/workflows/pr-smoke.yml
---

# Quick 261127-idn: shape-neutral names in the identifier modules

Pure rename. No regex, matching order, extraction result (other than the in-memory kind label) or SQL call changed.

## Inventory (src/lib/rag/ids/** and src/lib/rag/retrieval/exact-id.ts)

| Where | Old | New | Note |
|---|---|---|---|
| ids/ file | `tax-ids.ts` | `checksum-ids.ts` | only importer: exact-id.ts and its vector test |
| checksum-ids | `TaxIdScheme`, `TaxIdCheck` | `ChecksumIdScheme`, `ChecksumIdCheck` | |
| checksum-ids | `normalizeTaxId`, `classifyTaxId` | `normalizeChecksumId`, `classifyChecksumId` | |
| checksum-ids | `isValidPartitaIva`, `isValidUscc`, `isValidEuVat` | `isValidElevenDigitId`, `isValidEighteenCharId`, `isValidCountryPrefixedId` | |
| checksum-ids | `IT_IVA_SHAPE`, `CN_USCC_SHAPE`, `EU_VAT_SHAPE` | `ELEVEN_DIGIT_SHAPE`, `EIGHTEEN_CHAR_SHAPE`, `COUNTRY_PREFIXED_SHAPE` | regexes byte-identical |
| checksum-ids | `USCC_ALPHABET`, `USCC_WEIGHTS` | `EIGHTEEN_CHAR_ALPHABET`, `EIGHTEEN_CHAR_WEIGHTS` | |
| checksum-ids | `ibanStyleMod97`, `validDutchBsn` | `alnumMod97`, `validDutchNineDigit` | |
| checksum-ids | header comment (tax ids, VAT) | shape wording | |
| shapes.ts | comment "invoice numbers, tax ids, model numbers" | "code-like tokens such as AB-1234 or 2025/0017" | `IDENTIFIER_PATTERN` unchanged |
| normalize.ts | — | — | already neutral |
| exact-id | `ExactIdKind` `'invoice' \| 'tax_id' \| 'model'` | `'cued_code' \| 'checksum_id' \| 'alnum_code'` | in-memory only: never persisted, logged or traced (stages record only `tokens=<count>`), not in any contract |
| exact-id | `INVOICE_CUE`, `invoiceCue`, `isPlainInvoiceNumber`, `SPACED_TAX_ID`, local `tax` | `REFERENCE_CUE`, `cued`, `isPlainCuedNumber`, `SPACED_CHECKSUM_ID`, `checked` | |
| exact-id | doc comments (invoice/tax id/supplier wording) | shape wording | |

## Kept on purpose (value-bound)

- Scheme values `'it_iva' | 'cn_uscc' | 'eu_vat' | 'unknown'`: they are the sidecar contract (`rag_sidecar.contracts.ingest.TaxIdScheme`,
  `InvoiceFields.schema.json`, generated `InvoiceFieldsSchema` Zod) and are stored in documents' extracted fields; only the TS type name changed.
- `REFERENCE_CUE` pattern text (cue words in zh/en/it): changing it changes which questions yield a cued code. It is the one remaining domain
  lexicon in the scanned files; moving it to the language registry is a behaviour change for a later plan.
- `financial_score`: a field of the shared `Candidate` type in `src/lib/rag/types.ts`, outside the identifier modules.
- RPC `rag_exact_id_documents` and its column names (`matched_field` values come from SQL) are untouched.
- Outside the scope and not renamed: `src/lib/rag/ingest/extractors/invoice.ts`, `retrieval/invoices.ts` and the sidecar `extract/tax_ids.py`
  (document-type features named for the document type they extract).

Each kept item is an exact-text entry with a reason in `scripts/ci/identifier-domain-words.json`; the check fails if an entry goes stale.

## CI guard

`node scripts/ci/check-identifier-domain-words.mjs` scans `src/lib/rag/ids/**` and `exact-id.ts`, splits identifiers, comments and strings into
words (case changes, digits, separators) and fails on any word from the list (finance, legal, medical terms) or listed CJK phrase. The word list
and allow-list are CI configuration only. Self-test `scripts/tests/check-identifier-domain-words.node-test.mjs` (4 tests); both run in
pr-smoke next to the language-literal check. On the old code the check reports 90 findings.

## Commits

- `7abda208` refactor: shape-neutral names in identifier modules
- `9e21cf84` ci: guard identifier modules against domain words
- SUMMARY (this file) and PLAN

## Gates run

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npm run typecheck:new`: no type errors
- `check-rag-boundary`, `check-language-literals`, `check-settings-classification`, `check-config`, `check-identifier-domain-words`: ok
- `node --test scripts/tests/check-identifier-domain-words.node-test.mjs`: 4/4
- `npm run gen:schemas`: no diff
- vitest exact-id / checksum vectors / request-fields / exact-id-rrf / every test importing ids/* or exact-id: 9 files, 207 tests pass
- full `npx vitest run`: 852 files passed, 3 skipped; 16124 tests passed, 90 skipped
- `node --import tsx --test tests/rag-db/exact-id-lookup.test.mts`: 6 pass
- `check-workflows.py`: OK
- eval pytest (`uv run --all-extras python -m pytest -q`): 2786 passed
- `npm run test-rag -- --fixture-mode ingest --out eval/out/quick-261127-idn-ingest`: gate PASS, absolute gate PASS

## Deviations

None. No dependency added; no migration; no env variable.
