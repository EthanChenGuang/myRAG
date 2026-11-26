# AIFA Italian medicinal-product corpus (RAG eval)

Built 2026-11-26. This is for local evaluation only. Nothing here was ingested into a database or committed to git.

## Sources
- Listing: `https://drive.aifa.gov.it/farmaci/confezioni_fornitura.csv`. It has one row per pack (9-digit AIC) with these fields: COD_FARMACO, product name, holder, procedure, form, ATC, active ingredient (`PA_ASSOCIATI`), supply class, `LINK_FI`, `LINK_RCP`. It has 160,135 rows and 12,647 authorised products. Also saved: `PA_confezioni.csv` (ingredient quantity per pack) and `atc.csv`. Both are linked from https://www.aifa.gov.it/liste-dei-farmaci. Copies are in `raw/`.
- PDFs are served per product (holder code + 6-digit AIC base) from `https://api.aifa.gov.it/aifa-bdf-eif-be/1.0.0/organizzazione/<ditta>/farmaci/<cod_farmaco>/stampati?ts=RCP|FI`. They need no key. 427 products were requested sequentially, with a 0.7 s delay between requests and a generic User-Agent. There was no rate limiting (no 429) and no transport failures.
- Naming: `<AIC>` is the 6-digit AIC base code (COD_FARMACO), because RCP and FI are issued per product, not per pack. The pack codes are listed in `manifest.csv` column `aic_packs`.

## Selection
- Included: authorised products with a single active ingredient. Homeopathic products and parallel imports are excluded. An "active ingredient" means one ATC level-5 code, so salt variants such as "SERTRALINA" and "SERTRALINA CLORIDRATO" are grouped together. An ingredient was eligible only if at least 4 different holders market it.
- 100 ingredients were picked at random (seed 20261126) with a quota per ATC level-1 group. For each ingredient the script chose up to 4 products, preferring a different holder each time, then a different form, then a different strength.
- If a product was missing either PDF, the script moved on to the next candidate for that ingredient.

## Counts
| | value |
|---|---|
| Products | 395 |
| PDFs | 790 (395 RCP + 395 FI) |
| Active ingredients (ATC5) | 100 (95 with 4 products, 4 with 3, 1 with 2; 95 ingredients have 4 distinct holders) |
| Distinct holders | 173 |
| Procedures | 190 MRP/DCP, 163 national, 42 centralised |
| Total pages | 11,655 (RCP 7,351, FI 4,304) |
| Avg pages / PDF | 14.8 (min 3, max 134) |
| Size on disk (pdf/) | 270 MB (269,959,402 bytes) |

Ingredients with fewer than 4 products: 3 have 3 products (including amfotericina B, J02AA01) and ivermectin (P02CF01) has 2. In each case, too few candidates had both documents available.

Per ATC level-1 group (ingredients / products / PDFs):

| ATC | ingredients | products | PDFs |
|---|---|---|---|
| A Alimentary/metabolism | 11 | 44 | 88 |
| B Blood | 5 | 20 | 40 |
| C Cardiovascular | 15 | 60 | 120 |
| D Dermatological | 3 | 12 | 24 |
| G Genito-urinary/sex hormones | 6 | 24 | 48 |
| H Systemic hormones | 4 | 16 | 32 |
| J Anti-infectives | 13 | 50 | 100 |
| L Oncology/immunomodulators | 9 | 36 | 72 |
| M Musculo-skeletal (incl. NSAIDs) | 7 | 28 | 56 |
| N Nervous system (incl. analgesics) | 17 | 67 | 134 |
| P Antiparasitic | 1 | 2 | 4 |
| R Respiratory | 6 | 24 | 48 |
| S Sensory organs | 3 | 12 | 24 |

Group P has only one eligible ingredient, ivermectin, with 2 products. Group V had none.

## Split
Whole ingredients (ATC5) are assigned to one split, stratified by ATC level 1 with seed 42 and about 20% of each group going to test.

| split | ingredients | products | PDFs | pages |
|---|---|---|---|---|
| train | 80 | 316 | 632 | 9,477 |
| test | 20 | 79 | 158 | 2,178 |

No ATC5 code appears in both splits. Diclofenac appears under two codes (D11AX18 and M02AA15), and both are in train.

## Skipped
- 32 candidate products were skipped because their RCP returned HTTP 404 (no document on file). They were replaced by the next candidate for the same ingredient.
- No PDF lacked a text layer. The lowest count was 3,685 characters on the first 3 pages. The check was `pdftotext` on pages 1 to 3, with fewer than 200 characters meaning scanned.
- There were no duplicate SHA-256 hashes.

## Size estimates
- Text measured: `pdftotext` over all 790 PDFs gives 11.16 M tokens (cl100k_base), about 958 tokens per page. RCPs are dense, with about 7.27 M tokens.
- Chunks:
  - At 2 chunks per page: about 23,300.
  - From measured tokens at 500 tokens per chunk, rounded up per document: about 22,700.
  - Overlap would raise this by its ratio, for example about 25,000 with 10% overlap.
- Database: at about 15 KB per chunk (1536-d vector, HNSW index, text and lexical index), the estimate is about 340 to 350 MB, and about 375 MB with 10% overlap.
- Embedding tokens: about 11.2 M for a single pass, or about 12.3 M with 10% overlap. Image captioning is not included.

## License and attribution
- AIFA open data is published under CC BY 4.0. Reuse is allowed, including commercially, with the obligation to cite the source (https://www.aifa.gov.it/open-data).
- Suggested credit: "Fonte: AIFA – Agenzia Italiana del Farmaco, Banca Dati Farmaci (dati aperti, CC BY 4.0), estrazione del 26/11/2026."
- Caution: the CC BY statement explicitly covers the open-data datasets, including the listing CSV that publishes the RCP/FI links. The PDFs themselves are product information approved by AIFA and written by the marketing-authorisation holders, and the documents carry no separate licence statement. Treat them as internal eval material, keep the attribution, and do not redistribute them or put them in the repo without checking.
- Documents are snapshots. AIFA updates RCP/FI texts over time, so `sha256` pins the exact version used.

## Files
- `pdf/`: 790 files named `<AIC6>_<RCP|FI>.pdf`.
- `manifest.csv` has these columns:
  - aic, aic_packs, product_name, active_ingredient, atc, atc_desc, holder, strength, form, procedure
  - doc_type, source_url, sha256, bytes, page_count, has_text_layer, text_tokens, split
- `raw/`: AIFA listing CSVs.
- `scripts/`: select.py, fetch.py, finalize.py.
- `work/`: candidates.json, state.json (per-request log including skips), stats.json, fetch.log.
