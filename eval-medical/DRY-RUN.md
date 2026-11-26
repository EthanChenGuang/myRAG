# AIFA medical eval corpus: ingest dry run (myrag-medical)

Date: 2026-11-26. Target: Supabase project `myrag-medical` (ref `fsgaeysipkukqoocgzbx`, free plan, 500 MB database, multi-tenant schema equal to main).
Nothing was written to any database, nothing was ingested, and no paid API was called. Nothing from this folder belongs in the repo.
Scope (owner update): Italian only, for both queries and documents. There is no zh/en cross-lingual retrieval.

## 1. Download

| | value |
|---|---|
| Files requested | 790 (395 RCP + 395 FI), sequential, 0.7 s delay, generic User-Agent |
| sha256 equal to manifest | **790** |
| Mismatches (document updated by AIFA) | **0** |
| Missing / HTTP errors | **0** |
| Size | 269,959,402 bytes (equal to the summary) |
| Listing | `raw/confezioni_fornitura.csv` (82.6 MB) |

- The handoff `fetch.py` was reviewed and not run. It reads `work/candidates.json` and selects candidates, and that file is not in the handoff.
- Instead, a manifest-driven downloader was used: `../em-scripts/dl.py` (run with `python -I`, outside the download folder). It records each file's result in `work/download.json` and logs to `work/download.log`.
- Layout: `pdf/<AIC6>_<RCP|FI>.pdf`, `raw/`, `work/` (download log, `txt/` pdftotext cache, `estimate*.json`, `sizes.json`).

## 2. Ingest path in the repo (read from code, not run)

### Command

`npm run rag:backfill -- --tenant <key> --source folder:<path> [--budget <USD>] [--concurrency n] [--dry-run]` (`src/lib/rag/ingest/backfill/cli.ts`, `orchestrate.ts`).

- **Tenant key.** In multi-tenant mode it must be `o:<organization uuid>` or `u:<auth user uuid>`. `backfillScope` looks the tenant up with the service-role client (`organizations` table or `auth.admin.getUserById`). `s:default` is refused in multi-tenant mode. The organization or user must exist in myrag-medical first. Creating it is a database write for the owner to do.
- **Folder source.** It is listed recursively, skips hidden files, and stays inside the root. Point it at `pdf/` only: pointing it at `eval-medical/` would also ingest `raw/*.csv` and `work/txt/*.txt`. The per-file cap is 20 MB, and the largest file here is 1.29 MB.
- **No per-document metadata.** Folder and manifest sources carry no metadata: a manifest line is only `{source_key, path|url, doc_type}`, and doc_type is one of the six generic types. Product, AIC, ATC, ingredient and MAH cannot be attached at ingest today.

### Does `--dry-run` need the database? Yes, and it writes. It was not run.

The dry run does the following, in order:
1. `rag_create_ingestion_batch` creates a batch row.
2. `inventory()` calls `rag_existing_file_hashes` and enqueues skipped jobs.
3. `runSample()` enqueues 1–5% of the files as `dry_run` jobs in the `ingestion_jobs` ledger. It forces `parseRouting: 'tiered'` and waits for the sidecar worker to parse them. That needs the Docling sidecar, the running app (`/api/internal/rag/ingest/jobs/[id]/*`) and staged originals in storage.
4. It stores the report on the batch (`rag_update_ingestion_batch`), releases the staged originals and sets the batch back to `pending`.

So it needs `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, a tenant row, the sidecar worker and the app. It writes ledger rows and storage objects. There is no offline mode. The offline estimate in section 3 replaces it.

### Pipeline and switches for this corpus

| Switch | Value | Why |
|---|---|---|
| `NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE` | `multi-tenant` | DB is multi-tenant (see the override note below) |
| `RAG_INGEST_PIPELINE` | `unified` | backfill and the ledger need it |
| `RAG_INGEST_ASYNC` | `on` | ledger path. Tiered routing requires unified + async, or the config falls back with a warning |
| `RAG_PIPELINE` | `v2` | documents ingested under `legacy` are never written into non-legacy chunking profiles. Under v2, with no live non-legacy profile, only the legacy chunk set is written, so this costs nothing now |
| `RAG_PARSER` | `docling` | the default is `llamaparse`, and the pinned eval env also says `llamaparse` |
| `RAG_PARSER_ALLOW_CLOUD` | `false` | no request reaches LlamaParse or the vision model. The chain parses through the Docling sidecar |
| `RAG_PARSE_PREMIUM_PAGE_BUDGET` | `0` | default. No premium tier |
| `RAG_PARSE_VLM_DETECT`, `RAG_PDF_IMAGE_CHUNKS`, `RAG_DOC_TYPE_LLM_DETECT` | `false` | no paid vision or LLM calls during ingest |
| `RAG_INJECTION_SCAN` | `off` | default |
| `RAG_EMBEDDING_PROFILES` | `off` for the baseline, `on` for Qwen | profiles are in `embedding_profiles` (0307) |
| `RAG_PRIMARY_LANGUAGE` / `RAG_SUPPORTED_LANGUAGES` | `it` / `it` | Italian only |
| `RAG_QUERY_TRANSLATE`, `RAG_LEXICAL_TRANSLATION`, `RAG_DOC_TRANSLATION` | `false` / `false` / `off` | Italian only; the pinned default `RAG_QUERY_TRANSLATE=true` is turned off |

- **Parser.** The chain is the profile preference, then `RAG_PARSER`, then llamaparse, then docling (`parsers/chain.ts`). Docling is the sidecar `RAG_SIDECAR_URL` + `RAG_SIDECAR_SECRET`, and there is no in-process PDF parser. Docling therefore costs $0 in API fees but needs `docker build --target docling rag-sidecar` (about 4 GB RAM and 2 CPUs per parse worker).
- **Parse time.** The cost table assumes 0.8 s/page. At that rate, 11,655 pages take about 2.6 h with one worker, or about 1.3 h with two.
- **Doc type.** It resolves to `general@1` (with LLM detection off). The chunker is `markdown_sections`, 512 max / 64 overlap / 32 min tokens, with no embedding header. The section path is prefixed to the embedded text (`text/embedding-text.ts`).

### Embedding profiles (repo config, also seeded in the eval DB by migrations 0307/0308)

| id | model | dims | storage | HNSW |
|---|---|---|---|---|
| `openai-3-small-1536` | text-embedding-3-small | 1536 | `legacy_column` (`document_chunks.embedding vector(1536)`), active | full index, m=64 |
| `qwen3-8b-2048` | Qwen/Qwen3-Embedding-8B | 2048 | `chunk_embeddings` halfvec | partial index, m=64, ef_c=200 |
| `qwen3-8b-1024` | Qwen/Qwen3-Embedding-8B | 1024 | `chunk_embeddings` halfvec | partial index |
| `voyage-4-large-2048/1024` | voyage-4-large | 2048/1024 | halfvec | partial index |
| *(none)* 768-d Italian encoder | — | 768 | needs a new provider, catalog entry, profile row and partial index migration (`halfvec(768)`). A float `vector(768)` would need new storage, because the legacy column is fixed at 1536 | — |

- **Qwen hosts.** The primary is DeepInfra (`DEEPINFRA_API_KEY`, catalog $0.01/MTok) and the fallback is OpenRouter (`OPENROUTER_API_KEY`), set by `RAG_QWEN_EMBED_PRIMARY` and `RAG_QWEN_EMBED_FALLBACK`.
- **Write targets** (`embedding-targets.ts`). With profiles off, only the legacy openai vector is written. With profiles on, the active, backfilling and previous profiles are all written.
- **Activation gate** (0425). Activating a profile needs three things:
  - every current chunk embedded for that profile;
  - a backfill run;
  - eval evidence whose `baseline_profile` is the currently active profile (openai).

  So **openai-1536 and Qwen must coexist in the DB at least until Qwen is activated and openai is retired**. That has a direct size consequence, shown in section 3.
- **Evaluating without activating.** The eval harness can select a non-active profile per request (`request_options.embedding_profile`).
- **Deriving 1024 from 2048.** `npm run rag:reembed -- --profile qwen3-8b-1024 --derive-from qwen3-8b-2048` derives 1024-d vectors from the 2048-d ones by MRL truncation, with no API cost.

### Parent-child chunking

- `RAG_PARENT_CHILD=true` together with a chunking profile: `npm run rag:chunking -- create <id> --doc-type general --preset custom --child-tokens 300 --parent-mode structure --parent-tokens <cap>`.
- **Live profiles.** Under v2, the ingest writes the legacy set and every live non-legacy profile (`profile-chunks.ts`). `rag:rechunk -- --profile <id>` builds a profile for documents that are already stored. **Both chunk sets are stored side by side** (the variant rows have status `variant`).
- **Overlap.** Children have no overlap (`overlap_tokens: 0` in `parent-child.ts`).
- **Parents.** Structure parents are cut from the Docling headings by the `markdown_sections` chunker, not by a QRD whitelist. Parents have a token cap; whole 4.x sections up to 36k tokens do not fit (see section 3).

### Multi-tenant override

- `eval/config/rag-eval-env.json` pins `NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE=single-tenant`. That file is test-pinned to the `scripts/init-env.js` defaults (`tests/eval-env-pin.test.ts`), so **do not edit it**.
- Instead, override in two places:
  1. The `.env.local` of the medical instance, and the run config's `env` (which `report.py` reads): `NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE=multi-tenant` plus the switches above.
  2. The eval `request_options.organization_id` (or `user_id`), set to the ingest tenant.
- Keep that run config in the scratchpad.

## 3. Offline estimate (pdftotext -layout + cl100k_base; `../em-scripts/estimate.py`, `sizes.py`)

### Text

| | RCP | FI | total |
|---|---|---|---|
| Pages | 7,351 | 4,304 | **11,655** |
| Raw tokens | 7.22 M | 3.89 M | **11.11 M** |
| Footer + watermark + page-number noise | 0.98 M | 0.57 M | **1.54 M (13.9%)** |
| Clean tokens | 6.24 M | 3.32 M | **9.56 M** (31.2 MB UTF-8) |

- **Noise.** It comes from the per-page footer ("Documento reso disponibile da AIFA il …" plus the three-line disclaimer) and from the diagonal watermark broken into fragments ("Ag", "enz", "Ita", "aco", …), at about 130 tokens per page. Today all of it would be embedded and lexically indexed.
- **QRD structure.** Under a whitelist and regex check:
  - RCPs: 376 of 395 have sections 1–10; 19 do not.
  - FIs: 174 have sections 1–6, 220 have some, and 1 has none.
- **Multi-variant PDFs.** **103 of the 395 RCP PDFs** hold several RCPs (one per strength or form) one after another, and at least 39 FIs hold several leaflets. A parser therefore has to cut at the "1. DENOMINAZIONE" restarts and tag each variant.

### Chunks

| Chunk set | chunks | parents | embed tokens | mean child |
|---|---|---|---|---|
| **B** repo default (`general@1` markdown_sections 512/64/min 32, split at headings) | **30,254** | — | 9.88 M | ~313 tok |
| **A** research (QRD sub-section parents, ~300-token children, 36-token (12%) overlap, deterministic `[product strength \| RCP \| 4.2 title]` prefix) | **44,906** | **15,088** | 10.45 M | 204 tok (many short sections are one child each) |
| C legacy pipeline (600/100, whole text) | 18,711 | — | 10.18 M | — |
| **A+B** (what v2 stores once profile A is live) | 75,160 | 15,088 | 20.33 M | — |

- **Parent size.** The median parent is 133 tokens and p95 is 2,664. The largest is 36,702 tokens (a single 4.8 or 5.x section). 1,017 parents exceed 2,048 tokens, so a parent cap is required: 2,048 is suggested.
- **Uncleaned text.** These counts use cleaned text. Without cleaning, add about 14%.

### Database size against the 500 MB free limit

- **Per-vector model** (heap with TOAST, plus HNSW with m=64, at 8 KB pages and the number of elements that fit on a page):
  - openai-1536 vector: 14.5 KB (6.3 KB heap + 8 KB HNSW, one element per page);
  - qwen 2048 halfvec: 12.7 KB (4.2 KB + 8 KB, one per page);
  - qwen 1024 halfvec: 6.5 KB (2.1 KB + 4 KB, two per page);
  - 768 float vector: 7.5 KB;
  - 768 halfvec: 4.6 KB.
- **Per-row extras:**
  - each chunk row adds about 1.37 KB of fixed columns, metadata and btree indexes, plus 3.3 times its content size (content, `lexical_text`, tsvector with positions, and the GIN index);
  - each parent adds 230 B plus its text;
  - each `chunk_embeddings` row adds about 280 B.
- **Fixed and bloat.** A fixed 45 MB covers the system schemas, about 105 migrations and the jobs and documents tables. The "+20%" column allows for UPDATE bloat: publish flips the status of every chunk row.
- **Uncertainty.** The estimate is about ±25%. HNSW dominates it.

| Profiles stored | B: total MB (+20%) | A: total MB (+20%) | A+B: total MB (+20%) |
|---|---|---|---|
| openai-3-small 1536 vector | **602** (714) | 853 (1,015) | 1,410 (1,684) |
| qwen3-8b 2048 halfvec | 551 (653) | 777 (924) | 1,284 (1,531) |
| qwen3-8b 1024 halfvec | **373** (438) | 512 (605) | 839 (998) |
| Italian 768 float vector | 402 (473) | 555 (657) | 911 (1,084) |
| Italian 768 halfvec | **317** (372) | 430 (507) | 702 (834) |
| openai 1536 + qwen 2048 | 970 (1,154) | 1,398 (1,668) | 2,322 (2,778) |
| openai 1536 + qwen 1024 | 791 (940) | 1,133 (1,350) | 1,878 (2,245) |
| qwen 2048 + qwen 1024 | 740 (879) | 1,057 (1,259) | 1,751 (2,093) |
| openai + qwen 2048 + qwen 1024 | 1,158 (1,380) | 1,677 (2,004) | 2,790 (3,339) |
| openai 1536 + it-768 halfvec | 736 (874) | 1,051 (1,252) | 1,741 (2,080) |
| qwen 1024 + it-768 halfvec | 506 (598) | 709 (842) | 1,170 (1,395) |

- **What fits.** On the full corpus, only a *single* small profile on chunk set B fits under 500 MB: qwen-1024 or 768 halfvec, in the 317–440 MB range. **Even the openai-3-small baseline alone (602 MB) does not fit.** Neither does any baseline-plus-comparison pair, nor anything that also stores set A.
- **Why the small profile is hard to reach.** The repo cannot get to "qwen-1024 only" without first storing the openai vectors. Only the active profile is written by default, and activating Qwen needs evidence against the active openai profile.
- **Storage.** The 1 GB storage quota is separate from the database. Originals in `rag-originals` take about 270 MB, plus the Docling `result.json` artifacts. Keep `generate_picture_images` in mind: `general@1` has it set to true.
- **Text without vectors.** The B set alone, with lexical index and no vectors, is about 139 MB. With set A and parents it is 187 MB, and with A+B it is 327 MB.

### Cost

| Item | B | A | A+B |
|---|---|---|---|
| openai 3-small @ $0.02/MTok | $0.20 | $0.21 | $0.41 |
| Qwen3-8B @ $0.01/MTok (DeepInfra; catalog) | $0.10 | $0.10 | $0.20 |
| Qwen3-8B @ $0.04/MTok (OpenRouter, high end) | $0.40 | $0.42 | $0.81 |
| qwen 1024 derived from 2048 (`--derive-from`) | $0 | $0 | $0 |
| Italian 768 encoder (self-hosted in sidecar) | $0 API (compute only) | | |

- **Token counts.** They are cl100k counts. The Qwen tokenizer bills somewhat differently, so allow ±15%.
- **Parsing:**
  - Docling locally costs $0.
  - LlamaParse, if `RAG_PARSER` stayed at its default with cloud allowed, would cost about $35–47 (11,655 pages at $0.003–0.004/page; the premium tier in `parse-routing.json` is $0.004).
- **Budget gate.** `rag:backfill`'s projection prices local tiers at an *assumed* $0.001/page, which is $11.65 here. So `--budget` must be at least about $13 even though the real spend is only the embeddings (well under $1). With a smaller budget the command exits 3.

## 4. What must be built before an ingest that follows the research report (Italian only)

### New code needed

1. **QRD section parser.**
   - RCPs: an Italian heading whitelist and regex for 1–11 and 4.1–4.9 / 5.1–5.3 / 6.1–6.6. It must tolerate "4.2" vs "4.2." and headings split over lines, check that numbering only increases, and detect a multi-variant restart at "1. DENOMINAZIONE".
   - FIs: a whitelist for 1–6, with the table-of-contents block removed.
   - Documents that fail the checks are flagged for review.
   - This is needed because Docling's heading levels will not reliably give QRD sections, and the structure-parent mode cuts by the generic chunker.
2. **Footer and watermark cleaning** before chunking and lexical indexing. It removes 13.9% of the tokens. The repo has `hidden-text-rules.json` and similar rule files, but nothing for page-repeated footers or fragmented watermarks.
3. **Per-document drug metadata.** product, AIC list, `cod_farmaco`, ingredient, ATC5, strengths, forms, MAH and doc_type RCP/FI, taken from `confezioni_fornitura.csv`. Three pieces are new:
   - an ingest path (sources carry no metadata today);
   - chunk denormalisation;
   - filters: a hard filter on a named product or ingredient, soft weights on strength, section and doc type.

   `RAG_EXACT_ID_LOOKUP` exists, but its kinds are invoice, tax_id and model. AIC and ATC need a new kind or a dictionary rule.
4. **Deterministic product and section header in the embedding text.** `embedding_text_template.header` exists, but the product name is not a stored document column, so a template placeholder and an extractor are new. The section path is already prefixed.
5. **Section-level dedup.** Collapse results with the same (ingredient, section, content hash) after fusion. `content_hash_dedup` works at document level only.
6. **Italian stemming in the lexical leg.**
   - `stemItalian` (Snowball) and the `LexicalOptions` `stemIt` / dictionary-token hooks exist on **branch `exec/04.2-04`, which is not merged to main**.
   - `LEXICAL_VERSION` is still 2.
   - Nothing passes the option yet: the writer, relex and query wiring, an env switch and the version bump are follow-up plans (04.2-02/18/19/22/34).
   - After it lands: dosage tokens ("2,5 mg" → `2_5mg`), then `npm run rag:relex`.
7. **Italian brand↔INN↔salt synonym table** (for example SERTRALINA / sertralina cloridrato / brand names, for 100 ingredients). It should be fed through the dictionary tokens (`_t_` prefix, 04.2-04) or an exact-entity leg. It is kept in the scratchpad or tenant data, never in the repo.
8. **Optional: a 768-d Italian encoder profile.** It needs a provider, catalog entry, profile row and partial HNSW index migration, plus a sidecar endpoint. BioBIT and MedBIT are MLMs, not retrievers, so they need contrastive training first (the research report excludes them as they are).

**Dropped by the scope change:** query translation, lexical translation, the trilingual ingredient table and zh/en question sets.

### Runs now with existing switches

- unified pipeline and ledger;
- Docling parse with cloud disabled;
- `general@1` chunking (set B);
- openai-1536 baseline, and Qwen 2048/1024 profiles through `rag:embedding` and `rag:reembed` (1024 by `--derive-from`);
- a parent-child chunking profile through `rag:chunking create … --child-tokens 300 --parent-mode structure --parent-tokens 2048` plus `RAG_PARENT_CHILD=true` (not QRD-aware, children without overlap);
- `RAG_LEXICAL_SEARCH=true` (no stemming);
- `RAG_RERANKER=cohere|voyage`, `RAG_REFUSAL_THRESHOLD` with `calibrate refusal`, and `RAG_CITATIONS`;
- `RAG_TABLE_HEADER_REPEAT` and `RAG_TABLE_ROW_SERIALIZATION`.

## 5. Recommendation

**Main finding: the free plan cannot hold this corpus with a baseline.**
- The openai-3-small baseline on the default chunker alone is about 600 MB.
- The repo's activation gate means Qwen and openai must coexist: about 790 MB for openai + qwen-1024, and about 970 MB for openai + qwen-2048.
- The research configuration (A plus B stored together) needs 1.3–2.8 GB.

Options, best first:

1. **Move myrag-medical to Pro for the eval period** (8 GB DB included). Then ingest the whole corpus with this profile set: openai-1536 (baseline) + qwen3-8b-2048 (primary) + qwen3-8b-1024 (derived, $0). With set B that is about 1.16 GB. Adding set A later brings it to 2.8–3.3 GB. Everything fits.
2. **Stay on free and cut the corpus.**
   - openai + qwen-1024 on set B fits at about 45% of the documents (≈ 45 of the 100 ingredients ≈ 355 PDFs). Keep all 20 test ingredients, the ~10 dev ingredients and about 15 more train ingredients as distractors.
   - Or keep openai only at about 65% of the corpus.
   - This weakens the "wrong generic" distractor signal that the report calls the main risk.
3. **Not recommended:** a full corpus with a single qwen-1024 profile, reached by a pilot that activates Qwen and then retires openai. It removes the baseline comparison and adds activation steps for little gain.

**Baseline to ingest first, on either plan:** chunk set B (`general@1`), openai-3-small-1536 legacy column, `RAG_EMBEDDING_PROFILES=off`, Docling local, cloud off, v2 pipeline switches off except as listed. Then:
- set qwen3-8b-2048 to `backfilling` and run `rag:reembed`;
- derive 1024;
- compare with `sweep`;
- build profile A only once the QRD parser and the cleaning exist.

On free, first ingest about 50 files and measure the real size with read-only SQL: `select pg_database_size(current_database()), pg_total_relation_size('document_chunks'), pg_total_relation_size('chunk_embeddings')`. Extrapolate before going further; the model here is about ±25%.

### Exact commands and environment for the real ingest (owner runs; not executed here)

Prerequisites:
- Migrations through main applied, including those not folded into the setup (0426, 0427, Phase 6–8). Check with a read-only `list_migrations`.
- A tenant: create an organization in myrag-medical and note its uuid.

`.env.local` of a local checkout pointed at the medical DB, as a delta on the `init-env.js` defaults:
```
NEXT_PUBLIC_SUPABASE_URL=https://fsgaeysipkukqoocgzbx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>
SUPABASE_SERVICE_ROLE_KEY=<service role key>
NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE=multi-tenant
OPENAI_API_KEY=<key>
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
RAG_INGEST_PIPELINE=unified
RAG_INGEST_ASYNC=on
RAG_PIPELINE=v2
RAG_PARSER=docling
RAG_PARSER_ALLOW_CLOUD=false
RAG_PARSE_PREMIUM_PAGE_BUDGET=0
RAG_PARSE_VLM_DETECT=false
RAG_PDF_IMAGE_CHUNKS=false
RAG_DOC_TYPE_LLM_DETECT=false
RAG_EMBEDDING_PROFILES=off
RAG_PRIMARY_LANGUAGE=it
RAG_SUPPORTED_LANGUAGES=it
RAG_QUERY_TRANSLATE=false
RAG_SIDECAR_URL=http://localhost:8000
RAG_SIDECAR_SECRET=<32+ random chars>
RAG_APP_INTERNAL_URL=http://localhost:3000
# for the Qwen step later:
# RAG_EMBEDDING_PROFILES=on  DEEPINFRA_API_KEY=<key>  (or OPENROUTER_API_KEY + RAG_QWEN_EMBED_PRIMARY=openrouter)
```

Run:
```
# 1. Docling sidecar with the ingest worker (same NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RAG_SIDECAR_SECRET, RAG_APP_INTERNAL_URL)
cd rag-sidecar && docker build --target docling -t myrag-sidecar:docling .
docker run --rm -p 8000:8000 --memory 4g -e RAG_INGEST_WORKER=on -e RAG_INGEST_WORKER_CONCURRENCY=1 \
  -e NEXT_PUBLIC_SUPABASE_URL -e SUPABASE_SERVICE_ROLE_KEY -e RAG_SIDECAR_SECRET -e RAG_APP_INTERNAL_URL=http://host.docker.internal:3000 myrag-sidecar:docling
# 2. App (the worker calls back into /api/internal/rag/ingest/jobs/[id]/*)
npm run dev
# 3. Dry run (writes a batch row + sample dry_run jobs; exit 2)
npm run rag:backfill -- --tenant o:<org-uuid> --source folder:/tmp/claude-0/-home-user-myRAG/73e934a1-4523-56f0-8c23-083a3d85f68f/scratchpad/eval-medical/pdf --dry-run
# 4. Real ingest (projection ≈ $11.7 assumed parse + ≈ $0.2 embeddings; real spend ≈ $0.2)
npm run rag:backfill -- --tenant o:<org-uuid> --source folder:/tmp/claude-0/-home-user-myRAG/73e934a1-4523-56f0-8c23-083a3d85f68f/scratchpad/eval-medical/pdf --budget 15 --concurrency 2
# 5. Comparison profile (Pro plan, or the reduced corpus on free)
npm run rag:embedding -- set-status qwen3-8b-2048 backfilling      # with RAG_EMBEDDING_PROFILES=on
npm run rag:reembed -- --profile qwen3-8b-2048 --tenant o:<org-uuid> --dry-run
npm run rag:reembed -- --profile qwen3-8b-2048 --tenant o:<org-uuid>
npm run rag:reembed -- --profile qwen3-8b-1024 --tenant o:<org-uuid> --derive-from qwen3-8b-2048
```

- **Reduced corpus on free.** Copy the chosen subset into a separate folder, for example `eval-medical/pdf-subset/`, and point `--source` at it.
- **Folder location.** The `--source folder:` path must be on the machine that runs the CLI. If the ingest runs elsewhere, copy `pdf/` there; the sha256 values in `manifest.csv` verify the copy.
