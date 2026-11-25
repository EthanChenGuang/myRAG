# Phase 3: Unified Ingestion & Embedding Profiles - Research

**Researched:** 2026-11-23
**Domain:** document ingestion (TypeScript stages plus a Python Docling sidecar), Postgres schema migration with versions and quarantine, switchable embedding providers on pgvector `halfvec`, eval fixtures
**Confidence:** HIGH for the codebase, schema and pgvector findings (read and executed here), MEDIUM for vendor API details (official docs, no live keys), LOW for real-document quality (OCR accuracy, embedding ranking), which stays live verification

<user_constraints>
## User Constraints (from CONTEXT.md)

Copied verbatim from `03-CONTEXT.md` (only the heading level of the decision groups was lowered by one). The compact decision index stays in CONTEXT.md.

### Locked Decisions

#### Ingestion entry point and rollout
- **D-01:** `src/lib/rag/ingest/` exposes one public function through `@/lib/rag`: `ingest({ scope, source, sourceKey, file | text, filename, mimeType, docType?, options?, signal, trace })`. It returns an `IngestResult` with:
  - `status`: one of `ready | skipped_duplicate | quarantined | processing | failed`
  - `documentId`, `version`, `parserUsed`, `chunkCount`
  - `warnings`

  `scope` is the Phase 2 branded `TenantScope`. Ingestion never takes a raw `userId` or `organizationId`. Each write path resolves its scope server-side:
  - chat upload: the D-08 chat resolver
  - Config UI: an admin session plus the selected workspace, checked by membership
  - Nango: the connection owner's workspace
  - scrapers: the job owner
  - `ai-to-rag`: the session

  **Reversibility:** costly. Every write path and Phase 3.1's ledger worker call this signature.
- **D-02:** `ingest()` is an ordered list of named, idempotent stage functions:
  - `identify`
  - `file_hash_dedup`
  - `store_original`
  - `parse`
  - `content_hash_dedup`
  - `scan_injection`
  - `chunk`
  - `enrich`
  - `extract` (type-specific metadata, such as invoice fields)
  - `images`
  - `embed`
  - `write`
  - `publish`

  Each stage reads and writes only the `(document_id, version)` it is given. Stage state is persisted on the document row (`processing_status`, `processing_state` jsonb with the sidecar job id and the last completed stage), so a run that stops can be resumed by `resumeIngest(scope, documentId)`. Phase 3.1 moves this state into `ingestion_jobs` and runs the same stage functions from its worker without changing them.

  Stages report into the Phase 2 trace collector, with one ingestion trace per document. Span names equal the stage names.
- **D-03:** Switch `RAG_INGEST_PIPELINE=legacy|unified`, default `legacy`.
  - `legacy` keeps today's code paths byte for byte. That covers `process-document`'s own LlamaParse and character chunker with its `Document: X. Chunk n of m. Content:` prefix, `document-processor.ts`, and `storeDocument` in `supabase.ts`. Only the additive schema defaults apply: `version=1`, `is_current=true`, `status=ready`.
  - `unified` routes every write path through `ingest()`.

  The switch is read per request, so rolling back needs no data change. Chunks written under `unified` stay readable under `legacy` retrieval, because the LLM-facing `content` column keeps plain chunk text.
- **D-04:** The single-writer rule is added to the Phase 2 boundary check (`scripts/ci/check-rag-boundary.mjs`). Outside `src/lib/rag/ingest/`, any `.from('document_chunks')` insert, update or upsert fails CI. So does any direct `.from('documents')` insert. Allow-listed:
  - the legacy writers, while `RAG_INGEST_PIPELINE` exists: `process-document` legacy branch, `document-processor.ts`, `supabase.ts storeDocument`
  - tests and harness fakes

  Each allow-list entry names the plan that removes it once `unified` becomes the default (Phase 7 release defaults).

#### Schema, identity and versions
- **D-05:** Migrations live in a new `supabase/migrations/` directory as ordered, idempotent SQL files, applied by `scripts/setup-database.sh` after the setup file. `single-tenant-setup.sql` and `multi-tenant-setup.sql` are updated so a fresh install equals setup plus migrations, and a CI test asserts the two produce the same schema. The PGlite eval harness loads the migrations too. All changes are additive, with defaults that keep existing rows valid (`version 1`, `is_current true`, `status 'ready'`, `doc_type 'general'`).

  **Reversibility:** one-way. Applied migrations on the user's Supabase project cannot be cleanly removed. Apply them on the real project is a live verification item.
- **D-06:** One `documents` row per version.
  - **Columns added:**
    - `lineage_id`: stable across versions
    - `source`: widened enum `chat_upload | config_upload | nango | scraper | image_upload | ai_to_rag`. The old CHECK constraint, which lacks scraper and chat sources, is replaced. Existing values map: `upload → config_upload`, provider names → `nango` with `source_provider` kept.
    - `source_key`
    - `version`
    - `is_current`
    - `superseded_by`
    - `status`: `processing | ready | quarantined | failed | deleted`
    - `processing_status`, `processing_state`
    - `doc_type`, `doc_type_origin`: `picked | source_default | tenant_default | auto | fallback`
    - `doc_date`
    - `language`: dominant language
    - `file_sha256`
    - `content_hash`
    - `parser_used`, `parser_version`
    - `processing_profile_id` plus its version
    - `original_path`: tenant-scoped storage path of the original file
    - `tenant_key`: generated column, `s:default` in single-tenant, otherwise `u:<user_id>` when `organization_id` is null, else `o:<organization_id>`. Same semantics as Phase 2 D-07.
  - **Lineage index:** a partial unique index on `(tenant_key, source, source_key) WHERE is_current`.

  **Reversibility:** costly. Citations, Phase 5's citation record and Phase 7's sync key off these rows.
- **D-07:** `document_chunks` gains promoted columns:
  - `tenant_key`, `version`, `is_current`, `status`: denormalized for filtering
  - `doc_type`, `doc_date`, `language`, `source`
  - `page_start`, `page_end`
  - `section_path text[]`
  - `content_hash`: chunk-level, normalized
  - `chunk_kind`: `text | table | image | invoice_header`
  - `parser_used`
  - `embedding_text_version`
  - `lexical_text`

  The same fields are mirrored in `metadata` (DATA-02 names the `metadata.section_path` key), and the existing URL metadata (`urls`, `has_urls`, `url_count`, `url_categories`) is kept unchanged. Phase 3 adds only btree indexes needed for its own queries (lineage, dedup, invoice fields). The `lexical_text` index is Phase 4's.
- **D-08:** Retrieval excludes non-current and non-ready rows. The legacy RPCs (`match_documents_by_workspace`, `match_document_chunks`) and the new per-profile RPC add `AND c.is_current AND c.status = 'ready'`. This filter has no switch: quarantine is a security control (Phase 2 D-11 rule). It is behaviour-preserving for existing rows, because they default to current and ready. The Phase 2 parity gate must still pass with all paired differences zero after the migration.

#### Dedup and versioning
- **D-09:** There are two hashes, both compared only within one `tenant_key`.
  - **`file_sha256`:** the raw bytes. A match skips parsing entirely.
  - **`content_hash`:** sha256 of the normalized extracted text (NFKC, line endings unified, whitespace runs collapsed, trimmed; case kept). This is the dedup authority.

  An upload whose `content_hash` already exists as a current document in the same tenant returns `skipped_duplicate` with the existing document id and writes no chunks. The same bytes in another tenant are ingested normally. A two-tenant test proves both cases, through the Phase 2 two-tenant fixture.

  **Reversibility:** costly. The hash normalization rule is persisted in every row, so changing it later means rehashing everything.
- **D-10:** Stable identity is `(tenant_key, source, source_key)`, with `source_key` per source as in `.planning/specs/ingestion-routing.md`:
  - **Uploads:** the logical upload path (folder id or root, plus the NFKC-normalized filename). This path is also the storage key of the original.
  - **Nango:** the provider file id.
  - **Scraper:** the canonical URL.
  - **Image upload:** the storage path.

  What happens to an upload:
  - **Same identity and same content hash:** skipped.
  - **Same identity and a new hash:** a new version.
  - **New identity with a content hash already present in the tenant:** skipped as a duplicate of that document.
- **D-11:** The version swap is one SQL function, `rag_publish_document_version(p_document_id)`, run with the server role in one transaction:
  1. Mark the new version's document row and chunks `is_current = true`, `status = 'ready'`.
  2. Mark the previous current version's document and chunks `is_current = false`.
  3. Set the old row's `superseded_by`.

  Old rows and chunks are never deleted by a version swap, so stored message sources and citations that name an old `document_id` or chunk id still resolve. A test cites an old chunk, publishes v2, and checks that:
  - retrieval returns only v2 chunks
  - the old citation still loads its text and document name

  Hard deletion stays an explicit user or admin delete.

#### Document types, profiles and defaults
- **D-12:** The type identifiers are `financial_report`, `contract_legal`, `invoice_receipt`, `product_technical`, `scanned_image` and `general`. UI labels are localized in zh, en and it.

  **Reversibility:** costly. They are persisted on documents, chunks, defaults and golden metadata.
- **D-13:** Processing profiles are data. `config/rag/processing-profiles.json` holds one entry per type.
  - **Schema:** a Pydantic model `ProcessingProfile` in the sidecar contracts, with the Zod schema generated from it and CI parity as in Phase 1.
  - **Fields:**
    - `id`, `version`, `doc_type`
    - `parser`: preference order, Docling options, OCR on/off and languages, table mode
    - `chunker`: kind `markdown_sections | legal_clauses | table_aware | invoice | image_caption`, `max_tokens`, `overlap_tokens`, `repeat_table_header`, `min_chunk_tokens`
    - `extractors[]`: `dates`, `financial`, `invoice`, `urls`
    - `embedding_text_template`
    - `scan_injection`
    - optional `min_tier`/`max_tier` (unused until Phase 3.1)
    - optional `parent_child`, reserved for CHK-04

  `ingest()` looks up the profile and never branches on doc type elsewhere. A CI test fails on a `doc_type ===` comparison outside `src/lib/rag/ingest/profiles/`. Editing profiles in the Config UI stays OPS-03 (v2). Only the defaults in D-15 are editable.
- **D-14:** Starting profile values. The researcher may adjust these with evidence.

  | Type | Parser | Chunking | Extractors |
  |---|---|---|---|
  | `general` | default parser | markdown sections, 512 tokens, overlap 64 | dates, urls |
  | `financial_report` | Docling or LlamaParse with table structure | table-aware, 512, header repeated | dates, financial |
  | `contract_legal` | default parser | legal clauses, 768 max per piece | dates |
  | `invoice_receipt` | Docling structured with OCR | invoice: header block plus line-item table kept in one chunk up to 1024 | invoice |
  | `product_technical` | default parser | markdown sections, 512 | urls |
  | `scanned_image` | Docling with OCR forced on | markdown sections, 512 | dates |

  All token counts use the `cl100k_base` tokenizer (D-22).
- **D-15:** Doc-type defaults live in a new table, `rag_doc_type_defaults`:
  - **Columns:** `tenant_key`, `source_kind`, `source_ref`, `doc_type | 'auto'`, `updated_by`, `updated_at`.
  - **Access:** RLS for the server role only.
  - **`source_kind`:** `tenant` or one of the sources (`chat_upload`, `config_upload`, `nango`, `scraper`, `image_upload`).
  - **`source_ref`:** a Nango connection id, a Nango folder id, or null.

  Resolution order, implemented once in `resolveDocType()`:
  1. the type picked for the file
  2. the Nango folder default
  3. the Nango connection default
  4. the source default
  5. the tenant default
  6. `general`

  A default of `auto` runs auto-detect (D-16). The resolved origin is stored in `doc_type_origin`. A table-driven test covers every precedence step.
- **D-16:** Auto-detect is rules-first and deterministic, in `detect-doc-type.ts`. It uses:
  - filename and extension
  - zh/en/it keyword sets (for example 发票/fattura/invoice, 合同/contratto/agreement, 资产负债表/bilancio/balance sheet)
  - the share of pages without a text layer, for `scanned_image`
  - invoice-number and VAT-ID patterns

  It returns a type, a confidence and the matched signals. Below a confidence of 0.6 it returns `general`. An optional LLM classifier exists behind `RAG_DOC_TYPE_LLM_DETECT` (default `false`): structured output defined by a Pydantic `DocTypeDetection`, a recorded-response fake in tests, and a cheap model from the five-location model list. The detected type and its signals are stored in `metadata.doc_type_detection`.
- **D-17:** The picker is a per-file select in:
  - the chat upload UI (the existing file upload component)
  - the Config UI document upload

  It is pre-selected from `GET /api/rag/doc-type-defaults?source=...`, which resolves the D-15 order for the caller's scope. An `auto` default shows as "Auto-detect". The user can change it before upload, and the chosen value is sent to the upload route.

  When `RAG_INGEST_PIPELINE=legacy`, the picker is hidden and nothing changes in the UI.
- **D-18:** Admins change an existing document's type from the Config UI document list, through the authenticated `POST /api/rag/admin/documents/{id}/doc-type`. This re-runs `ingest()` on the same identity with the new type, as a new version through the D-11 swap. When the parser options of the old and new profile are equal, the run starts from the stored parse output with no parser call; otherwise it re-parses the stored original. The original file is stored in a private, tenant-scoped storage bucket (`rag-originals/<tenant_key>/<lineage_id>/<version>/<filename>`), and the parse output (markdown, plus Docling JSON when Docling ran) sits next to it. This is the precursor of Phase 3.1's parse cache.

#### Parsing
- **D-19:** Switch `RAG_PARSER=llamaparse|docling`, default `llamaparse`, which is today's parser. Under `unified` the fallback chain is:
  1. the configured parser
  2. the other parser
  3. plain-text extraction for text-like files (txt, md, csv, html, docx through the existing extractors)
  4. otherwise the document is `failed` and retryable

  Docling is used when LlamaParse is unconfigured (no `LLAMACLOUD_API_KEY`), errors, or times out. `parser_used` and `parser_version` record what actually ran, and every fallback is logged under `[Ingest]` with its reason. A test covers LlamaParse stubbed as missing and as failing.
- **D-20:** The sidecar gets an async parse job API. All its routes require the shared secret and fail closed (Phase 1 D-21).

  | Route | Body or effect | Returns |
  |---|---|---|
  | `POST /v1/parse/jobs` | multipart file plus a Pydantic `ParseJobRequest` (`profile_id`, `docling` options, `ocr_languages`, `tokenizer`, `max_tokens`, `repeat_table_header`) | `{job_id}` |
  | `GET /v1/parse/jobs/{id}` | polls the job | `{status, result?}` |
  | `DELETE /v1/parse/jobs/{id}` | removes the job | |

  The result is a `ParseResult`:
  - `markdown`
  - `chunks[]`: `text`, `contextualized_text`, `headings[]`, `pages[]`, `is_table`, `table_header`
  - `pictures[]`: `page`, `bbox`, `image_ref`
  - `page_count`, `language`, `parser`, `parser_version`
  - `warnings[]`, `partial`

  Jobs run in a bounded worker pool inside the sidecar, so `/health` stays responsive. Results are kept in memory or on disk with a TTL (default 1 h), and the sidecar stays stateless towards Supabase. Docling is an optional dependency group (`uv sync --extra docling`) that the production image installs.

  **Reversibility:** costly. This is a wire contract between the app and the separately deployed sidecar.
- **D-21:** The app polls with backoff inside a per-request budget (default 45 s, under Vercel's 60 s cap). When the budget runs out, the document stays `processing`, with the sidecar job id in `processing_state`. Resumption has two parts:
  - **What the UI shows:** the existing Config UI status monitor and the chat upload status poll `GET /api/rag/ingest/{documentId}`.
  - **What continues the stages:** `POST /api/rag/ingest/{documentId}/resume`, which is authenticated and scope-checked.

  There is no new worker or queue in Phase 3, because that is Phase 3.1. A test interrupts after `parse` has been submitted and resumes to `ready`, with no duplicate chunks.
- **D-22:** Docling configuration:
  - **Chunker:** HybridChunker with `repeat_table_header=True`.
  - **Tokenizer:** explicit, set to tiktoken `cl100k_base` on both sides (Python Docling tokenizer wrapper and TS `tiktoken`), so chunk sizes match between parsers.
  - **OCR:** an engine with Chinese, English and Italian models. The researcher picks between EasyOCR, RapidOCR and Tesseract, based on Chinese quality and image size. Languages are configured from the profile, default `zh, en, it`.
  - **Table chunks:** every table chunk repeats its header row. On the LlamaParse path the TS table-aware chunker does the same for markdown tables.
  - **Tests:** a fixture assertion checks the header row on every table chunk.
- **D-23:** Docling runs in CI and tests from recorded Docling outputs by default: committed `ParseResult` and Docling JSON fixtures for the table PDF, the scanned zh/en/it PDFs, the invoice PDFs and the PDF with images, served by a fake sidecar.
  - **Contract tests:** these check that the sidecar's adapter converts a recorded `DoclingDocument` into the same `ParseResult`.
  - **Optional real run:** a nightly CI job installs the `docling` extra and runs real Docling on the fixture PDFs. It is skipped with a notice when the extra cannot install.
  - **Fixture PDFs:** produced by a committed, deterministic generator script, so no binary of unknown origin is committed.

#### Chunking and section paths
- **D-24:** Every chunk carries `section_path` (the heading hierarchy, outermost first; for example `["第三章 合同条款", "第5条 适用范围"]`). Sources:
  - **Docling:** `headings[]`.
  - **LlamaParse and text paths:** the markdown heading stack.
  - **Legal profile:** the clause heading.

  Two texts are built per chunk:
  - **`embedding_text`:** `" > ".join(section_path) + "\n\n" + content`, plus the type template from the profile (for example an invoice number and supplier header). It is built deterministically from stored columns by a versioned template, recorded as `embedding_text_version`, and never stored as a separate column. EMB-04 re-embeds by rebuilding it from stored chunk text.
  - **`lexical_text`:** the same prefix plus content, normalized by the shared tokenizer (D-31).

  The LLM-facing `content` stays plain chunk text, with no path prefix and no `Document: X. Chunk n of m` prefix. This fixes `document-processor.ts` dropping `section` and `subsection`.

  **Reversibility:** costly. Every stored vector depends on the template version.
- **D-25:** The `legal_clauses` chunker recognizes clause headings with patterns stored as data in the profile:
  - `第[一二三四五六七八九十百零〇\d]+条`
  - `^\d+(\.\d+)*[.)]?\s`
  - `^[（(][一二三四五六七八九十]+[)）]`
  - `^Art\.?\s*\d+`
  - `^Articolo\s+\d+`
  - `^Article\s+\d+`

  It keeps a whole clause in one chunk when it fits `max_tokens`. That includes an exception lead-in (`但以下情况除外：`, `except as follows:`, `salvo quanto segue:`) together with its list. An over-long clause is split at item boundaries, and every piece carries the clause heading in `section_path` and in its first line. The contract fixture gains the "exceptions to this clause" item: the golden item's quote spans the whole exception list, and it must be retrieved as one chunk.

#### Invoices and exact identifiers
- **D-26:** Invoice extraction runs in the sidecar, at `POST /v1/extract/invoice`. It takes the parse markdown and tables and returns a Pydantic `InvoiceFields`:
  - `invoice_number`
  - `issue_date`, `due_date`
  - `supplier`: name and VAT/tax id
  - `buyer`: name and VAT/tax id
  - `currency`
  - `net_total`, `tax_total`, `gross_total`
  - `line_items[]`: description, quantity, unit price, amount, tax rate
  - `confidence`, `errors[]`

  Extraction is deterministic first:
  - zh/en/it label dictionaries
  - date parsing for `YYYY年M月D日`, `DD/MM/YYYY` and ISO dates
  - amount parsing with `,`/`.` locale handling
  - tax-ID validators: Italian Partita IVA with checksum, Chinese 统一社会信用代码 with its 18-character checksum, and generic EU VAT

  An optional LLM fill-in for missing fields sits behind `RAG_INVOICE_LLM_EXTRACT` (default `false`), with Pydantic-validated structured output and a recorded fake.

  On failure, the document is still ingested as plain text. `metadata.invoice_extraction = {status: 'failed', errors}` records it, and the error is logged and shown in the Config UI document list.
- **D-27:** Invoice storage:
  - **Promoted `documents` columns:** `invoice_number`, `supplier_name`, `supplier_tax_id`, `issue_date` (also `doc_date`), `gross_total`, `currency`.
  - **Btree indexes:** `(tenant_key, invoice_number)`, `(tenant_key, supplier_tax_id)`, `(tenant_key, issue_date)` and `(tenant_key, gross_total)`.
  - **Full field set:** in `documents.metadata.invoice`.
  - **Chunks:** the header block and the line-item table with its header stay in one `invoice_header` or `table` chunk. The invoice number and tax IDs are placed in `section_path`, the embedding text and `lexical_text`.
  - **Query helper:** `findInvoices(scope, { supplier?, dateRange?, amountRange?, currency? })` under `@/lib/rag` provides Phase 3's filtering. Phase 4's DATA-08 filters reuse these columns.
- **D-28:** For exact invoice-number questions, a new optional pipeline stage, `exact_id_lookup`, runs behind `RAG_EXACT_ID_LOOKUP` (default `false`). It extracts identifier-shaped tokens from the query: invoice-number shapes, the tax-ID validators of D-26, and model-number shapes. It looks them up on the promoted columns within `TenantScope`, and adds the matching current document's chunks to the candidates ahead of the vector results, with `match_reason: 'exact_id'`.

  With the switch off, nothing changes. The stage is optional (it skips on failure) and is recorded in the trace. Phase 4's hybrid lexical search may later replace it after eval.

#### PDF images
- **D-29:** Images inside PDFs come from Docling `pictures[]` or the LlamaParse image list, which `process-document` already extracts. Images smaller than a minimum area (default 0.02 of the page), or above a per-document cap (default 30), are skipped.

  Each kept image is:
  1. stored in tenant-scoped storage
  2. captioned by the existing image-RAG captioning (the same function `processImageDocument` uses today)
  3. written as an `image` chunk of the same document and version, with `page_start`, `metadata.image_url`, `section_path` from the enclosing heading, and the caption as `content`

  `source_images` streaming is unchanged, because it reads `metadata.image_url`. A fixture test asserts:
  - the image chunk's page number
  - that the image chunk streams as `source_images` through the chat characterization harness

  Behind `RAG_PDF_IMAGE_CHUNKS` (default `false`). Captioning in tests uses a recorded fake.

#### Prompt-injection quarantine
- **D-30:** Injection rules are data in `config/rag/injection-rules.json`, validated by a Pydantic `InjectionRuleSet` with entries `{id, language, pattern, kind: 'phrase' | 'regex', severity}`. Matching runs on NFKC-normalized, case-folded text. The starting phrases cover zh, en and it, for example:
  - 忽略之前的指令
  - 忽略以上所有
  - 你现在是
  - ignore previous instructions
  - disregard the above
  - you are now
  - system prompt
  - ignora le istruzioni precedenti
  - ora sei
  - dimentica le istruzioni

  The `scan_injection` stage runs after parsing, on the full text and on image captions. Switch `RAG_INJECTION_SCAN=off|quarantine`, default `off`. With `quarantine`, a match sets the document's and its chunks' `status = 'quarantined'` and records the matched rule ids and up to three short snippets in `metadata.quarantine`. Chunks are still written, so a release needs no reprocessing. Phase 5.1's SEC-03 reuses this rule file and matcher at retrieval time.
- **D-31:** D-08 excludes quarantined rows from every retrieval, with no switch. Release and delete happen in a new Config UI panel, "Quarantine", through:
  - `GET /api/rag/admin/quarantine`
  - `POST /api/rag/admin/quarantine/{id}/release`
  - `DELETE /api/rag/admin/quarantine/{id}`

  A release flips the status to `ready` through the D-11 publish function, and is recorded with the admin id and time. All `/api/rag/admin/*` routes require a Supabase session whose user is in `admin_users`, and fail closed (403) otherwise. Pre-existing unauthenticated config routes stay out of scope.

  A fixture test checks that each of the zh, en and it injection documents:
  - is quarantined
  - is absent from every retrieval profile (chat, embed, voice, media, eval)
  - appears in retrieval after release

#### Lexical text (seam for Phase 4)
- **D-32:** `lexical_text` is produced by a shared tokenizer module, `src/lib/rag/lexical/tokenize.ts`:
  - **zh:** `Intl.Segmenter` word segmentation.
  - **en and it:** whitespace and punctuation split, lowercase, diacritics folded.
  - **Identifiers:** tokens such as invoice numbers and model numbers are kept verbatim.

  The output carries a `LEXICAL_VERSION`. This settles the research conflict in favor of one application tokenizer (ARCHITECTURE and PITFALLS) over PGroonga. Phase 4 owns the index, the query side and the Chinese exact-term test (RET-03), and can rebuild `lexical_text` from stored chunk text if it bumps the version.

  **Reversibility:** reversible. The text can be rebuilt from stored columns.

#### Embedding profiles
- **D-33:** Embedding providers live under `src/lib/rag/embeddings/`, which extends the Phase 2 `embeddings/openai.ts` (`embedText` / `embedBatch`). The interface is `EmbeddingProvider`, with:
  - `id`
  - `embedDocuments(texts, {signal})`
  - `embedQuery(text, {signal})`
  - `maxInputTokens`
  - `supportedDims`
  - `normalize`

  The three providers:
  - **OpenAI:** `text-embedding-3-small`, kept.
  - **Voyage:** `voyage-4-large` over HTTP, `input_type: 'document' | 'query'`.
  - **Qwen3-Embedding-8B:** OpenAI-compatible HTTP, with DeepInfra primary and OpenRouter fallback, the query-side instruction prefix (`Instruct: …\nQuery: `) only on queries, MRL truncation to the profile dims, and L2 re-normalization after truncation.

  New secrets go in the five config locations with placeholder values only: `VOYAGE_API_KEY`, `DEEPINFRA_API_KEY` (OpenRouter's key exists). The researcher confirms exact model ids, the dimension parameter, and how instruction prefixes and `input_type` are handled. Live checks are listed in the ROADMAP.
- **D-34:** Starting profiles:

  | Profile | Provider | Dims | Storage | Notes |
  |---|---|---|---|---|
  | `openai-3-small-1536` | OpenAI | 1536 | `vector` | Legacy. Stays in the existing `document_chunks.embedding vector(1536)` column with its existing HNSW index, so legacy retrieval is untouched. |
  | `voyage-4-large-2048` | Voyage | 2048 | `halfvec` | |
  | `qwen3-8b-2048` | Qwen3 | 2048 | `halfvec` | MRL-truncated. The full 4096 dims exceed the 4000-dim `halfvec` HNSW limit. |

  The researcher may pick 1024 instead of 2048 on cost and quality evidence. Dims above 2000 always use `halfvec`, and the registry rejects more than 4000.
- **D-35:** Non-legacy profiles are stored in one table, `chunk_embeddings`:
  - **Columns:** `chunk_id` FK with cascade, `profile_id`, `tenant_key`, `embedding halfvec` without a fixed dimension, `embedding_model`, `dims`, `embedded_at`. The primary key is `(chunk_id, profile_id)`.
  - **Index:** one partial expression HNSW index per profile, `USING hnsw ((embedding::halfvec(<dims>)) halfvec_cosine_ops) WHERE profile_id = '<id>'`, with `m = 64` and `ef_construction = 200` as today.
  - **Model check:** the legacy column gains `embedding_model` and `embedding_dims` in chunk metadata (backfilled as `text-embedding-3-small` and 1536), so every vector row records its model (EMB-05d).
  - **RPC:** `match_chunks_by_profile(scope args, p_profile_id, p_dims, p_query halfvec, …)` uses the same tenant predicate as `match_documents_by_workspace` plus the D-08 filter. It is granted to the server role only, never to `anon`. The Phase 2 backend adapter picks the legacy RPC or this one from the active profile.

  Index builds on the real project are a live verification item, with a documented `maintenance_work_mem` setting and a note on pooler connections.

  **Reversibility:** costly. This is the storage layout every profile, Phase 7's sync and re-embed depend on.
- **D-36:** The registry is a table, `embedding_profiles`, with:
  - `id`, `provider`, `model`, `dims`
  - `storage`: `legacy_column | halfvec`
  - `status`: `available | backfilling | active | retired`
  - `activated_at`, `activated_by`, `previous_active_id`
  - `eval_evidence` jsonb

  Exactly one row is `active`, enforced by a partial unique index. Activation and rollback each run as one SQL function (`rag_activate_embedding_profile`, `rag_rollback_embedding_profile`) that flips `active` and records `previous_active_id`. Rollback re-activates the previous profile, whose vectors were never deleted.

  The flip is exposed through `npm run rag:embedding -- status|activate|rollback` and a Config UI "Embedding profiles" panel that uses authenticated admin routes. Switch `RAG_EMBEDDING_PROFILES=off|on`, default `off`. While `off`, the pointer is ignored and the legacy profile is used everywhere, which is today's behavior. The pointer is deployment-level ("per-tenant provider choice" is out of scope).

  **Reversibility:** reversible. Flipping back restores the previous profile.
- **D-37:** Query and index consistency (EMB-03):
  - **At startup:** a new `src/instrumentation.ts` `register()` hook loads the active profile and checks that its provider is configured (key present), and that the provider's model id and dims equal the profile's.
  - **On every request:** the embed stage asserts the returned vector length equals the profile dims, and the provider's model id equals the profile's `embedding_model`. This catches a same-dimension model swap.
  - **On mismatch:** a `[Embedding Profile] MISMATCH` error is logged with profile, model and dims, but no key values. Every retrieval then returns Phase 2 status `error` with reason `embedding_profile_mismatch`, so chat streams its "knowledge base temporarily unavailable" message and never runs a wrong-model search. The whole app is not crashed, because non-RAG features keep working.

  Tests cover both a dims mismatch and a same-dims model mismatch, using fake providers.

#### Re-embed job and activation gate
- **D-38:** `npm run rag:reembed -- --profile <id> [--dry-run] [--batch-size 128] [--tenant <key>] [--resume <runId>] [--rollback <runId>]` is a TS module under `src/lib/rag/ingest/reembed/`. `scripts/rag/reprocess-documents.js` keeps its existing mode and gains a `--reembed` mode that delegates to the TS module through `tsx`, so the script is extended rather than replaced.
  - **What it reads:** only stored chunk columns (content plus section path, rebuilt into the embedding text). It makes zero parser and zero sidecar calls, and a test asserts the fake parser and sidecar received no request.
  - **Progress:** recorded in `embedding_backfill_runs` (`id`, `profile_id`, `cursor_chunk_id`, counts, `status`, `started_at`, `updated_at`). Batches write with `ON CONFLICT (chunk_id, profile_id) DO UPDATE`, so a killed run resumes from its cursor without duplicates.
  - **Dry run:** reports chunk count, token count and estimated cost per tenant.
  - **Rollback:** deletes the run's target-profile rows. It is refused for the active profile.

  A test kills the job between batches, resumes it, and checks that it completes with every chunk embedded once.
- **D-39:** Dual-write. While any profile has status `backfilling`, the `embed` stage of `ingest()` writes the active profile and every backfilling profile for each new or replaced chunk. A test checks that a document uploaded mid-migration has vectors in both profiles. If a backfilling profile's provider fails during ingestion, the document still publishes on the active profile, and the chunk is recorded in `embedding_backfill_runs` as a gap the next re-embed pass fills, so it is never silently missing.
- **D-40:** The activation gate (EMB-05). `rag_activate_embedding_profile` and the CLI refuse activation unless all of these hold:
  - **(b) Completeness:** zero current, ready chunks lack a row for the target profile, checked inside the same transaction as the flip.
  - **(c) Eval evidence:** an eval report in `eval_evidence` was produced on the target profile and passed the noise-band gate against the active profile's run. It must include a `pre_migration` slice, meaning gold documents ingested before the backfill run started, reported separately.
  - **(d) Model and dims:** every target row's `embedding_model` and `dims` equal the profile's.

  Each refusal names its failing condition. Tests cover each refusal and one successful activation followed by rollback.

#### Evaluation
- **D-41:** XLG-02 adds the golden category `cross_lingual`.
  - **Contracts:** the Pydantic `Category` enum, an optional `evidence_language` on `GoldenItem` (validated against the corpus document's language), regenerated Zod, and the Phase 2 D-25 baseline rules.
  - **Fixture items:** at least 4 approved synthetic items per direction pair (en→zh, it→zh, zh→en, it→en, zh→it, en→it), with span gold evidence quoted in the source document's language.
  - **Corpus:** new fixture documents are added only if existing ones cannot carry four questions per pair.
  - **Reports:** `by_language_pair` for this category.
  - **Gate:** the slice and each pair are gated like the language slices. The fixture is deterministic, so spread is 0 and the 0.02 floor applies.
  - **Baseline:** the category's baseline is recorded under `RAG_PIPELINE=legacy` with the legacy profile, and paired differences on pre-existing items must be zero.
- **D-42:** Two fixture modes in the eval harness:
  - **`prechunked`:** today's corpus loader, the default. It keeps the Phase 1 and Phase 2 baseline and parity.
  - **`ingest`:** the fixture corpus plus the new typed fixtures (table, scans, contract, invoices, PDF with images, injection documents) run through the real `ingest()` against PGlite, with the fake sidecar, fake LlamaParse, fake captioning and fake embedding providers.

  The `ingest` mode records its own baseline. Phase 3's success criteria 1–4, 6, 7 and 9 are shown in this mode. Gold spans match by quote, so chunk changes do not invalidate items (Phase 1 D-13).
- **D-43:** Per-profile comparison. `npm run test-rag -- --embedding-profile <id>` runs the gate per profile. Fakes extend the Phase 1 fixture embedder (deterministic hashed n-grams) to any dims, and a fake Voyage endpoint and a fake OpenAI-compatible Qwen endpoint are added to the fake edge.
  - **Report:** an `embedding-profile-comparison` report lists overall, per language and per cross-lingual pair metrics for each profile against `openai-3-small-1536`, plus the default-candidate rule (a multilingual profile must beat it on the `cross_lingual` slice).
  - **Limits of the fixture run:** fake embedders are not multilingual, so the fixture run proves the mechanism and gate wiring only. The real ranking decision is the ROADMAP live verification run, and it is recorded in `eval_evidence`.

#### Config, endpoints and observability
- **D-44:** New env vars and defaults, each mirrored in the five config locations and marked `managed` in `scripts/rag/env-manifest.json`. Secrets get placeholder values only. `check-config` must pass.

  | Variable | Default |
  |---|---|
  | `RAG_INGEST_PIPELINE` | `legacy` |
  | `RAG_PARSER` | `llamaparse` |
  | `RAG_PARSE_POLL_BUDGET_MS` | `45000` |
  | `RAG_DOC_TYPE_LLM_DETECT` | `false` |
  | `RAG_INVOICE_LLM_EXTRACT` | `false` |
  | `RAG_EXACT_ID_LOOKUP` | `false` |
  | `RAG_PDF_IMAGE_CHUNKS` | `false` |
  | `RAG_INJECTION_SCAN` | `off` |
  | `RAG_EMBEDDING_PROFILES` | `off` |
  | `VOYAGE_API_KEY` | empty |
  | `VOYAGE_BASE_URL` | the Voyage API default |
  | `DEEPINFRA_API_KEY` | empty |
  | `DEEPINFRA_BASE_URL` | the DeepInfra OpenAI-compatible default |
  | `RAG_QWEN_EMBED_FALLBACK` | `openrouter` |

  Embedding model ids live in `embedding_profiles` rows and the provider registry, not in the model lists covered by the five-location sync rule, because they are not chat models.
- **D-45:** New app endpoints. All are authenticated, take `TenantScope` or `admin_users`, validate with Zod (`zod/v3`) and return structured JSON errors.

  | Route | Access | Purpose |
  |---|---|---|
  | `GET /api/rag/doc-type-defaults` | session | resolve the picker default |
  | `PUT /api/rag/admin/doc-type-defaults` | admin | set defaults |
  | `GET /api/rag/ingest/{id}` | owner | ingestion status |
  | `POST /api/rag/ingest/{id}/resume` | owner | resume stages |
  | `POST /api/rag/admin/documents/{id}/doc-type` | admin | change type |
  | `/api/rag/admin/quarantine` (list, release, delete) | admin | quarantine panel |
  | `/api/rag/admin/embedding-profiles` (list, activate, rollback) | admin | profiles panel |

  The Config UI gets three panels: "Document types" (defaults), "Quarantine" and "Embedding profiles". They call these routes through `config-server.js`'s existing Authorization forwarding.
- **D-46:** Each `ingest()` run produces one Langfuse ingestion trace, with one span per D-02 stage. Each span carries `parser_used`, pages, chunk count, doc type and origin, fallback reason, and dedup or quarantine outcome. The trace uses Phase 2's collector, sampling and masking, and falls back to a single `[Ingest Trace]` log line. Logs use the `[Ingest]` and `[Embedding Profile]` prefixes. No document text is logged.
- **D-47:** Rollout order inside the phase:
  1. migrations plus the D-08 filter, proven by legacy parity (paired differences zero)
  2. contracts (`ProcessingProfile`, `ParseJobRequest`/`ParseResult`, `InvoiceFields`, `InjectionRuleSet`, `DocTypeDetection`, golden `cross_lingual`)
  3. `XLG-02` items and the legacy baseline
  4. the `ingest()` core with the chunk writer, dedup and versioning
  5. one write path per plan (process-document, image upload, Nango, scrapers, `ai-to-rag`)
  6. the sidecar Docling job and the fallback chain
  7. section paths and the legal chunker
  8. invoices and the exact-ID stage
  9. PDF images
  10. the injection scan and quarantine UI
  11. the doc-type picker, defaults and type change
  12. embedding providers, then profile storage and pointer, then the startup check
  13. the re-embed job, dual-write and the activation gate
  14. per-profile comparison
  15. the final legacy-parity and ingest-mode gates

### Claude's Discretion

- File layout inside `src/lib/rag/ingest/` beyond the paths named above.
- Exact keyword lists for auto-detect and the injection starter rules, beyond the examples given. They must be synthetic, never customer text.
- Localized labels for doc types and UI panels (zh/en/it).
- Image size and count thresholds (D-29) and the parse poll backoff schedule.
- Exact SQL function names, provided they keep the semantics in D-11, D-35, D-36 and D-40.

### Deferred Ideas (OUT OF SCOPE)

- **Editing processing profiles in the Config UI** (parser options, extractors). This is OPS-03 (v2). Phase 3 makes only the defaults editable.
- **Document version-history UI.** This is UX-06 (v2). Phase 3 keeps old versions, but the UI shows only the current one.
- **Chat filter chips for doc type, date and source.** This is UX-05 (v2). Phase 3 provides the columns, and Phase 4 adds the retrieval filters.
- **Removing the legacy writers and the `RAG_INGEST_PIPELINE` switch.** This happens after Phase 7 sets the release defaults.
- **Replacing `exact_id_lookup` with Phase 4 hybrid lexical search** once eval shows lexical search covers exact invoice numbers.
- **LLM-based doc-type detection or invoice extraction as the default.** This needs eval evidence on real documents first.
- **Per-tenant embedding profiles.** This is out of scope ("per-tenant provider choice").
- **Garbage collection of superseded versions and their originals** (a retention policy). This belongs in the backlog. Citations need the old rows for now.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| DATA-01 | One shared `ingest()` path and chunk writer for chat/Config UI uploads, Nango sync, scrapers and image uploads | Write-path inventory (7 call sites), Pattern 1 (stage runner), Pattern 2 (SQL-function writer), boundary-check rules |
| DATA-02 | Same chunk metadata on every path, URL metadata kept | Schema plan, `rag_write_chunks` contract, URL metadata fields quoted from today's writers |
| DATA-03 | Per-file doc-type picker with a pre-selected default | `resolveDocType()` order, picker call sites (`unified-upload-button.tsx`, Config UI L12878), finding F-10 (detect before or after parse) |
| DATA-04 | Processing profiles as data | Profile schema notes, token-budget semantics verified against HybridChunker, lint rule for `doc_type ===` |
| DATA-05 | Docling async parse job, HybridChunker with repeated table headers, explicit tokenizer, OCR zh/en/it, LlamaParse switch and fallback | Docling 2.152.0 findings F-3, F-4, OCR decision, LlamaParse v2 adapter, Pattern 4 |
| DATA-06 | No duplicate chunks for the same normalized content hash in a tenant, never across tenants | Hash normalization rule, `rag_begin_document_version` lookups filtered by `tenant_key`, two-tenant tests |
| DATA-07 | Atomic version swap, old version kept for citations | `rag_publish_document_version` verified in PGlite, finding F-9 (drop superseded vectors) |
| DATA-09 | Invoice fields (Pydantic), line-item table in one chunk, exact terms, filters | `python-stdnum` validators verified, promoted columns, `findInvoices`, `exact_id_lookup` stage |
| DATA-10 | Admin default types with precedence, type change re-processes as a new version | `rag_doc_type_defaults`, artifact reuse rule, re-chunk without a parser call through `json_docling` input |
| DATA-11 | PDF images as captioned image chunks with page numbers that stream as `source_images` | Docling `pictures`, LlamaParse v2 `items[type=image]`, storage decision (public `chat-images` path) |
| EMB-01 | Switchable providers: OpenAI, Voyage `voyage-4-large`, hosted Qwen3-Embedding-8B | Provider facts (endpoints, ids, dims, `input_type`, instruction format), Pattern 5 |
| EMB-02 | Side-by-side profiles, `halfvec`, partial HNSW per profile, pointer flip with rollback | Verified in PGlite: partial expression HNSW on dimensionless `halfvec`, 4,000-dim limit, activation functions |
| EMB-03 | Query model derived from the active profile, loud mismatch at startup and per request | `instrumentation.ts` facts, RPC-side dims and status checks, stale-pointer pitfall |
| EMB-04 | Re-embed job: stored text only, batched, resumable, dry-run, rollback | Pattern 8 (keyset cursor plus sweep), zero-parser assertion design |
| EMB-05 | Activation gate: dual-write, 100% coverage, eval evidence with pre-migration slice, model/dims recorded | Gate SQL, sweep phase, per-profile score calibration (F-7) |
| CHK-01 | `section_path` on every chunk, prefixed into embedding text and `lexical_text`, not the LLM text | Docling heading finding (flat levels unless enabled), markdown heading stack, embedding-text template |
| CHK-02 | Clause-aware legal chunker | Pattern 10, fixture design |
| SEC-01 | Ingestion injection scan with rules as data, quarantine, admin release/delete | Pattern 11 (normalization and ReDoS limits), D-08 filter placement, admin route helper |
| XLG-02 | `cross_lingual` golden category, legacy baseline, per-pair report | Corpus analysis (parallel documents trap), contract changes, fixture-embedder expectation |
</phase_requirements>

## Summary

Phase 3 is mostly integration work on top of contracts that Phase 2 is still building. Phase 2 was executing in the same working tree during this research: at the start `src/lib/rag/` did not exist, and by the end plans 02-01..02-07 and 02-30..02-35 had summaries and the tracer skeleton from 02-07 was on disk (`index.ts`, `types.ts`, `deps.ts`, `pipeline.ts`, `tenant/scope.ts`, `tenant/eval.ts`, `backend/supabase-rpc.ts`, `embeddings/openai.ts`, `legacy/`, `query/`) [VERIFIED: `find src/lib/rag -type f` this session]. The stage runner and trace collector (02-08), the resolvers (02-10), the ingestion embedding re-route (02-19) and the boundary check (02-20) are still plans. The section "Phase 2 contracts as they exist now" quotes what is on disk; everything else targets the planned signatures, and every Phase 3 plan must declare a dependency on the Phase 2 plan that creates the file it extends.

Three groups of findings change how the phase should be planned. First, the committed schema and today's writers disagree: the `documents.source` CHECK rejects the values `'nango'` and `'scrape'` that the Nango adapter and the scraper write, single-tenant tables have no `user_id` or `chunk_index`, the `chat-attachments` bucket the upload route writes to is created by no setup file, and the fake PostgREST edge supports no writes at all. A unified writer built as Postgres functions (called through `.rpc()`) solves the transaction, idempotency, single-tenant/multi-tenant and test-harness problems at once, and a pair of triggers keeps the still-default legacy writers valid after the migration. Second, the Docling details matter: with the default table serializer `repeat_table_header=True` repeats nothing visible, PDF headings are all level 1 unless heading-hierarchy inference is switched on, RapidOCR's PP-OCRv6 model is the only engine that reads Chinese, English and Italian with one model in one pass, and `HybridChunker` cannot even be imported with the `chunking-openai` extra alone. Third, the embedding side has two traps that pgvector will not catch for us: a `halfvec(n)` typmod cannot be a function parameter (the RPC needs dynamic SQL with dims read from the registry), and a filtered HNSW scan silently returns too few rows (measured here: 1 of 15 for a tenant holding 5% of the rows) unless iterative scans are on and superseded vectors are removed from the index.

All vendor facts were checked against current sources: Docling 2.152.0 (released today), LlamaParse API v2 (v1 still served), `voyage-4-large` (1024 default, 2048 max, `input_type`), Qwen3-Embedding-8B on DeepInfra and OpenRouter (4096 native, MRL, `Instruct: …\nQuery:` format without a trailing space), pgvector limits (2,000 `vector`, 4,000 `halfvec`) and Supabase Storage (ASCII-only object keys, no uploads without policies, service key bypasses RLS).

**Primary recommendation:** Build the ingest writer as `SECURITY DEFINER` SQL functions granted only to `service_role`, driven by a resumable TypeScript stage list with a per-request deadline; run Docling 2.152.0 in a sidecar process pool with RapidOCR PP-OCRv6, a Markdown table serializer and heading-hierarchy inference; call Voyage, DeepInfra and OpenRouter with plain `fetch` (no new npm packages); store non-legacy vectors in `chunk_embeddings` with one partial expression HNSW index per profile and search them through a dynamic-SQL RPC that validates profile status and dims inside the database.

### Findings that need an orchestrator decision

These do not reopen a locked decision's intent, but each one contradicts a detail in CONTEXT.md or adds something the decision needs to work. They are repeated in the summary returned to the orchestrator.

| # | Finding | Evidence | Recommended adjustment |
|---|---------|----------|------------------------|
| F-1 | The committed `source` CHECK rejects values today's code writes, and after D-06 replaces the CHECK the legacy writers (still the default) would violate the new one with `'upload'`, `'nango'`, `'scrape'` | PGlite run of both setup files this session: `new row for relation "documents" violates check constraint "documents_source_check"` on `source='nango'`; writers quoted in the write-path inventory | Add BEFORE INSERT triggers that normalize legacy `source` values and fill `lineage_id`, `source_key`, chunk `tenant_key`; discover and drop whatever CHECK exists on `source` by catalog lookup; run a source-value inventory on the live project before migrating |
| F-2 | Supabase Storage object keys are ASCII-only, so the NFKC filename cannot be the storage key for Chinese or accented Italian filenames (D-10, D-18) | `VALID_OBJECT_KEY = /^[A-Za-z0-9_/!.*'() &$=@;:+,?-]*$/` in supabase/storage `src/storage/limits.ts` | Keep `source_key` as the logical path; store originals at `rag-originals/<tenant_key>/<lineage_id>/<version>/original.<ext>` and record that key in `original_path` |
| F-3 | `repeat_table_header=True` shows no header row with Docling's default (triplet) table serializer | Ran `HybridChunker` 2.108.0 on a 40-row table: default chunks start with `\| - \|`; with `MarkdownTableSerializer` every chunk starts with the header and separator rows | The sidecar passes a serializer provider that uses `MarkdownTableSerializer` (how, not a decision change) |
| F-4 | The D-20 route table has no way to return picture bytes or the Docling JSON that D-18 stores | `ParseResult.pictures[].image_ref` is a reference; the sidecar is stateless toward Supabase | Add `GET /v1/parse/jobs/{id}/artifacts/{name}` (same auth, same TTL). Add optional `text_layer_page_share` to `ParseResult` for D-16 |
| F-5 | Qwen3 query format in D-33 has a trailing space after `Query:`; the model card has none | Model card served by DeepInfra: `return f'Instruct: {task_description}\nQuery:{query}'` | Use the model-card format exactly; record the instruction text in the profile row |
| F-6 | D-19 names `LLAMACLOUD_API_KEY`; the variable is `LLAMA_CLOUD_API_KEY` | `src/lib/env.ts:112` | Use the existing name; add no new variable |
| F-7 | Legacy similarity thresholds (0.7, 0.65, 0.28, 0.25) are tuned to `text-embedding-3-small`; another model's score scale changes refusal behaviour, which confounds the EMB-05(c) gate | `src/lib/enhanced-rag-retrieval.ts` L210, L366; `src/lib/rag-eval/legacy-post-filter.ts` L105 | Add `score_calibration` jsonb to `embedding_profiles` (legacy row = today's constants); the comparison report also scores threshold-free candidate Recall@k and MRR |
| F-8 | `match_chunks_by_profile(…, p_dims, …)` cannot use `p_dims` as a type modifier | PGlite: `invalid input syntax for type integer: "p_dims"` | The function reads dims from `embedding_profiles`, builds the query with `format()`, and treats `p_dims` only as a cross-check that raises `embedding_profile_mismatch` |
| F-9 | Superseded versions' vectors stay in the HNSW index and starve filtered scans | PGlite: filtered top-15 returned 1 row with `hnsw.iterative_scan = off` | `rag_publish_document_version` keeps old chunk rows (citations resolve) but sets their legacy `embedding` to NULL and deletes their `chunk_embeddings` rows; the new RPC sets `hnsw.iterative_scan = relaxed_order` when pgvector >= 0.8.0 |
| F-10 | The doc type selects parser options, but keyword auto-detect needs parsed text (D-02 order, D-16) | Stage order in D-02 | Two-step detection: pre-parse signals in `identify`, refinement after `parse`, at most one re-parse when the refined profile's parser options differ |
| F-11 | "docx and html through the existing extractors" (D-19 step 3): no such extractors exist in the app | `package.json` has no `mammoth`, `cheerio`, `turndown` or `html-to-text`; both formats go through LlamaParse today | Plain-text fallback covers txt, md and csv only; Docling parses DOCX and HTML; scrapers request Markdown from Firecrawl and skip parsing |
| F-12 | The 45 s parse budget leaves about 15 s of Vercel's 60 s for chunk, embed, caption and write | `vercel.json` `maxDuration: 60`; up to 30 GPT-4o captions per document (D-29) | `ingest()` takes one request deadline; every stage checks remaining time and returns `processing`; `resume` continues from the last completed stage |
| F-13 | The implemented `TenantScope` has no `tenantKey` field, and scope ids are not lowercased | `src/lib/rag/tenant/scope.ts` (quoted in "Phase 2 contracts as they exist now") | Use `scopeKey(scope)`; lowercase ids at mint time; keep `mintScope` the only restricted export so ingest can import `scopeKey` |

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Scope resolution for each write path | API / Backend (`src/lib/rag/tenant/`) | — | Only the tenant module may mint a `TenantScope` (Phase 2 D-07); ingestion never sees a raw user id |
| Stage orchestration, dedup decisions, chunking of Markdown, section paths, lexical text | API / Backend (`src/lib/rag/ingest/`) | — | TypeScript owns the pipeline (D-01, D-02); Phase 3.1's worker reuses the same stage functions |
| PDF parsing, OCR, table structure, Docling chunking, invoice extraction | Python sidecar | — | CPU-bound and Python-only; exceeds Vercel limits (project constraint "Python sidecar") |
| LlamaParse upload and polling | API / Backend | — | Plain HTTPS; stays in the app as today |
| Chunk and version writes, version swap, quarantine status, activation gate | Database / Storage (SQL functions) | API / Backend (callers) | Needs one transaction per operation; supabase-js cannot span statements |
| Vector search per profile, tenant predicate, D-08 filter | Database / Storage (RPC) | — | The predicate must sit next to the index scan |
| Original files, parse output, PDF images | Database / Storage (Supabase Storage) | — | Private bucket for originals, existing public bucket for images |
| Embedding calls, MRL truncation, instruction prefix | API / Backend (`src/lib/rag/embeddings/`) | — | The boundary check allows provider calls only inside `src/lib/rag/` |
| Doc-type picker, quarantine, defaults and profile panels | Browser / Client and Config UI | API / Backend | UI only reads and posts; all decisions are server-side |
| Startup profile check | Frontend Server (`src/instrumentation.ts`) | Database | `register()` runs once per server instance |
| Fixture PDFs, recorded parse outputs, golden items | Eval harness (`eval/`) | Sidecar tests | No live service in CI |

## Standard Stack

### Core (Python, sidecar extra `docling`)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `docling[rapidocr]` | 2.152.0 | PDF/DOCX/HTML/image conversion to `DoclingDocument` | Locked by DATA-05. Version uploaded 2026-11-23, `requires_python <4.0,>=3.10` [VERIFIED: pypi.org/pypi/docling/json]. It is a meta-package over `docling-slim[standard]`; the `rapidocr` extra adds `onnxruntime` [VERIFIED: PyPI `requires_dist`] |
| `docling-core` | 2.108.0 | `HybridChunker`, `OpenAITokenizer`, `DoclingDocument` | Version resolved by docling 2.152.0 (`docling-core<3.0.0,>=2.108.0`) [VERIFIED: PyPI; installed and executed this session] |
| `rapidocr` | 3.10.0 | OCR engine (PP-OCRv6 multilingual) | See "OCR engine decision". Uploaded 2026-10-08 [VERIFIED: PyPI] |
| `onnxruntime` | 1.32.0 | RapidOCR inference backend | Docling's default RapidOCR backend is `onnxruntime` [VERIFIED: docling 2.152.0 `RapidOcrOptions.backend` default] |
| `tiktoken` | 0.14.0 | `cl100k_base` token counts in the sidecar | D-22. Same counts as the app's `tiktoken` npm package on zh/en/it samples (35/32/27 on both sides) [VERIFIED: executed this session] |
| `python-multipart` | 0.0.34 | FastAPI multipart upload for `POST /v1/parse/jobs` | FastAPI needs it for `UploadFile`; not in the sidecar today [VERIFIED: `rag-sidecar/pyproject.toml:6-11` lists only `"fastapi==0.165.0"`, `"uvicorn==0.54.0"`, `"httpx==0.28.1"`, `"pydantic>=2.14.4"`] |
| `python-stdnum` | 2.2 | Partita IVA, 统一社会信用代码 and EU VAT validation | See "Don't Hand-Roll". `stdnum.it.iva`, `stdnum.cn.uscc`, `stdnum.eu.vat` executed this session [VERIFIED] |
| `pypdfium2` | 5.15.2 | Text-layer share probe (D-16), transitive of Docling | BSD-3-Clause / Apache-2.0 [VERIFIED: PyPI]; the spec forbids PyMuPDF (AGPL) |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `docling-core[chunking-openai]` + `huggingface_hub` | 2.108.0 / 2.4.0 | Light extra `chunking` for adapter contract tests in default CI (no torch) | Installed in PR CI so the recorded-`DoclingDocument` → `ParseResult` tests run without the heavy `docling` extra |
| `reportlab` | 5.1.0 | Deterministic fixture PDF generator (D-23) | Dev/eval dependency only, never in the production image |
| `tiktoken` (npm) | ^1.0.22 (already installed) | Token counts in TS chunkers | Already a root dependency [VERIFIED: `package.json:109`] |
| `Intl.Segmenter` | Node 22 built-in (ICU 78.3) | Chinese word segmentation for `lexical_text` (D-32) | Verified working here; see pitfall P-12 on identifiers |

**No new npm runtime packages.** Voyage, DeepInfra, OpenRouter, LlamaParse v2 and the sidecar are called with `fetch`. D-33 specifies HTTP for all three providers, and the Phase 2 boundary check forbids embedding client packages outside `src/lib/rag/` anyway.

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| RapidOCR PP-OCRv6 | EasyOCR | No multilingual model: `ch_sim` shares a recognizer only with `en`, so Italian needs a second pass; last PyPI release 2024-09-24 [VERIFIED: PyPI; docling `EasyOcrOptions` docstring: "EasyOCR has no multilingual model -- list the languages explicitly"] |
| RapidOCR PP-OCRv6 | Tesseract (`chi_sim+eng+ita`) | True multi-language in one pass, but needs system packages and tessdata in the image and is never auto-selected by Docling [VERIFIED: docling `OcrAutoOptions` docstring]. Keep as the documented fallback if PP-OCRv6 fails live verification on Italian diacritics |
| `fetch` for Voyage/Qwen | `@ai-sdk/voyage`, `@ai-sdk/deepinfra` | Typed, but new dependencies under `legacy-peer-deps`, and D-33 already fixes HTTP |
| LlamaParse v2 | LlamaParse v1 (`/api/v1/parsing/…`) | v1 "remains available for the foreseeable future", but only v2 returns per-page Markdown, typed items (heading level, table rows, image with caption) and pinned tier/version [CITED: developers.llamaindex.ai/llamaparse/parse/guides/migration-v1-to-v2] |
| SQL-function writer | PostgREST table writes | Needs insert/upsert/update/delete in the fake edge, has no transaction, and cannot hide single-tenant/multi-tenant column differences |

**Installation (sidecar `pyproject.toml`):**

```toml
[project.optional-dependencies]
chunking = ["docling-core[chunking-openai]==2.108.0", "huggingface_hub==2.4.0", "tiktoken==0.14.0"]
docling = [
  "docling[rapidocr]==2.152.0", "docling-core[chunking-openai]==2.108.0",
  "tiktoken==0.14.0", "pypdfium2==5.15.2",
]
# base dependencies gain: "python-multipart==0.0.34", "python-stdnum==2.2"

[[tool.uv.index]]
name = "pytorch-cpu"
url = "https://download.pytorch.org/whl/cpu"
explicit = true

[tool.uv.sources]
torch = [{ index = "pytorch-cpu" }]
torchvision = [{ index = "pytorch-cpu" }]
```

The CPU index block is the documented uv pattern [CITED: docs.astral.sh/uv/guides/integration/pytorch/]. `uv sync --extra docling` matches D-20. `uv.lock` must be regenerated and committed; PR CI keeps running `uv sync --directory rag-sidecar --locked` plus `--extra chunking`.

**Version verification:** every version above was read from the PyPI JSON API on 2026-11-23. `docling-core[chunking-openai]`, `docling-slim[format-pdf,convert-core,feat-ocr-rapidocr]==2.152.0`, `huggingface_hub` and `python-stdnum==2.2` were installed into a scratch venv (Python 3.12) and exercised. A full `docling` install with torch and a real conversion were not run here, so real parsing and OCR stay live verification.

## Package Legitimacy Audit

`gsd-tools query package-legitimacy check --ecosystem pypi …` returned `SUS` for every package. The reasons are only `too-new` (the latest release is recent), `unknown-downloads` and `no-repository` (missing metadata in the seam's lookup), the same pattern Phase 1 recorded in its D-24.

| Package | Registry | First release | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|---------------|-----------|-------------|---------|-------------|
| `docling` | PyPI | 2024-07-15 | unknown to the seam | github.com/docling-project/docling [ASSUMED] | [SUS] too-new (2.152.0 published today), unknown-downloads, no-repository | Flagged |
| `docling-core` | PyPI | 2024-07-12 | unknown | same project [ASSUMED] | [SUS] too-new, unknown-downloads, no-repository | Flagged |
| `rapidocr` | PyPI | 2025-03-09 | unknown | github.com/RapidAI/RapidOCR [ASSUMED] | [SUS] unknown-downloads, no-repository | Flagged |
| `onnxruntime` | PyPI | 2018-09-21 | unknown | onnxruntime.ai | [SUS] too-new, unknown-downloads | Flagged |
| `tiktoken` | PyPI | 2022-12-15 | unknown | github.com/openai/tiktoken [ASSUMED] | [SUS] unknown-downloads, no-repository | Flagged |
| `python-multipart` | PyPI | 2013-03-26 | unknown | github.com/Kludex/python-multipart | [SUS] too-new, unknown-downloads | Flagged |
| `pypdfium2` | PyPI | 2021-12-03 | unknown | github.com/pypdfium2-team/pypdfium2 | [SUS] too-new, unknown-downloads | Flagged |
| `python-stdnum` | PyPI | 2010-09-11 | unknown | arthurdejong.org/python-stdnum | [SUS] unknown-downloads | Flagged |
| `reportlab` | PyPI | 2009-02-04 | unknown | reportlab.com | [SUS] unknown-downloads | Flagged |

**Packages removed due to [SLOP] verdict:** none.
**Packages flagged as suspicious [SUS]:** all nine. By the protocol the planner inserts a `checkpoint:human-verify` before each install. The orchestrator may instead apply the Phase 1 D-24 precedent (accept when the only reasons are release recency and missing download counts and the researcher installed and exercised the package); `docling-core`, `docling-slim`, `rapidocr`, `tiktoken`, `pypdfium2` and `python-stdnum` were installed and imported here. `docling`, `rapidocr`, `onnxruntime` and `tiktoken` are named by project decisions (DATA-05, D-22); `python-stdnum` and `reportlab` come from this research and are tagged `[ASSUMED]` as package choices until confirmed.

## Current Write-Path Inventory (what moves behind `ingest()`)

| # | Path | File and call | What it writes today | Scope source today | Under `unified` |
|---|------|---------------|----------------------|--------------------|-----------------|
| 1 | Chat upload and Config UI upload | `src/app/api/process-document/route.ts` `POST` → local `storeDocument` (L394–545) | Own LlamaParse upload (`https://api.cloud.llamaindex.ai/api/parsing/upload`, L204), chunk `content` prefixed with `Document: ${filename}. Chunk ${chunkPosition} of ${chunks.length}. Content: ` (L485), URL metadata, per-chunk embedding, batches of 10 that are skipped on error (partial documents) | Single-tenant: none. Multi-tenant: SSR session plus `organization_id` form field checked by `verifyUserOrganizationAccess` | `ingest({source: 'chat_upload' \| 'config_upload'})`; the two are told apart by a form field the Config UI proxy adds, because both hit the same route |
| 2 | Temporary chat attachment (`isTemporary=true`) | same route, L726–751 | Nothing; returns parsed text only | none | Not ingestion; stays on the legacy parse call and is outside `ingest()` |
| 3 | Image upload | `src/app/api/upload/route.ts` → `processImageDocument` (un-awaited, L174–195) | Public `chat-images` object, GPT-4o caption, one chunk with `metadata.image_url`, `source: 'upload'` | Session user only, always personal | `ingest({source: 'image_upload'})` inside `after()`; the un-awaited promise is not reliable on serverless |
| 4 | Nango sync | `src/lib/nango/sync-manager.ts`, five `processDocumentWithMetadata` call sites (L322, L473, L613, L1171, L1277; CONTEXT lists three) | `processDocument` → LlamaParse v1 → `storeDocument` in `supabase.ts` with `source: options.source \|\| 'nango'` | `connRecord.user_id`, always personal | `ingest({source: 'nango', sourceKey: file.id})` with a scope minted from the connection owner |
| 5 | Scraper | `src/lib/scrapers/scraper-adapter.ts` (`scrapeAndProcess`, `crawlAndProcess`) | HTML buffer through LlamaParse, `source: 'scrape'`, `source_file_id: normalizedUrl` | Route session plus verified `organizationId`; single-tenant passes `'single-tenant-user'` | `ingest({source: 'scraper', sourceKey: normalizedUrl, text: markdown})` with Firecrawl `formats: ['markdown']` |
| 6 | AI answer to knowledge base | `src/app/api/ai-to-rag/route.ts` | Own document and chunk inserts, no metadata on chunks | **Body `userId`, unverified** | `ingest({source: 'ai_to_rag', text})` with the session scope (D-01) |
| 7 | Reprocess script | `scripts/rag/reprocess-documents.js` | Deletes all chunks of every document and re-chunks with its own OpenAI client (model default `text-embedding-ada-002`) | service key | Keeps its mode (allow-listed), gains `--reembed`. Its destructive mode must refuse to run when any document has `version > 1` or a non-legacy profile exists, because it deletes cited chunk ids |

Related readers and deleters that must learn about versions: `src/app/api/documents/route.ts` and `documents/[id]/route.ts` (list, delete, `metadata.external_url` update), `src/app/api/images/route.ts`, `src/app/api/scrapers/status/route.ts`, `deleteOrphanedDocuments` in the Nango sync manager. Under `unified`, list queries filter `is_current`, deletes remove the whole lineage, and user-set document metadata (`external_url`) is copied forward to the new version by `rag_begin_document_version`.

Verbatim values the plans depend on:

- `source TEXT DEFAULT 'upload' CHECK (source IN ('upload', 'google-drive', 'notion', 'dropbox')),` [VERIFIED: `supabase/multi-tenant-setup.sql:163`, `supabase/single-tenant-setup.sql:30`]
- Nango writes `source: options.source || 'nango',` [VERIFIED: `src/lib/nango/document-adapter.ts:30`]; the scraper writes `source: 'scrape',` [VERIFIED: `src/lib/scrapers/scraper-adapter.ts:58`]; `storeDocument` defaults `source: source || 'upload',` and throws `'user_id is required to store a document'` [VERIFIED: `src/lib/supabase.ts:183-198`]
- `embedding vector(1536),` and `USING hnsw (embedding vector_cosine_ops)` `WITH (m = 64, ef_construction = 200);` [VERIFIED: `supabase/multi-tenant-setup.sql:207, 221-223`; `supabase/single-tenant-setup.sql:43, 59-60`]
- Single-tenant `documents` has columns `id`, `filename`, `content`, `metadata`, `organization_id`, `source`, `source_provider`, `source_file_id`, `source_connection_id`, `created_at` and no `user_id`; single-tenant `document_chunks` has no `chunk_index` [VERIFIED: `supabase/single-tenant-setup.sql:22-47`]
- Single-tenant RPC signature `match_document_chunks(query_embedding vector(1536), similarity_threshold double precision, match_count integer)` returning `chunk_id`, `document_id`, `content`, `similarity` [VERIFIED: `supabase/single-tenant-setup.sql:277-287`]; multi-tenant `match_documents_by_workspace(p_query_embedding vector(1536), p_match_count integer, p_min_similarity double precision, p_org_id uuid, p_user_id uuid)` with the predicate `(p_org_id IS NULL AND d.user_id = p_user_id AND d.organization_id IS NULL)` `OR` `(p_org_id IS NOT NULL AND d.organization_id = p_org_id)` [VERIFIED: `supabase/multi-tenant-setup.sql:692-730`]
- Buckets created by the setup files: `'chat-images'`, `'backgrounds'`, `'3d-models'`, `'chat-videos'` [VERIFIED: `supabase/multi-tenant-setup.sql:524-557`]. `const STORAGE_BUCKET = 'chat-attachments';` in the upload route is created nowhere [VERIFIED: `src/app/api/process-document/route.ts:16`]
- Env names: `LLAMA_CLOUD_API_KEY`, `RAG_SIDECAR_URL`, `RAG_SIDECAR_SECRET`, `OPENAI_EMBEDDING_MODEL` (default `'text-embedding-3-small'`), `LLAMACLOUD_PARSING_MODE` (default `'balanced'`) [VERIFIED: `src/lib/env.ts:112, 146, 164, 168-169`]
- Config drift discovery pattern: `const NAME_PATTERN = '(?:NEXT_PUBLIC_)?RAG_[A-Z0-9_]+|LLAMACLOUD_[A-Z0-9_]+|LANGFUSE_[A-Z0-9_]+|OPENAI_EMBEDDING_MODEL';` [VERIFIED: `scripts/check-config.mjs:16`]. `VOYAGE_*` and `DEEPINFRA_*` do not match, so the pattern must be extended in the env plan (as 02-03 did for `LANGFUSE_*`)
- Fake edge RPC allow-list has exactly `match_document_chunks` and `match_documents_by_workspace` [VERIFIED: `eval/harness/fake-edge.mts:26-35`], and its handler rejects every table request that is not a read: `if (method !== 'GET') throw new Rejection(405, ...)` [VERIFIED: `eval/harness/fake-edge.mts:293-294`]
- `Category = Literal["multi_turn", "compound", "exact_term", "table", "scanned", "no_answer", "general"]` [VERIFIED: `rag-sidecar/src/rag_sidecar/contracts/golden.py:8`]; plan 02-25 adds `colloquial`, `ambiguous`, `typo` before Phase 3 adds `cross_lingual`

## Phase 2 contracts as they exist now

Read from disk at the end of this research. Phase 2 is still executing, so the planner must re-read these files before writing plans.

- `TenantScope` has no `tenantKey` property (Phase 2 D-07 describes one). Its fields are `readonly kind: TenantScopeKind;`, `readonly userId: string | null;`, `readonly organizationId: string | null;` with `export type TenantScopeKind = 'single' | 'personal' | 'org';`. The key comes from `scopeKey(scope)`, which returns `'s:default'`, `` `o:${scope.organizationId}` `` or `` `u:${scope.userId}` ``. [VERIFIED: `src/lib/rag/tenant/scope.ts:3-10, 63-68`] Phase 3 uses `scopeKey(scope)` wherever CONTEXT.md says `tenant_key`.
- `scopeKey` is not exported from the public index, and `mintScope` is "Tenant-internal: the boundary check forbids importing this outside src/lib/rag/tenant and tests." [VERIFIED: `src/lib/rag/tenant/scope.ts:33`, `src/lib/rag/index.ts`] Ingest code lives inside `src/lib/rag/` and needs `scopeKey` and `assertTenantScope` (as `backend/supabase-rpc.ts` already imports `assertTenantScope, workspaceRpcArgs`), so the 02-20 rule must restrict `mintScope` only, not the whole module. New ingest scope resolvers (session, admin workspace, Nango connection owner, scraper job) go in `src/lib/rag/tenant/`.
- `mintScope` accepts UUIDs case-insensitively (`UUID_RE` has the `i` flag) and `scopeKey` returns the id as given, while SQL `organization_id::text` is always lowercase. See pitfall P-22. [VERIFIED: `src/lib/rag/tenant/scope.ts:22, 63-68`]
- `export type RetrievalStatus = 'ok' | 'empty' | 'error' | 'degraded';` and `RetrievalResult.reason: string`, so `error` with reason `embedding_profile_mismatch` (D-37) needs no type change. `Candidate.match_reason: string` accepts `'exact_id'` (D-28). `export type Profile = 'chat' | 'embed' | 'voice' | 'media' | 'eval';` [VERIFIED: `src/lib/rag/types.ts:4-18`]
- `vectorSearch(scope, embedding, matchCount, threshold, opts: { client: RpcClient; signal: AbortSignal })` calls `match_document_chunks` for `scope.kind === 'single'` and `match_documents_by_workspace` otherwise, mapping `id` to `chunk_id`. `RpcClient` is `rpc(fn: string, args: Record<string, unknown>): RpcRequest`. [VERIFIED: `src/lib/rag/backend/supabase-rpc.ts:18-20, 50-102`]
- `RagDeps` is `anonClient: () => RpcClient`, `adminClient: () => SupabaseClient | null`, `embedder: (text: string, opts: { signal: AbortSignal }) => Promise<number[]>`, `now`, `randomId`. The legacy RPCs run on the **anon** client. [VERIFIED: `src/lib/rag/deps.ts` read this session] `match_chunks_by_profile` is granted to `service_role` only, so the profile-aware backend path must use `adminClient`, and `embedder` must become profile-aware (a registry lookup) while keeping the single-function default for `RAG_EMBEDDING_PROFILES=off`.
- `embedText(text, { signal })` and `embedBatch(texts, { signal })` return only vectors (`Promise<number[]>`, `Promise<number[][]>`), batch size 100, model from `env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small'`. [VERIFIED: `src/lib/rag/embeddings/openai.ts` read this session] D-37's model assertion needs the response's `model` field and the dry run needs `usage`, so the OpenAI provider in the registry is a new function returning `EmbedOutput`; `embedText` and `embedBatch` keep their signatures for existing callers.

## Verified External Facts

### Docling 2.152.0 and docling-core 2.108.0 (installed and executed here)

- `HybridChunker` fields: `tokenizer: BaseTokenizer`, `repeat_table_header: bool = True`, `merge_peers: bool = True`, `omit_header_on_overflow: bool = False`, `always_emit_headings: bool = False`, `serializer_provider` (default `ChunkingSerializerProvider()`). There is no overlap parameter. [VERIFIED: `docling_core/transforms/chunker/hybrid_chunker.py` in the installed 2.108.0]
- `OpenAITokenizer(tokenizer=tiktoken.get_encoding("cl100k_base"), max_tokens=N)` lives in `docling_core.transforms.chunker.tokenizer.openai`. [VERIFIED: installed source]
- `max_tokens` bounds the **contextualized** text (heading path plus body), not the body alone: with `max_tokens=200`, every chunk's `contextualize()` output measured 175–199 tokens. [VERIFIED: executed]
- Header repetition is implemented in `segment()` only when the chunk holds exactly one `TableItem`, and it asks `table_serializer.get_header_and_body_lines()`. The default `ChunkingDocSerializer.table_serializer` is `TripletTableSerializer()`, whose base implementation returns no header lines. With `MarkdownTableSerializer` every table chunk begins with the header row and the `|---|` separator row. [VERIFIED: installed source and executed on a 40-row, 4-column table]
- `chunk.meta.headings` holds the heading stack including the title (`['2025 年度财务报告', '第三章 资产负债表', '3.1 流动资产']`), and pages come from `chunk.meta.doc_items[].prov[].page_no`. [VERIFIED: executed]
- Import trap: with only `docling-core[chunking-openai]`, `from docling_core.transforms.chunker.hybrid_chunker import HybridChunker` fails with `ModuleNotFoundError: No module named 'huggingface_hub'` (`line_chunker.py` imports the HuggingFace tokenizer module at import time). Adding `huggingface_hub` fixes it; `transformers` is not needed. [VERIFIED: executed, traceback observed]
- PDF headings: "The layout model only flags regions as `SECTION_HEADER` without a level, so every heading produced by the PDF path defaults to `level=1` and the document hierarchy is flattened." `PdfPipelineOptions.heading_hierarchy_options` (`HeadingHierarchyOptions(enabled=False, use_bookmarks=True, use_numbering=True, use_style=…)`) infers levels from bookmarks, numbering and font style when enabled. [VERIFIED: docling 2.152.0 `pipeline_options.py` docstring]
- `PdfPipelineOptions` defaults: `do_ocr=True`, `do_table_structure=True`, `table_structure_options.mode=TableFormerMode.ACCURATE`, `generate_picture_images=False`, `images_scale=1.0`, `document_timeout=None`, `ocr_options=OcrAutoOptions(...)`, `artifacts_path=None`. `OcrMode` values: `full_page`, `layout_regions`, `pdf_aware_layout_regions`, `default`. `ConversionStatus` values: `pending`, `started`, `failure`, `success`, `partial_success`, `skipped`. `InputFormat` includes `pdf`, `docx`, `html`, `md`, `csv`, `xlsx`, `pptx`, `image` and `json_docling`. [VERIFIED: introspected from the installed package]
- A timeout produces `PARTIAL_SUCCESS` ("Recommended: 90-120 seconds for production systems"), and the docstring warns that "RapidOCR has known issues with read-only filesystems". [VERIFIED: same file]

### OCR engine decision (D-22): RapidOCR with PP-OCRv6, onnxruntime backend

- RapidOCR "runs a single language per run; if more than one is given the first is used and the rest are ignored with a warning". [VERIFIED: docling `RapidOcrOptions.lang` description]
- "PP-OCRv6 recognition/detection are single multilingual checkpoints, so the default set already covers all ~52 v6 languages." [VERIFIED: docling `utils/model_downloader.py` comment] The installed rapidocr 3.10.0 reports 52 PP-OCRv6 recognition codes, including `ch`, `en` and `it`, all served by `multi_PP-OCRv6_rec_small`. [VERIFIED: `list_supported_langs(TaskType.REC, OCRVersion.PPOCRV6)` executed; `rapidocr/default_models.yaml`]
- Consequence: one model reads Chinese, English and Italian in one pass. The adapter validates that every language in the profile's `ocr_languages` is a PP-OCRv6 code and passes the first one (`["ch"]` for the default `zh, en, it`); a language outside the set is a configuration error, not a silent fallback.
- `OcrAutoOptions` selects, in order, "OcrMac on macOS, Nemotron OCR on Linux with CUDA, RapidOCR with onnxruntime, EasyOCR, and RapidOCR with torch". The sidecar sets `RapidOcrOptions(backend="onnxruntime", lang=["ch"])` explicitly instead of relying on auto-selection. [VERIFIED: docling docstring]
- Models are fetched from `modelscope.cn` URLs. [VERIFIED: `rapidocr/default_models.yaml`] They must be downloaded at image build (`docling-tools models download` into a fixed directory, then `artifacts_path`), because the container user has no home directory. [VERIFIED: `rag-sidecar/Dockerfile` `useradd --system --uid 10001 --no-create-home`]
- Chinese and Italian accuracy on real scans is not measured here. [ASSUMED: PP-OCR is strong on Chinese] It stays the ROADMAP live verification item, with Tesseract as the fallback engine.

### LlamaParse

- v2 endpoints: `POST https://api.cloud.llamaindex.ai/api/v2/parse/upload` (multipart fields `file` and `configuration`, a JSON string such as `{"tier": "agentic", "version": "latest"}`), `GET /api/v2/parse/{job_id}?expand=markdown,items,images_content_metadata`. `tier` (`fast`, `cost_effective`, `agentic`, `agentic_plus`) and `version` are required. Job status values: `PENDING`, `RUNNING`, `COMPLETED`, `FAILED`, `CANCELLED`; on GET the status is at `job.status`. [CITED: developers.llamaindex.ai/llamaparse/parse/guides/api-reference]
- Result shape: `markdown.pages[]` is `{markdown, page_number, success: true}` or `{error, page_number, success: false}`; `items.pages[].items[]` is typed (`heading {level, md, value}`, `table {rows, csv, html, md}`, `image {url, caption, md, bbox}`, `text`, `list`, …); `images_content_metadata.images[]` is `{filename, index, presigned_url?, content_type?, category?}` with no page number. The job object has no `version` field. [CITED: developers.llamaindex.ai/reference/resources/parsing/methods/get]
- "The v1 endpoint remains available for the foreseeable future. New features are v2-only." [CITED: migration guide]
- Recommendation: the `unified` LlamaParse adapter targets v2 (per-page Markdown gives `page_start`/`page_end`, items give heading levels and tables, image items give the page). The legacy code keeps its two v1 calls untouched. `LLAMACLOUD_PARSING_MODE` maps `fast → fast`, `balanced → cost_effective`, `premium → agentic`. `parser_version` is recorded as `llamaparse-v2/<tier>@<version>`. Failed pages set `partial = true`.

### Voyage `voyage-4-large`

- Endpoint `POST https://api.voyageai.com/v1/embeddings`; context 32,000 tokens; default dimension 1024; `output_dimension` one of 256, 512, 1024, 2048; `input_type` is `null`, `query` or `document`, which prepends "Represent the query for retrieving supporting documents: " or "Represent the document for retrieval: "; at most 1,000 texts and 120K tokens per request; `truncation` defaults to `true`; "All embeddings created with the 4 series are compatible with each other." [CITED: docs.voyageai.com/docs/embeddings]
- OpenRouter also lists `mongodb/voyage-4-large` at 0.00000012 USD per token (0.12 USD per million). [VERIFIED: `GET https://openrouter.ai/api/v1/embeddings/models`]
- Set `truncation: false` so an over-long input is an error instead of a silently truncated vector.

### Qwen3-Embedding-8B

- Model card: embedding dimension "Up to 4096, supports user-defined output dimensions ranging from 32 to 4096", context 32k, MRL support yes, instruction aware yes. Query format: `f'Instruct: {task_description}\nQuery:{query}'`, with the default task "Given a web search query, retrieve relevant passages that answer the query"; "No need to add instruction for retrieval documents"; "we also advise users to write their instructions in English". [VERIFIED: model card file served by DeepInfra for `Qwen/Qwen3-Embedding-8B`]
- DeepInfra: model id `Qwen/Qwen3-Embedding-8B`, OpenAI-compatible endpoint `https://api.deepinfra.com/v1/openai/embeddings`, `max_tokens` 32768, price `cents_per_input_token: 1e-06` (0.01 USD per million tokens). The OpenAI-compatible schema accepts `dimensions` ("If provided bigger than model's default, the embedding will be padded with zeros"), `input_type` (`query`, `passage`, `document`; "ignored by symmetric models") and `encoding_format` (`float`, `base64`). The native schema adds `normalize` (default `false`) and `custom_instruction`. [VERIFIED: `GET https://api.deepinfra.com/models/Qwen/Qwen3-Embedding-8B` and its `schema/openai-embeddings`, `schema/default`]
- OpenRouter: slug `qwen/qwen3-embedding-8b`, context 40960, 0.00000001 USD per token; endpoint `POST https://openrouter.ai/api/v1/embeddings`; the `provider` object (`order`, `allow_fallbacks`) applies. `dimensions` is not documented there. [VERIFIED: OpenRouter models API] [CITED: openrouter.ai/docs/api/reference/embeddings]
- Recommendation: never send `dimensions`, `input_type` or `custom_instruction`. Request the native 4096 dims from both hosts, build the instruction prefix in the app, truncate to the profile dims in the app and L2-normalize. This keeps DeepInfra and the OpenRouter fallback on the same code path. Residual risk: OpenRouter may route to a host with different quantization, so vectors can differ slightly between primary and fallback. [ASSUMED] Record the serving host on each `chunk_embeddings` row (`embedding_host`) and report the fallback share in the re-embed summary.

### Qwen3 dimension decision (D-34): keep `qwen3-8b-2048` for the first backfill, derive `qwen3-8b-1024` in SQL, choose by eval

- Storage per vector: `halfvec` 2048 = 4,104 bytes, `halfvec` 1024 = 2,056 bytes, today's `vector(1536)` = 6,152 bytes. [VERIFIED: `pg_column_size` in PGlite with pgvector 0.8.7] A 2048-dim `halfvec` profile is a third smaller than the existing legacy column, so the cost argument against 2048 is weaker than it looks; the real cost is that both indexes exist during a migration.
- Provider cost does not depend on the stored dimension, because truncation happens in the app.
- MRL makes the 1024 vector the first 1024 components of the 2048 vector, re-normalized. pgvector can derive it from stored rows with no provider call: `l2_normalize(subvector(embedding, 1, 1024))` works on `halfvec`. [VERIFIED: executed in PGlite]
- Decision: seed `voyage-4-large-2048` and `qwen3-8b-2048` as in D-34, and also seed `qwen3-8b-1024` and `voyage-4-large-1024` as `available`. Add a `--derive-from <profile>` mode to the re-embed job that fills a lower-dimension profile from stored vectors. The live eval then compares 1024 and 2048 for free, and the smaller one becomes the default candidate when it is inside the noise band of the larger. No quality number for 1024 against 2048 is available without live keys. [ASSUMED: the loss is small] Deriving the Voyage 1024 profile by truncation assumes Voyage's `output_dimension` is plain Matryoshka truncation. [ASSUMED] If that is wrong, the Voyage 1024 profile needs its own API backfill.

### pgvector and Supabase

- HNSW limits: `vector` up to 2,000 dimensions, `halfvec` up to 4,000. A dimensionless column with a partial expression index per model is the documented pattern: `CREATE INDEX ON embeddings USING hnsw ((embedding::vector(3)) vector_l2_ops) WHERE (model_id = 123);`. Iterative scans exist "Starting with 0.8.0" (`hnsw.iterative_scan = strict_order | relaxed_order`, `hnsw.max_scan_tuples` default 20,000); `hnsw.ef_search` defaults to 40. [CITED: github.com/pgvector/pgvector README, v0.8.7]
- Verified in PGlite (PostgreSQL 18.7, pgvector 0.8.7), the same engine the eval harness uses:
  - `CREATE INDEX … USING hnsw ((embedding::halfvec(2048)) halfvec_cosine_ops) WITH (m=64, ef_construction=200) WHERE profile_id = 'voyage-4-large-2048'` succeeds on a `halfvec` column without a dimension; 4096 fails with `column cannot have more than 4000 dimensions for hnsw index`; `vector(2048)` fails with `column cannot have more than 2000 dimensions for hnsw index`.
  - Inserting a 1024-dim vector under a 2048 profile fails with `expected 2048 dimensions, not 1024`, because the index expression casts it. The index is therefore also a dimension guard.
  - The planner uses the partial index when the query repeats the cast and a literal `profile_id`.
  - Filtered search: a tenant with 5% of 400 rows asked for 15 neighbours and got 1 with iterative scan off and 15 with `relaxed_order`.
- Supabase builds pgvector 0.4.0 through 0.8.2 for PostgreSQL 15 and 17. [VERIFIED: `nix/ext/versions.json` in github.com/supabase/postgres] Which version the user's project has installed is unknown; `halfvec` needs >= 0.7.0 and iterative scans need >= 0.8.0. Live check: `SELECT extversion FROM pg_extension WHERE extname = 'vector'`.
- PGlite runs PostgreSQL 18 while Supabase runs 15 or 17, so migrations must avoid features newer than 15 (no virtual generated columns, no `uuidv7()`).

### Supabase Storage

- "By default Storage does not allow any uploads to buckets without RLS policies." "Service keys entirely bypass RLS policies." Upsert additionally needs `SELECT` and `UPDATE`. [CITED: supabase.com/docs/guides/storage/security/access-control] A private bucket with no `storage.objects` policy is therefore reachable only with the service key, which is what D-18 needs.
- Object keys must match `/^[A-Za-z0-9_/!.*'() &$=@;:+,?-]*$/`. [VERIFIED: `src/storage/limits.ts` in github.com/supabase/storage, master] The colon in `o:<uuid>` is allowed; `合同.pdf` and `società.pdf` are not.

### Next.js instrumentation

- `register` "is called **once** when a new Next.js server instance is initiated, and must complete before the server is ready to handle requests"; the file goes in `src/` when a `src` folder is used; `process.env.NEXT_RUNTIME` selects the runtime; stable since v15.0.0. [CITED: nextjs.org/docs/app/api-reference/file-conventions/instrumentation]
- Consequence for D-37: the check must be time-boxed (3 s), must never throw, must skip when `RAG_EMBEDDING_PROFILES=off` or `NEXT_RUNTIME !== 'nodejs'`, and stores its verdict in a module variable that the embed stage reads.

## Architecture Patterns

### System Architecture Diagram

```
 chat upload ─┐
 Config UI ───┤                      ┌──────────────── request deadline (50 s) ───────────────┐
 Nango sync ──┼─► route resolves ───►│ ingest({scope, source, sourceKey, file|text, docType}) │
 scraper ─────┤   TenantScope        └───────────────────────┬────────────────────────────────┘
 image upload ┤   (tenant module)                            │ RAG_INGEST_PIPELINE
 ai-to-rag ───┘                         legacy ◄─────────────┴─────────────► unified
                                   (today's writers,                          │
                                    triggers fill defaults)                   ▼
   identify ─► file_hash_dedup ─► store_original ─► parse ─► content_hash_dedup ─► scan_injection
      │              │                  │             │              │                  │
      │        same tenant only   ObjectStore    RAG_PARSER     same tenant only   rules JSON
      │        skipped_duplicate  rag-originals      │          skipped_duplicate  quarantined flag
      │                                              │
      │                        llamaparse v2 ◄───────┼───────► sidecar /v1/parse/jobs (Docling)
      │                              │  fallback each way      │ poll with backoff, budget 45 s
      │                              └──────► plain text (txt, md, csv) ──► failed (retryable)
      ▼
   chunk ─► enrich ─► extract ─► images ─► embed ─► write ─► publish
     │        │          │         │         │        │         │
  profile   dates,    sidecar   caption   active +  rag_write  rag_publish_document_version
  chunker   urls,     /v1/      (inject-  every     _chunks    (swap is_current, drop old
  (data)    language  extract/  ed dep)   back-     (RPC,       vectors, keep old rows)
            section   invoice             filling   batched)
            path                          profile
                                             │
              ┌──────────────────────────────┴─────────────────────────────┐
              ▼                                                            ▼
   document_chunks.embedding vector(1536)                    chunk_embeddings (halfvec, per profile)
   legacy profile, legacy RPCs + D-08 filter                 match_chunks_by_profile (dynamic SQL)
              ▲                                                            ▲
              └────────── backend adapter picks by active profile ─────────┘
                         (RAG_EMBEDDING_PROFILES=off → always legacy)

   each stage: check deadline → run → persist processing_state → trace span
   deadline reached → status `processing`; GET /api/rag/ingest/{id} shows it; POST …/resume continues
```

### Recommended Project Structure

```
src/lib/rag/
├── ingest/
│   ├── index.ts              # ingest(), resumeIngest() (re-exported by @/lib/rag)
│   ├── types.ts              # IngestInput, IngestResult, IngestState, StageContext
│   ├── runner.ts             # ordered stage list, deadline, state persistence, trace spans
│   ├── deps.ts               # IngestDeps: db (RPC caller), objectStore, sidecar, llamaparse, captioner, embedders, now
│   ├── stages/               # one file per D-02 stage name
│   ├── identity.ts           # source_key rules, filename normalization, storage key
│   ├── hash.ts               # file_sha256, normalized content_hash (HASH_NORMALIZATION_VERSION)
│   ├── profiles/             # load + validate processing-profiles.json, resolveDocType, detect-doc-type.ts
│   ├── parsers/              # llamaparse-v2.ts, sidecar-docling.ts, plain-text.ts, chain.ts
│   ├── chunkers/             # markdown-sections.ts, table-aware.ts, legal-clauses.ts, invoice.ts, image-caption.ts
│   ├── text/                 # embedding-text.ts (EMBEDDING_TEXT_VERSION), section-path.ts
│   ├── security/             # injection-scan.ts (also used by Phase 5.1)
│   ├── writer.ts             # the only caller of rag_write_chunks / rag_begin_document_version / rag_publish_document_version
│   └── reembed/              # run.ts, cursor.ts, cost.ts, cli.ts
├── embeddings/               # openai.ts (Phase 2), voyage.ts, qwen.ts, registry.ts, profile.ts, mrl.ts
├── lexical/tokenize.ts       # LEXICAL_VERSION
├── lang/detect.ts            # zh/en/it dominant language (reused by XLG-01)
├── backend/                  # supabase-rpc.ts (Phase 2) gains the profile switch
├── retrieval/exact-id.ts     # exact_id_lookup stage and identifier shapes
└── tenant/                   # + ingest scope resolvers (session, admin workspace, Nango connection, scraper job)
config/rag/                   # processing-profiles.json, injection-rules.json
supabase/migrations/          # 0301_… ordered, idempotent
rag-sidecar/src/rag_sidecar/
├── parse/                    # jobs.py (pool, registry, TTL), docling_adapter.py, probe.py
├── extract/                  # invoice.py, labels.py, amounts.py, dates.py
└── contracts/                # ingest.py (ProcessingProfile, ParseJobRequest, ParseResult, InvoiceFields, InjectionRuleSet, DocTypeDetection)
eval/fixtures/ingest/         # typed fixtures, generator output, recorded ParseResult + Docling JSON, manifest.json
```

### Pattern 1: Resumable stage list with a request deadline

**What:** `ingest()` runs the D-02 stages in order. Each stage is a pure function of `(document_id, version)` plus its inputs from storage or the database, checks the remaining request time before it starts, and persists `processing_state` when it finishes.
**When to use:** every write path, and unchanged by Phase 3.1's worker (which passes a long deadline).

```typescript
// Source: design for D-02 and D-21 (no library)
type StageName = 'identify' | 'file_hash_dedup' | 'store_original' | 'parse' | 'content_hash_dedup'
  | 'scan_injection' | 'chunk' | 'enrich' | 'extract' | 'images' | 'embed' | 'write' | 'publish';

interface StageSpec { name: StageName; minMsNeeded: number; run(ctx: StageContext): Promise<StageOutcome>; }
type StageOutcome = { kind: 'next' } | { kind: 'done'; result: IngestResult } | { kind: 'yield'; reason: string };

async function runStages(ctx: StageContext, from: StageName): Promise<IngestResult> {
  for (const stage of STAGES.slice(STAGES.findIndex((s) => s.name === from))) {
    ctx.signal.throwIfAborted();
    if (ctx.deadline - ctx.deps.now() < stage.minMsNeeded) return yieldProcessing(ctx, stage.name);
    const span = ctx.trace.start(stage.name);
    const outcome = await stage.run(ctx);
    span.end(outcome);
    if (outcome.kind === 'done') return outcome.result;
    if (outcome.kind === 'yield') return yieldProcessing(ctx, stage.name);
    await ctx.writer.saveState(ctx.documentId, { lastCompleted: stage.name, ...ctx.state });
  }
  throw new Error('[Ingest] stage list ended without publish');
}
```

Rules that make resume safe:

- Intermediate products live in the object store, not in memory: `parse.md`, `docling.json`, `chunks.json` (chunk texts, section paths, pages) under the version's `rag-originals/…` prefix. `embed` and `write` are merged into one loop over batches so vectors never need to be stored outside the database.
- `parse` stores `{parser, job_id, submitted_at, attempt}` in `processing_state` before polling, for LlamaParse as well as Docling. On resume it polls the same job; when the sidecar answers 404 (TTL expired or restart), it resubmits once.
- `images` captions a bounded number of pictures per call and records the next index.
- A `processing` version older than 24 h is marked `failed` (retryable) by the status route. Phase 3 has no worker, so that route is the reaper.

### Pattern 2: The writer is a set of SQL functions

**What:** every write to `documents` and `document_chunks` under `unified` goes through three functions, called with the service key through `.rpc()`.
**Why:** one transaction per call, identical behaviour in single-tenant and multi-tenant schemas, idempotent retries, and the fake edge only needs new RPC names.

| Function | Does | Idempotency |
|----------|------|-------------|
| `rag_begin_document_version(p_tenant_key, p_user_id, p_org_id, p_source, p_source_key, p_filename, p_file_sha256, p_doc_type, p_doc_type_origin, p_profile_id, p_profile_version)` | Takes `pg_advisory_xact_lock` on the identity. Looks up, inside `p_tenant_key` only, a current document with the same `file_sha256` (→ `skipped_duplicate`) and the current row of the identity. Inserts a new row with `version = max + 1`, `is_current = false`, `status = 'processing'`, the same `lineage_id`, and the user-set metadata of the previous version | A `processing` row for the same identity and `file_sha256` is returned instead of creating another |
| `rag_write_chunks(p_document_id, p_tenant_key, p_chunks jsonb, p_embeddings jsonb, p_final boolean, p_total integer)` | Upserts chunks by deterministic id, writes the legacy `embedding` when the legacy profile is a target, upserts `chunk_embeddings` rows for the other target profiles, mirrors promoted columns into `metadata`. On `p_final` deletes chunks of that document with `chunk_index >= p_total` | `ON CONFLICT (id) DO UPDATE`; chunk id = UUID from `sha256(document_id \| chunk_index)` |
| `rag_publish_document_version(p_document_id, p_tenant_key)` | D-11 swap. Demotes the previous current row first (the partial unique index requires that order), sets `superseded_by`, drops the old version's vectors (F-9), then promotes the new row and its chunks. Keeps `quarantined` when the row is quarantined | Calling it twice returns the same state [VERIFIED: executed in PGlite] |

Every function is `SECURITY DEFINER SET search_path = public`, checks that the row's `tenant_key` equals `p_tenant_key`, and ends with `REVOKE ALL ON FUNCTION … FROM PUBLIC, anon, authenticated; GRANT EXECUTE ON FUNCTION … TO service_role;`. Vectors travel inside the jsonb as JSON arrays; `(x->>'embedding')::halfvec` accepts them [VERIFIED: executed in PGlite]. Size each `rag_write_chunks` call by bytes (target at most 1 MB of JSON, about 40 chunks at 2048 dims) rather than by count. [ASSUMED: the Supabase API gateway body limit is above that]

### Pattern 3: Triggers keep legacy writers valid

**What:** `BEFORE INSERT` triggers on `documents` and `document_chunks`.
**Why:** `RAG_INGEST_PIPELINE=legacy` stays the default and keeps inserting `source = 'upload' | 'nango' | 'scrape'` with no `lineage_id`, `source_key` or chunk `tenant_key`.

```sql
-- Source: design for F-1; statements of this shape were executed against both setup files in PGlite
CREATE OR REPLACE FUNCTION rag_documents_legacy_defaults() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.source := CASE
    WHEN NEW.source IN ('chat_upload','config_upload','nango','scraper','image_upload','ai_to_rag') THEN NEW.source
    WHEN NEW.source IN ('google-drive','notion','dropbox') THEN 'nango'
    WHEN NEW.source IN ('scrape') THEN 'scraper'
    ELSE 'config_upload' END;
  NEW.lineage_id := COALESCE(NEW.lineage_id, NEW.id);
  NEW.source_key := COALESCE(NEW.source_key, 'legacy:' || NEW.id::text);
  RETURN NEW;
END $$;
```

The chunk trigger copies `tenant_key`, `version`, `doc_type`, `source` from the parent document when they are NULL. The original legacy value is kept in `metadata.legacy_source` when it was rewritten. A test inserts each legacy shape after the migration and asserts the row is accepted, current and ready.

### Pattern 4: Docling adapter in the sidecar

```python
# Source: docling 2.152.0 / docling-core 2.108.0 APIs, verified by introspection and execution this session
import tiktoken
from docling.datamodel.base_models import InputFormat
from docling.datamodel.pipeline_options import (
    HeadingHierarchyOptions, OcrMode, PdfPipelineOptions, RapidOcrOptions, TableFormerMode,
)
from docling.document_converter import DocumentConverter, PdfFormatOption
from docling_core.transforms.chunker.hierarchical_chunker import ChunkingDocSerializer, ChunkingSerializerProvider
from docling_core.transforms.chunker.hybrid_chunker import HybridChunker
from docling_core.transforms.chunker.tokenizer.openai import OpenAITokenizer
from docling_core.transforms.serializer.markdown import MarkdownTableSerializer


class MarkdownTableProvider(ChunkingSerializerProvider):
    def get_serializer(self, doc):
        return ChunkingDocSerializer(doc=doc, table_serializer=MarkdownTableSerializer())


def build_pipeline_options(req) -> PdfPipelineOptions:
    opts = PdfPipelineOptions(artifacts_path=req.artifacts_path, document_timeout=req.timeout_seconds)
    opts.do_ocr = req.docling.ocr
    opts.ocr_options = RapidOcrOptions(backend="onnxruntime", lang=[to_ppocr_code(req.ocr_languages)])
    if req.docling.force_full_page_ocr:
        opts.ocr_options.mode = OcrMode.FULL_PAGE
    opts.do_table_structure = req.docling.table_mode != "off"
    opts.table_structure_options.mode = TableFormerMode.ACCURATE
    opts.heading_hierarchy_options = HeadingHierarchyOptions(enabled=True)
    opts.generate_picture_images = True
    opts.images_scale = 2.0
    return opts


def chunk(doc, req):
    tokenizer = OpenAITokenizer(tokenizer=tiktoken.get_encoding(req.tokenizer), max_tokens=req.max_tokens)
    chunker = HybridChunker(
        tokenizer=tokenizer, repeat_table_header=req.repeat_table_header,
        serializer_provider=MarkdownTableProvider(),
    )
    for c in chunker.chunk(dl_doc=doc):
        is_table = any(str(item.label) == "table" for item in c.meta.doc_items)
        yield {
            "text": c.text,
            "contextualized_text": chunker.contextualize(chunk=c),
            "headings": c.meta.headings or [],
            "pages": sorted({p.page_no for item in c.meta.doc_items for p in item.prov}),
            "is_table": is_table,
            "table_header": "\n".join(c.text.splitlines()[:2]) if is_table else None,
        }
```

`DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=…)})` and the `to_ppocr_code`, `req.docling.*` names are sketch names. [ASSUMED: `PdfFormatOption` signature unchanged; the planner's first sidecar task verifies it with the installed extra]

Job runner rules:

- `ProcessPoolExecutor(max_workers=1 by default, mp_context=spawn)` with the converter built once in the worker initializer. The parent process keeps the job registry, so `/health` and job polling never wait on a conversion.
- A bounded queue (default 8 waiting jobs); a full queue answers 429 with `Retry-After`, which the app treats as "try the other parser".
- Results are written to a temp directory per job (`result.json`, `docling.json`, `picture-N.png`) and removed after the TTL (1 h) or on `DELETE`.
- `ConversionStatus.PARTIAL_SUCCESS` → `partial = true` plus a warning; `FAILURE` → job status `failed` with an error class and no document text in the message.
- `text_layer_page_share` is computed with `pypdfium2` before conversion (pages whose text page has more than a few characters, divided by page count).
- Re-chunking without parsing: submit the stored `docling.json` as the file. Docling accepts `InputFormat.JSON_DOCLING`, so no layout or OCR model runs and `parser_used` keeps the original value. This serves D-18's "start from the stored parse output" and Phase 3.1's zero-parser re-chunk.

### Pattern 5: Embedding providers and the registry

```typescript
// Source: provider facts in "Verified External Facts"; interface from D-33
export interface EmbeddingProvider {
  id: 'openai' | 'voyage' | 'qwen3';
  model: string;
  maxInputTokens: number;
  supportedDims: readonly number[];
  normalize: boolean;
  embedDocuments(texts: string[], opts: { dims: number; signal: AbortSignal }): Promise<EmbedOutput>;
  embedQuery(text: string, opts: { dims: number; signal: AbortSignal }): Promise<EmbedOutput>;
}
export interface EmbedOutput { vectors: number[][]; model: string; host: string; usage: { tokens: number } }

// voyage.ts
body = { model: 'voyage-4-large', input: texts, input_type: 'document', output_dimension: dims, truncation: false };

// qwen.ts (DeepInfra primary, OpenRouter fallback; same body, different base URL and model id)
const QWEN_TASK = 'Given a web search query, retrieve relevant passages that answer the query';
const toQuery = (q: string) => `Instruct: ${QWEN_TASK}\nQuery:${q}`;   // no space after "Query:" (model card)
body = { model: 'Qwen/Qwen3-Embedding-8B', input: texts, encoding_format: 'float' }; // never send dimensions

// mrl.ts
export function truncateAndNormalize(vector: number[], dims: number): number[] {
  if (vector.length < dims) throw new EmbeddingProfileMismatch('dims', vector.length, dims);
  const head = vector.slice(0, dims);
  const norm = Math.hypot(...head);
  if (!Number.isFinite(norm) || norm === 0) throw new EmbeddingProfileMismatch('zero_norm', 0, dims);
  return head.map((x) => x / norm);
}
```

Rules:

- The registry rejects a profile whose `dims` is not in `supportedDims`, is above 4000, or is above 2000 with `storage = 'legacy_column'`.
- Per-request assertions (D-37): `vectors[i].length === profile.dims` after truncation, and the response's `model` equals the profile's `embedding_model` after normalizing host-specific ids (`Qwen/Qwen3-Embedding-8B` and `qwen/qwen3-embedding-8b` map to one canonical name in the registry).
- A zero-padded vector must fail: check that the raw Qwen3 response has 4096 components before truncation.
- Batching: by estimated tokens and by count. Voyage: at most 1,000 texts and 120K tokens per request; use 128 texts and a 100K budget with a 1.3 safety factor on `cl100k_base` counts, because Voyage's tokenizer differs. DeepInfra native lists 1,024 inputs per request.
- Fallback to OpenRouter happens per request on 5xx, 429 after retries, or timeout, and is recorded in the trace and on the row.

### Pattern 6: Profile storage and the search RPC

```sql
-- Source: executed in PGlite (pgvector 0.8.7) this session, with smaller dims
CREATE TABLE IF NOT EXISTS chunk_embeddings (
  chunk_id uuid NOT NULL REFERENCES document_chunks(id) ON DELETE CASCADE,
  profile_id text NOT NULL REFERENCES embedding_profiles(id),
  tenant_key text NOT NULL,
  embedding halfvec NOT NULL,
  embedding_model text NOT NULL,
  dims integer NOT NULL,
  embedding_host text,
  embedded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chunk_id, profile_id)
);
CREATE INDEX IF NOT EXISTS chunk_embeddings_voyage_4_large_2048_hnsw ON chunk_embeddings
  USING hnsw ((embedding::halfvec(2048)) halfvec_cosine_ops) WITH (m = 64, ef_construction = 200)
  WHERE profile_id = 'voyage-4-large-2048';

CREATE OR REPLACE FUNCTION match_chunks_by_profile(
  p_tenant_key text, p_profile_id text, p_dims integer, p_query halfvec,
  p_match_count integer, p_min_similarity double precision, p_require_active boolean DEFAULT true
) RETURNS TABLE (id uuid, document_id uuid, content text, similarity double precision, metadata jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_dims integer; v_status text;
BEGIN
  SELECT dims, status INTO v_dims, v_status FROM embedding_profiles WHERE embedding_profiles.id = p_profile_id;
  IF v_dims IS NULL THEN RAISE EXCEPTION 'embedding_profile_mismatch: unknown profile' USING ERRCODE = '22023'; END IF;
  IF v_dims <> p_dims OR vector_dims(p_query) <> v_dims THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: dims' USING ERRCODE = '22000'; END IF;
  IF p_require_active AND v_status <> 'active' THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: profile not active' USING ERRCODE = '22000'; END IF;
  IF (string_to_array((SELECT extversion FROM pg_extension WHERE extname = 'vector'), '.'))[1:2]::int[] >= ARRAY[0, 8] THEN
    PERFORM set_config('hnsw.iterative_scan', 'relaxed_order', true);
  END IF;
  RETURN QUERY EXECUTE format($q$
    SELECT c.id, c.document_id, c.content,
           1 - ((e.embedding::halfvec(%1$s)) <=> $1::halfvec(%1$s)) AS similarity, c.metadata
    FROM chunk_embeddings e JOIN document_chunks c ON c.id = e.chunk_id
    WHERE e.profile_id = %2$L AND e.tenant_key = $2 AND c.is_current AND c.status = 'ready'
      AND 1 - ((e.embedding::halfvec(%1$s)) <=> $1::halfvec(%1$s)) > $3
    ORDER BY (e.embedding::halfvec(%1$s)) <=> $1::halfvec(%1$s) LIMIT $4 $q$, v_dims, p_profile_id)
  USING p_query, p_tenant_key, p_min_similarity, p_match_count;
END $fn$;
REVOKE ALL ON FUNCTION match_chunks_by_profile FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION match_chunks_by_profile TO service_role;
```

Notes:

- `%1$s` is an integer read from the registry table and `%2$L` is a quoted literal, so the dynamic SQL takes no caller-controlled text.
- The tenant predicate is `e.tenant_key = $2`, where `tenant_key` is derived from the same columns as `match_documents_by_workspace` (`u:<user_id>` when `organization_id IS NULL`, else `o:<organization_id>`). A test compares both RPCs on the two-tenant fixture and asserts the same documents are visible.
- The status check inside the RPC is the per-request guard against a stale in-memory pointer (pitfall P-9). The eval route passes `p_require_active = false` to compare profiles.
- The return columns match `match_documents_by_workspace`, so the Phase 2 row mapping (`id → chunk_id`) is reused.
- The legacy RPCs are replaced with `CREATE OR REPLACE` and one extra predicate: `AND dc.is_current AND dc.status = 'ready'`. Nothing else in them changes, so the plan and order are the same and parity stays zero-diff on existing rows.

### Pattern 7: Activation gate in one function

`rag_activate_embedding_profile(p_target, p_actor)` runs in one transaction:

1. `LOCK TABLE embedding_profiles IN SHARE ROW EXCLUSIVE MODE`, so two activations and concurrent `backfilling` flips serialize.
2. (b) `SELECT count(*) FROM document_chunks c WHERE c.is_current AND c.status = 'ready' AND NOT EXISTS (SELECT 1 FROM chunk_embeddings e WHERE e.chunk_id = c.id AND e.profile_id = p_target)` must be 0. For the legacy target the check is `c.embedding IS NULL`.
3. (d) `SELECT count(*) FROM chunk_embeddings WHERE profile_id = p_target AND (embedding_model <> profile.model OR dims <> profile.dims)` must be 0.
4. (c) `eval_evidence` must carry `{target_profile, baseline_profile = current active, gate_passed: true, pre_migration: {passed: true, …}, backfill_run_id, recorded_at}` and `recorded_at` must be later than the last `embedded_at` of the run's rows (evidence older than the data is refused).
5. Flip: old active → `available` (or `retired` only by an explicit command), target → `active`, `previous_active_id` set, `activated_at`, `activated_by`.

Each refusal raises with a distinct message prefix (`activation_refused: incomplete`, `…: model_mismatch`, `…: eval_missing`, `…: eval_failed`, `…: pre_migration_missing`) so the CLI and the panel can show the failing condition. New ingestion keeps running during the gate; a chunk written between the count and the flip was dual-written, because the target is still `backfilling` until the flip commits.

### Pattern 8: Re-embed loop (keyset cursor, then a sweep)

```typescript
// Source: design for D-38..D-40
// Phase A: keyset pass
let cursor = run.cursorChunkId ?? '00000000-0000-0000-0000-000000000000';
for (;;) {
  const rows = await db.rpc('rag_reembed_next_batch', { p_profile_id, p_tenant_key, p_after: cursor, p_limit: batchSize });
  if (rows.length === 0) break;
  const texts = rows.map((r) => buildEmbeddingText(r));           // stored columns only
  const out = await provider.embedDocuments(texts, { dims, signal });
  await db.rpc('rag_reembed_write_batch', { p_run_id, p_profile_id, p_rows: zip(rows, out), p_cursor: last(rows).id });
  cursor = last(rows).id;                                          // cursor and rows commit together
}
// Phase B: sweep until nothing is missing (covers dual-write gaps and chunks written during phase A)
for (;;) {
  const missing = await db.rpc('rag_reembed_missing_batch', { p_profile_id, p_tenant_key, p_limit: batchSize });
  if (missing.length === 0) break;
  /* same embed + write */
}
```

- `rag_reembed_next_batch` selects `id, content, section_path, chunk_kind, doc_type, metadata` of current, ready chunks ordered by `id`; `rag_reembed_write_batch` upserts with `ON CONFLICT (chunk_id, profile_id) DO UPDATE` and updates the run row in the same transaction, so a kill between batches loses nothing and repeats nothing.
- The zero-parser test injects deps whose `sidecar`, `llamaparse` and `objectStore` throw on any call and counts requests on the fake endpoints.
- Dry run: counts chunks and `cl100k_base` tokens per tenant and multiplies by a price table kept next to the provider registry (0.02 USD per million for `text-embedding-3-small`, 0.12 for `voyage-4-large`, 0.01 for Qwen3 on DeepInfra, read from the provider listings above). Token counts for non-OpenAI models are estimates and the output says so.
- `--rollback <runId>` deletes the target profile's rows and is refused when the profile is `active` or was active less than 10 minutes ago (stale-pointer window, pitfall P-9).
- Image chunks are re-embedded from their stored caption like any other chunk.

### Pattern 9: Embedding text and lexical text from stored columns

```typescript
// Source: design for D-24 and D-32; Intl.Segmenter behaviour verified in Node 22.23.5
export const EMBEDDING_TEXT_VERSION = 1;
export function buildEmbeddingText(c: { section_path: string[]; content: string; template_header?: string }): string {
  const prefix = c.section_path.length > 0 ? `${c.section_path.join(' > ')}\n\n` : '';
  const header = c.template_header ? `${c.template_header}\n` : '';
  return `${prefix}${header}${c.content}`;
}

export const LEXICAL_VERSION = 1;
const IDENTIFIER = /[A-Z0-9][A-Z0-9._\/-]*\d[A-Z0-9._\/-]*/giu;   // contains a digit and may contain - _ . /
export function lexicalTokens(text: string): string[] {
  const out: string[] = [];
  let last = 0;
  const nfkc = text.normalize('NFKC');
  for (const m of nfkc.matchAll(IDENTIFIER)) {
    out.push(...segment(nfkc.slice(last, m.index)), m[0]);          // identifier kept verbatim
    last = (m.index ?? 0) + m[0].length;
  }
  out.push(...segment(nfkc.slice(last)));
  return out;
}
```

`segment()` uses `new Intl.Segmenter('zh', { granularity: 'word' })` for runs that contain Han characters and a lowercase, diacritic-folding split (`normalize('NFD').replace(/\p{M}/gu, '')`) for Latin runs. The type template (`template_header`) is rebuilt from stored columns only, for example `Invoice ${invoice_number} | ${supplier_name} | ${supplier_tax_id}` from the document row, so EMB-04 never needs a parser.

Token budget rule: `max_tokens` in a processing profile bounds the **embedding text** (path prefix plus content) for every chunker. That is how `HybridChunker` already counts, so chunk sizes match between the Docling path and the TypeScript chunkers. `overlap_tokens` applies only to the TypeScript chunkers, because `HybridChunker` has no overlap.

### Pattern 10: Legal clause chunker

1. Split the Markdown into lines and mark heading lines with the profile's patterns (D-25), tested in this order: Markdown headings, `第…条`, `Art.` / `Articolo` / `Article`, numbered `1.` / `1.1`, bracketed `（一）`.
2. A clause runs from one clause heading to the next heading of the same or a higher rank. Chapter-level headings (`第…章`, Markdown `#`/`##`) form the outer `section_path` elements; the clause heading is the last element.
3. Lead-in detection: a line ending with `：` or `:` that matches the profile's lead-in phrases (`但以下情况除外`, `except as follows`, `salvo quanto segue`, …) binds itself and the following list items into one unit that is never split from its lead-in when the unit fits.
4. If the clause fits `max_tokens` (measured on the embedding text), emit one chunk. Otherwise split at list-item boundaries, greedily packing items; every piece starts with the clause heading line and carries the same `section_path`; a lead-in is repeated at the top of each piece that holds items of its list.
5. A single item longer than the budget falls back to sentence splitting with the heading repeated.

Patterns are data, so they are compiled once with the `u` flag and validated like the injection rules (Pattern 11).

### Pattern 11: Injection matcher

- Normalize both the text and each rule: NFKC, remove zero-width and bidi control characters (code points U+200B to U+200F, U+202A to U+202E, U+2060 and U+FEFF), `toLowerCase()`, collapse whitespace runs to one space. For Chinese phrases also match with all whitespace removed, because OCR inserts spaces between characters.
- `kind: 'phrase'` is a plain substring test. `kind: 'regex'` is compiled with the `iu` flags; the loader rejects patterns longer than 200 characters, backreferences, and nested quantifiers (`(a+)+` shapes), and the scan runs on windows of at most 20,000 characters, which bounds worst-case time.
- Snippets stored in `metadata.quarantine` are at most three, each cut to 80 characters around the match. They are document text, so they are never logged.
- The scan covers the parse Markdown, each image caption, and for invoices the extracted party names.
- The same module is imported by Phase 5.1 for retrieved chunks, so it takes a string and returns `{matched, rule_ids, snippets}` with no ingestion types in its signature.

### Anti-Patterns to Avoid

- **Table writes from routes:** a new `.from('document_chunks').insert` outside `src/lib/rag/ingest/` re-creates today's drift. The boundary check must cover `insert`, `update`, `upsert` on chunks and `insert` on documents (D-04), plus `.rpc('rag_write_chunks'` and the other writer RPC names outside the ingest module.
- **Comparing hashes before filtering by tenant:** any query of the form `WHERE content_hash = $1` without `tenant_key` is a cross-tenant existence oracle. The lookups live only inside `rag_begin_document_version` and the `content_hash_dedup` stage RPC, both of which take `p_tenant_key` first.
- **Branching on doc type in stage code:** stages read `profile.chunker.kind`, `profile.extractors` and so on. The lint (D-13) greps for `doc_type ===`, `docType ===`, `switch (docType` and `switch (doc_type` outside `ingest/profiles/`.
- **Running Docling in a request thread:** conversion in the FastAPI handler blocks `/health` and exceeds proxy timeouts. Use the process pool.
- **Asking the provider for truncated Qwen3 vectors:** `dimensions` is honoured differently per host and pads with zeros above the default. Truncate in the app.
- **`ALTER TABLE … ALTER COLUMN embedding TYPE`:** rewriting the legacy column breaks legacy retrieval and cannot be rolled back. New profiles only ever add rows to `chunk_embeddings`.

## Migration Plan for Existing Data

Files in `supabase/migrations/`, applied in name order after the setup file. Every statement is idempotent (`IF NOT EXISTS`, `CREATE OR REPLACE`, guarded `DO` blocks), and each file works on both schemas by checking `information_schema.columns` for `documents.user_id`.

| File | Content | Notes for existing rows |
|------|---------|-------------------------|
| `0301_documents_versions.sql` | New `documents` columns (D-06), `tenant_key` generated column, `(lineage_id, version)` unique index, lineage partial unique index, btree indexes on `(tenant_key, file_sha256)` and `(tenant_key, content_hash)` | `lineage_id = id`, `version = 1`, `is_current = true`, `status = 'ready'`, `doc_type = 'general'`, `doc_type_origin = 'fallback'`, `parser_used = 'llamaparse'` with `parser_version = 'legacy'`. Hashes stay NULL (see below) |
| `0302_documents_source.sql` | Drops every CHECK constraint on `documents` whose definition mentions `source` (found through `pg_constraint`, because the live name may differ), rewrites values, adds the widened CHECK and default | `upload → config_upload`; `google-drive`, `notion`, `dropbox`, `nango` → `nango` (`source_provider` kept, and filled from the old value when empty); `scrape → scraper`; anything else → `config_upload` with `metadata.legacy_source` |
| `0303_documents_identity.sql` | Backfills `source_key` | Nango and scraper rows: `source_file_id` for the newest row per `(tenant_key, source, source_file_id)`, `legacy:<id>` for older duplicates and for all uploads. The unique index can then never fail on existing duplicates, and the next sync of a file becomes version 2 of its newest legacy row |
| `0304_chunks_promoted.sql` | New `document_chunks` columns (D-07), `chunk_index` added where missing (single-tenant), btree `(document_id, chunk_index)` | Denormalized columns copied from the parent in batches; `chunk_kind = 'image'` when `metadata ? 'image_url'`, else `'text'`; `metadata.embedding_model = 'text-embedding-3-small'` and `metadata.embedding_dims = 1536`; `section_path = '{}'`, `lexical_text` NULL, `embedding_text_version = 0` (0 means "legacy text, no path prefix") |
| `0305_legacy_compat_triggers.sql` | Pattern 3 triggers | — |
| `0306_retrieval_filters.sql` | `CREATE OR REPLACE` of `match_documents_by_workspace` and `match_document_chunks` (per schema) with the D-08 predicate | Behaviour-preserving for existing rows; parity gate must stay zero-diff |
| `0307_doc_type_defaults.sql` | `rag_doc_type_defaults`, RLS enabled, no policies, grants revoked from `anon` and `authenticated` | Empty |
| `0308_invoice_columns.sql` | Promoted invoice columns and the four tenant-leading btree indexes (D-27) | NULL |
| `0309_embedding_profiles.sql` | `embedding_profiles` with the partial unique index on `status = 'active'`, `score_calibration` jsonb, seed rows (`openai-3-small-1536` active with `storage = 'legacy_column'`; the Voyage and Qwen3 profiles `available`) | — |
| `0310_chunk_embeddings.sql` | `chunk_embeddings`, one partial expression HNSW index per seeded `halfvec` profile, `embedding_backfill_runs`, `match_chunks_by_profile` | Indexes are created on an empty table, so there is no long build at migration time |
| `0311_ingest_functions.sql` | Pattern 2 functions, re-embed helper functions, activation and rollback functions, grants | — |
| `0312_storage.sql` | `rag-originals` bucket (`public = false`, size limit 20 MB), no `storage.objects` policies | — |

Decisions inside the plan:

- **Hashes of existing documents are not backfilled in SQL.** `content_hash` must come from one implementation (the TypeScript normalizer), and legacy `documents.content` is the joined LlamaParse v1 chunk text, which will not equal a v2 or Docling parse of the same file. A `npm run rag:backfill-hashes` script computes `content_hash` from stored `content` with the TypeScript normalizer so exact re-uploads of already-ingested text dedupe; `file_sha256` stays NULL for legacy rows because the original bytes were never stored. This limit is documented, not hidden.
- **`tenant_key` on `documents` is a stored generated column**, which rewrites the table once under an `ACCESS EXCLUSIVE` lock. It is acceptable at this project's size and is listed as a live step to run in a quiet window. Single-tenant: `GENERATED ALWAYS AS ('s:default') STORED` (a constant expression is accepted [VERIFIED: executed in PGlite]). Multi-tenant: `CASE WHEN organization_id IS NOT NULL THEN 'o:' || organization_id::text ELSE 'u:' || user_id::text END`.
- **Index strategy:** for collections up to a few hundred thousand chunks, keep the per-profile HNSW index in place and let the backfill insert into it. For larger collections, drop the profile's index, backfill, then `CREATE INDEX CONCURRENTLY` on a direct (non-pooled) session with `SET maintenance_work_mem` raised and `SET max_parallel_maintenance_workers`; pgvector warns when the graph no longer fits [CITED: pgvector README]. Session settings do not survive a transaction-mode pooler connection. [ASSUMED: Supabase pooler port 6543 is transaction mode]
- **Setup files:** after the migrations exist, both setup files are updated to the final shape. The schema-equality test loads (a) the frozen pre-Phase-3 setup file committed under `tests/fixtures/sql/` plus migrations and (b) the current setup file plus migrations into two PGlite databases and compares catalog dumps: columns with types and defaults, constraints, indexes (`pg_get_indexdef`), functions (`pg_get_functiondef`), triggers, policies and grants on the `rag_*` functions.
- **Live order (ROADMAP live verification):** inventory query (`SELECT source, count(*) FROM documents GROUP BY 1`, constraint names, `extversion`), backup, migrations, parity run of the eval smoke tier against the live project in `legacy`, then the bucket check.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| PDF layout, tables, OCR | Custom PDF text extraction | Docling 2.152.0 in the sidecar | Reading order, TableFormer, OCR routing |
| Structure-aware, token-bounded chunking of parsed documents | A chunker over Docling JSON | `HybridChunker` with `OpenAITokenizer` | Table splitting by rows and columns with header repetition is already there |
| Italian VAT, Chinese USCC, EU VAT checks | Checksum code in Python | `python-stdnum` 2.2 (`stdnum.it.iva`, `stdnum.cn.uscc`, `stdnum.eu.vat`) | Province codes, alphabets and check digits are easy to get subtly wrong |
| Token counting | `text.length / 4` (used by all three legacy chunkers) | `tiktoken` `cl100k_base` on both sides | D-22; Chinese text is far from 4 characters per token |
| Chinese word segmentation | Dictionary or bigram splitting | `Intl.Segmenter` | Built into Node 22 |
| Vector distance and ANN | Anything in application code | pgvector HNSW through the RPC | — |
| Multi-statement atomicity | Sequences of supabase-js calls with manual cleanup (as `storeDocument` does today) | One SQL function per operation | supabase-js has no transactions |
| Deterministic fixture PDFs | Committing PDFs of unknown origin | `reportlab` generator with `invariant=1` | D-23 |
| CPU-only torch resolution | Manual wheel URLs | `[[tool.uv.index]]` `pytorch-cpu` with `explicit = true` | Documented uv pattern |

Deliberately hand-rolled (small, specified, no good dependency): the TypeScript tax-id and invoice-number shape checks for `exact_id_lookup` (they must mirror the sidecar validators; a shared JSON file of test vectors generated with `python-stdnum` is asserted on both sides), the three date formats and the two amount locales of D-26, the zh/en/it language detector, the Markdown heading stack, and the injection matcher.

**Key insight:** the hard parts of this phase are transactional and contractual (versions, dedup, profile consistency), and Postgres already solves them; the application code should orchestrate, not re-implement.

## Runtime State Inventory

This phase migrates live data and re-homes writers, so the inventory applies.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | `documents` and `document_chunks` rows on the user's Supabase project with unknown `source` values and possibly a different CHECK constraint than the committed SQL (F-1); duplicate rows per Nango file id and per scraped URL (re-sync creates a new row today); `nango_sync_records.document_id` points at one document row | Data migration (files 0301–0304). Code edit: Nango sync keeps updating `nango_sync_records.document_id` to the current version id |
| Stored data | Stored chat messages cite `document_id` and chunk ids | None. Old rows are kept by design (D-11); the destructive mode of `reprocess-documents.js` must refuse once versions exist |
| Live service config | The Supabase project's installed pgvector version, storage buckets (`chat-attachments` may or may not exist), statement timeouts, the Vercel project's function duration | Live checks before migrating; none of this is in git |
| Live service config | The deployed sidecar (Fly.io or other) image and its `RAG_SIDECAR_SECRET` | New image with the `docling` extra and baked models; the app and sidecar deploy together once `RAG_PARSER=docling` or the fallback is relied on |
| OS-registered state | None found. `grep -i "cron\|schedule"` over `vercel.json`, `.github/workflows/*.yml` and the two `fly.toml` files matches only the nightly eval workflow (`cron: '0 3 * * *'`) | None |
| Secrets/env vars | New: `VOYAGE_API_KEY`, `DEEPINFRA_API_KEY` (placeholders in the five locations). Existing and reused: `LLAMA_CLOUD_API_KEY`, `OPENROUTER_API_KEY`, `RAG_SIDECAR_URL`, `RAG_SIDECAR_SECRET` | Code edit plus `check-config` pattern extension for `VOYAGE_*` and `DEEPINFRA_*` |
| Build artifacts | `rag-sidecar/uv.lock` (must be regenerated with the new extras), the sidecar Docker image, `src/lib/rag-eval/contracts.generated.ts` and `rag-sidecar/schemas/*.json` (regenerated by `npm run gen:schemas`), `eval/baselines/fixture-baseline.json` (re-recorded after `cross_lingual`) | Regenerate and commit in the plan that changes the source |

## Evaluation Additions (D-41..D-43)

### `cross_lingual` category (XLG-02)

- Contract: `Category` gains `cross_lingual` (after 02-25's three categories). `GoldenItem` gains `evidence_language: Language | None`. Validator: `cross_lingual` requires `evidence_language`, and it must differ from `language` (the question language). The corpus check (evidence language equals the language folder of every gold document) belongs in `eval/tests/test_fixture_coverage.py`, because the Pydantic model cannot see the corpus.
- **Parallel-document trap.** The fixture corpus has `product-specs` and `refund-policy` in all three languages [VERIFIED: `ls eval/fixtures/corpus/*`]. An English question about a fact that also exists in `product-specs.en.md` would be answered by the English document, and the item would not measure cross-lingual retrieval. Gold facts must come from documents that exist in one language only:

  | Document language | Single-language documents available | Pairs they serve |
  |---|---|---|
  | zh | `employee-handbook.zh.md`, `scanned-contract.zh.md` | en→zh, it→zh |
  | en | `shipping-handbook.en.md`, `warehouse-floorplan.en.md`, `scanned-invoice.en.md` | zh→en, it→en |
  | it | `warranty-terms.it.md`, `scanned-receipt.it.md` | zh→it, en→it |

  Each document is 1.2–2.3 KB, which is tight for eight distinct facts per language. D-41 allows new fixture documents when needed; adding one single-language document per language is the safe plan. A coverage test asserts that no gold quote of a `cross_lingual` item has a translated counterpart in another language folder (checked by document stem).
- Expected baseline: the fixture embedder hashes character n-grams, so a question and a document in different scripts share almost no features. Recall on en→zh and it→zh will be near zero unless the item shares digits or Latin identifiers. Include both kinds (two identifier-bearing and two purely semantic items per pair), so the slice is not uniformly zero and the report shows the difference. With a deterministic fixture the spread is 0 and the 0.02 floor applies (D-41).
- Reports: `by_language_pair` keyed `"<question>-><evidence>"`; the gate treats each pair like a language slice.
- Order (Phase 2 D-25 rule): contract change, new items, then re-record the baseline under `RAG_PIPELINE=legacy` with the legacy profile and assert zero paired differences on pre-existing items.

### `ingest` fixture mode (D-42)

- `createFixtureDatabase` gains a migrations step (load `supabase/migrations/*.sql` in name order after the setup file) for both modes. `prechunked` keeps inserting rows as today; the new columns take their defaults, which is exactly the legacy-row situation.
- `ingest` mode calls the real `ingest()` in-process with injected deps: a database client pointed at the fake edge, an in-memory `ObjectStore`, a fake sidecar client that serves recorded `ParseResult` files by fixture `file_sha256` from `eval/fixtures/ingest/manifest.json`, a fake LlamaParse v2 client, a recorded captioner, and the fixture embedder.
- The fake edge needs: the new RPC names in its allow-list (arguments validated per function, vectors only inside jsonb), the new columns in `TABLE_COLUMNS`, and filters on `is_current`, `status`, `lineage_id`, `tenant_key`. It still needs no table writes, because the writer is RPC-only.
- The Markdown corpus goes through `ingest()` as `text/markdown` (native path, no parser). The `<!-- chunk -->` markers and the `fixture-meta` comment line must be stripped before hashing and chunking in this mode, otherwise they leak into chunk text.
- The mode records its own baseline file (`eval/baselines/fixture-ingest-baseline.json`). Gold spans match by normalized quote (Phase 1 D-13), so new chunk boundaries do not invalidate items, but a quote that straddles a chunk boundary stops matching: the chunkers must not split inside a table row or a list item, and a test lists every gold quote that no single chunk contains.

### Per-profile comparison (D-43)

- The fixture embedder takes a `dims` argument (bucket count); the fake OpenAI-compatible endpoint returns 4096 dims for the Qwen3 model id so the client's truncation and normalization are exercised, and the fake Voyage endpoint honours `output_dimension` and records `input_type`.
- The eval route accepts `embedding_profile` (eval scope only) and calls `match_chunks_by_profile` with `p_require_active = false`.
- The report has two blocks per profile: gated metrics with the profile's `score_calibration`, and threshold-free candidate metrics (Recall@k and MRR over the RPC candidates with `p_min_similarity = -1`). The default-candidate rule (a multilingual profile must beat `openai-3-small-1536` on `cross_lingual`) reads the threshold-free block, so a different score scale cannot decide it (F-7).
- `pre_migration` slice: gold documents whose `documents.created_at` is earlier than the backfill run's `started_at`. The fixture ingests part of the corpus, starts the run, then ingests the rest through dual-write.

## Common Pitfalls

### P-1: Legacy writers break after the migration
**What goes wrong:** the widened `source` CHECK rejects `'upload'`, `'nango'`, `'scrape'`; legacy chunks have no `tenant_key`.
**Why it happens:** `legacy` stays the default writer (D-03) while the schema moves.
**How to avoid:** Pattern 3 triggers; a test that inserts every legacy shape after migrating, in both schemas.
**Warning signs:** `violates check constraint "documents_source_check"` in logs; re-embed dry run reporting chunks with a NULL tenant.

### P-2: The live schema is not the committed schema
**What goes wrong:** the migration assumes constraint names and values that the user's project does not have.
**Why it happens:** the committed CHECK cannot hold the values the running code writes, so the live database has probably been altered by hand.
**How to avoid:** drop constraints by catalog lookup, map unknown `source` values to a safe default while keeping the original in metadata, and run the inventory queries before migrating.
**Warning signs:** the inventory shows `source` values outside the four in the CHECK.

### P-3: Table header "repeated" but invisible
**What goes wrong:** success criterion 4 fails although `repeat_table_header=True`.
**Why it happens:** the default serializer is the triplet serializer (F-3).
**How to avoid:** `MarkdownTableProvider`; the fixture assertion checks that every `is_table` chunk's first two lines are the header row and a `|---|` row.

### P-4: `HybridChunker` import fails in the light CI environment
**What goes wrong:** `ModuleNotFoundError: No module named 'huggingface_hub'`.
**How to avoid:** the `chunking` extra lists `huggingface_hub`; a sidecar test imports the adapter under that extra only.

### P-5: Flat section paths from PDFs
**What goes wrong:** every Docling chunk has a one-element `section_path`.
**Why it happens:** PDF headings default to level 1.
**How to avoid:** `HeadingHierarchyOptions(enabled=True)`. Chinese chapter and clause numbering is probably not in its numbering rules [ASSUMED], so the `contract_legal` profile uses the TypeScript clause chunker on the Markdown regardless of parser.

### P-6: Models downloaded at runtime
**What goes wrong:** first parse hangs or fails in the container (no home directory, no egress to `modelscope.cn` or Hugging Face, read-only filesystem).
**How to avoid:** download layout, table and RapidOCR models and the `cl100k_base` file at image build; set `artifacts_path`, `HF_HOME` and `TIKTOKEN_CACHE_DIR` to baked directories; add a sidecar `/ready` condition that the artifacts directory exists when the `docling` extra is installed.
**Warning signs:** the nightly real-Docling job passes on a developer machine and fails in the image.

### P-7: The request ends before ingestion does
**What goes wrong:** Vercel kills the function at 60 s with a half-written version.
**Why it happens:** parse polling alone may use 45 s; captioning 30 images cannot fit in the rest.
**How to avoid:** F-12 deadline in the runner, `processing` status, resume. Half-written versions are harmless: they are `is_current = false`, `status = 'processing'`, and the D-08 filter hides them.
**Warning signs:** documents stuck in `processing`; the status route's 24 h reaper marking them `failed`.

### P-8: Filtered HNSW scans return too few rows
**What goes wrong:** a small tenant gets 1 result instead of 15, and strict mode answers "information not available".
**Why it happens:** HNSW visits `ef_search` (40) candidates and filters afterwards. Other tenants' rows, superseded versions and quarantined rows all consume candidates.
**How to avoid:** F-9 (drop superseded vectors, iterative scan in the new RPC). The legacy RPCs keep their behaviour for parity; note that `match_documents_by_workspace` has had this weakness for small tenants all along.
**Warning signs:** fewer candidates than `match_count` for a tenant with many documents.

### P-9: Stale active-profile pointer in warm instances
**What goes wrong:** after an activation or a rollback, some serverless instances keep embedding queries with the old profile.
**Why it happens:** the pointer is cached per process; `register()` runs once per instance.
**How to avoid:** cache the pointer for 30 s at most; pass the profile id to the RPC, which raises `embedding_profile_mismatch` when that profile is not `active`; on that error refresh the pointer and retry once. Never delete a profile's rows within 10 minutes of it being active.

### P-10: Same-dimension model swap
**What goes wrong:** someone points `OPENAI_EMBEDDING_MODEL` (or a base URL) at another 1536-dim model; pgvector accepts the vectors and search quality collapses silently.
**How to avoid:** the embed stage compares the provider response's `model` with the profile's `embedding_model`; every row records `embedding_model`; the legacy writer under `unified` refuses to write when `env.OPENAI_EMBEDDING_MODEL` differs from the legacy profile's model. `scripts/rag/reprocess-documents.js` defaults to `'text-embedding-ada-002'`, a different 1536-dim model than the app default; its legacy mode must read the same default as `src/lib/env.ts`.

### P-11: Score thresholds do not transfer between models
**What goes wrong:** a better embedding model "regresses" on refusal metrics, or answers everything.
**How to avoid:** F-7. Legacy profile calibration equals today's constants exactly, so `RAG_EMBEDDING_PROFILES=off` changes nothing.

### P-12: Identifiers split by the segmenter
**What goes wrong:** `FP-2025-0042` becomes `FP`, `2025`, `0042` in `lexical_text` and exact lookups fail.
**Evidence:** `Intl.Segmenter('zh')` output on `发票号码FP-2025-0042不得转让`: `发票 | 号码 | FP | 2025 | 0042 | 不得 | 转让` [VERIFIED: executed].
**How to avoid:** extract identifier-shaped tokens first (Pattern 9); share the shapes with `exact_id_lookup` and with the rewrite-gate protected tokens.

### P-13: Non-ASCII storage keys
**What goes wrong:** `InvalidKey` when storing `合同.pdf`.
**How to avoid:** F-2; a test uploads zh and it filenames through the in-memory store, which applies the same key regex as Supabase.

### P-14: Duplicate documents from concurrent uploads of the same file
**What goes wrong:** two requests both see "no current document" and both create version 2.
**How to avoid:** `pg_advisory_xact_lock` on the identity inside `rag_begin_document_version`, plus the `(lineage_id, version)` unique index and the partial unique index on the current row.

### P-15: The fallback provider writes different vectors
**What goes wrong:** OpenRouter routes Qwen3 to a host with other quantization; rows of one profile come from two numerically different models.
**How to avoid:** identical request and truncation path, `embedding_host` recorded, fallback share reported, and the option to pin the OpenRouter `provider.order`. Live verification compares one text on both hosts (cosine above 0.999 expected) [ASSUMED threshold].

### P-16: New SQL functions are callable by `anon`
**What goes wrong:** PostgreSQL grants `EXECUTE` to `PUBLIC` on new functions, and PostgREST exposes the `public` schema.
**How to avoid:** explicit `REVOKE … FROM PUBLIC, anon, authenticated` after every function; a PGlite test loops over `pg_proc` names starting with `rag_` plus `match_chunks_by_profile` and asserts `has_function_privilege('anon', oid, 'EXECUTE')` is false. The same applies to tables: RLS enabled, no policies, grants revoked.

### P-17: Version rows collide with existing unique indexes
**What goes wrong:** `documents_org_type_slug_ux` is unique on `(organization, content_type, slug)`; copying `content_type` and `slug` to a new version row violates it [VERIFIED: `supabase/multi-tenant-setup.sql:189`].
**How to avoid:** `rag_begin_document_version` leaves `content_type` and `slug` NULL on the new row; the publish function moves them from the old row to the new row inside the swap (old first).

### P-18: Hash normalization drift
**What goes wrong:** a later change to whitespace or Unicode handling makes every stored `content_hash` unmatchable.
**How to avoid:** one function with `HASH_NORMALIZATION_VERSION = 1` stored beside the hash (`metadata.content_hash_version`), golden test vectors for zh/en/it, and no second implementation (no SQL-side hashing).

### P-19: The eval `ingest` mode leaks fixture markers
**What goes wrong:** `<!-- chunk -->` lines end up in chunk text and in hashes.
**How to avoid:** strip markers and the `fixture-meta` line in the harness before calling `ingest()`.

### P-20: Background work after the response
**What goes wrong:** the image upload route starts captioning without awaiting it; on serverless the work may never run.
**How to avoid:** wrap the `ingest()` call in `after()` from `next/server` (the same mechanism Phase 2 uses for trace flushing) and bound it with the request deadline.

### P-21: New fixtures trip the fixture PII scanner
**What goes wrong:** `eval/tests/test_fixture_pii.py` asserts exactly 15 fixture files and flags digit runs that look like phone numbers (`CN_MOBILE_RE = (?<!\d)1[3-9]\d{9}(?!\d)` matches an 11-digit Partita IVA that starts with 13–19; `LOCAL_PHONE_RE` matches `ddd-dddd`).
**How to avoid:** extend the scanner to the new fixture directories in the same plan that adds them, update the file count, and choose synthetic ids outside the phone shapes (for example the `99999999990` Partita IVA and invoice numbers with a letter prefix and a four-digit year such as `FT-2025-00417`).
**Warning signs:** the eval pytest job fails right after fixtures are added.

### P-22: Tenant keys that differ only by letter case
**What goes wrong:** `scopeKey()` returns `o:<id>` with the id exactly as the route received it; the generated SQL column uses `organization_id::text`, which is lowercase. An uppercase UUID from a client makes dedup miss and makes `match_chunks_by_profile` return nothing.
**Why it happens:** `mintScope` validates UUIDs case-insensitively and does not normalize them.
**How to avoid:** lowercase ids when the scope is minted (a small change inside the tenant module, coordinated with Phase 2), and add a test that mints a scope from an uppercase id and expects the lowercase key. Until then the ingest writer lowercases `p_tenant_key`.
**Warning signs:** a tenant whose legacy search works and whose profile search is empty.

## Code Examples

### Hash normalization (D-09)

```typescript
// Source: D-09 rule; Node 22 String.prototype.normalize and node:crypto
import { createHash } from 'node:crypto';
export const HASH_NORMALIZATION_VERSION = 1;
export function normalizeForHash(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')      // collapse spaces and tabs, keep newlines
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}
export const contentHash = (text: string) => createHash('sha256').update(normalizeForHash(text), 'utf8').digest('hex');
export const fileSha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
```

D-09 says "whitespace runs collapsed" without saying whether newlines survive. The sketch keeps single newlines. The planner must fix one rule in the first ingest-core plan and freeze it with test vectors, because it is persisted (D-09 "costly").

### Tax-id validation and synthetic fixtures (D-26)

```python
# Source: python-stdnum 2.2, executed this session
from stdnum.cn import uscc
from stdnum.eu import vat
from stdnum.it import iva

assert iva.is_valid("99999999990")            # synthetic: province code 999, Luhn-valid
assert uscc.is_valid("91000000MA0000000N")    # synthetic: division code 000000, check digit computed
assert vat.is_valid("IT99999999990")
```

`stdnum.it.iva.validate` checks 11 digits, a non-zero first block, a province code in `001`–`100` or one of `120`, `121`, `888`, `999`, and the Luhn check digit. Fixture ids use the reserved-looking values above so they pass checksums and belong to no real entity (AGENTS.md rule 7).

### Legacy-shape acceptance test (PGlite)

```typescript
// Source: pattern of eval/harness/pglite-supabase.mts; statements of this shape ran here against both setup files
for (const source of ['upload', 'nango', 'scrape', 'google-drive', undefined]) {
  await db.query('INSERT INTO documents (id, filename, content, source) VALUES (gen_random_uuid(), $1, $2, $3)', ['a.md', 'x', source ?? 'upload']);
}
const rows = await db.query("SELECT source, is_current, status, lineage_id = id AS own_lineage, source_key FROM documents");
// expect every row: source in the widened enum, is_current true, status 'ready', own_lineage true, source_key 'legacy:<id>'
```

### Anon cannot execute writer functions

```sql
-- Source: PostgreSQL has_function_privilege; roles exist in the harness shim (anon, authenticated, service_role)
SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND (p.proname LIKE 'rag\_%' OR p.proname = 'match_chunks_by_profile')
  AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));
-- expect zero rows
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| LlamaParse v1 (`/api/v1/parsing/upload`, modes) | LlamaParse v2 (`/api/v2/parse/upload`, required `tier` and `version`, `expand`) | v2 is current; v1 still served | Per-page Markdown and typed items remove guesswork about pages and headings |
| Docling with EasyOCR as the usual default | `docling-slim[standard]` ships `rapidocr`; auto-selection prefers RapidOCR on onnxruntime; PP-OCRv6 multilingual checkpoints | Visible in 2.152.0 | One OCR model for zh/en/it |
| `force_full_page_ocr=True` | `OcrOptions.mode = OcrMode.FULL_PAGE` | Visible in 2.152.0 | Option name to use for `scanned_image` |
| Flat PDF headings | `HeadingHierarchyOptions` | Visible in 2.152.0 | Real section paths from PDFs |
| One `vector(n)` column per model | Dimensionless column, partial expression index per model, `halfvec` above 2,000 dims | pgvector 0.7.0 (`halfvec`), 0.8.0 (iterative scans) | Side-by-side profiles without schema changes |
| Post-filter and hope | `hnsw.iterative_scan` | pgvector 0.8.0 | Fixes under-filled filtered results |

**Deprecated/outdated:**

- `text.length / 4` token estimates in the three legacy chunkers: wrong for Chinese; replaced by `cl100k_base` under `unified`.
- The `Document: X. Chunk n of m. Content:` prefix stored in `content`: replaced by plain content plus `section_path` (D-24); the legacy branch keeps it.
- Relying on provider-side `dimensions` for Qwen3: host-dependent; truncate in the app.

## Project Constraints (from CLAUDE.md)

Directives from `CLAUDE.md`, `AGENTS.md` and `.claude/CLAUDE.md` that bind this phase:

- Node.js 22 (`^22.12.0`), npm; `legacy-peer-deps=true`, so peers are not auto-installed.
- New `.env.local` variables are mirrored in `scripts/init-env.js`, `src/lib/env.ts`, `scripts/config-server.js` and the Config UI; `check-config` must pass. Embedding model ids stay out of the five-location model lists (D-44).
- No secrets, real phone numbers or customer data in the repository; placeholders in tests and docs; fixtures are synthetic.
- Do not break: strict-mode "information not available", webSearch with Exa, `source_images`, the `{{context}}` placeholder, voice and embed paths.
- Multi-tenant safety: RLS and tenant isolation must not weaken; every new read or write path gets a two-tenant test.
- Every new component has a switch and defaults to today's behaviour; each phase is compared with the baseline.
- Python sidecar for Docling; structured contracts in Pydantic v2 (`pydantic>=2.14.4`) with generated Zod (`zod/v3`) and a CI parity check.
- pgvector: above 2,000 dims use `halfvec` or reduce dimensions.
- Code style: kebab-case modules, `@/` alias, Zod validation through `validateRequest`, structured JSON errors, bracketed log prefixes (`[Ingest]`, `[Embedding Profile]`, `[Document Search]`), no new `any`, minimal comments, no logging of key values or document text.
- Validate all API inputs; run lint, type-check and domain scripts before handoff. After plan 02-36, `tsc --noEmit` must stay at zero errors and type errors fail the build.
- Large files (`chat/route.ts`, `page.tsx`, `config-server.js`, `config-ui/index.html`) carry regression risk: Config UI panels are added as separate script blocks and routes, not woven into existing handlers.
- GSD workflow: file changes go through a GSD command; this research writes only inside the phase directory.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | PP-OCRv6 reads real scanned Chinese and Italian (including diacritics) well enough | OCR decision | Switch the sidecar to Tesseract (`chi_sim+eng+ita`); image grows, adapter option changes, profile data unchanged |
| A2 | `PdfFormatOption(pipeline_options=…)` and `DocumentConverter(format_options=…)` are unchanged in 2.152.0 | Pattern 4 | First sidecar task fails fast; fix the two call sites |
| A3 | `HeadingHierarchyOptions` numbering rules do not cover Chinese `第X章/第X条` | P-5 | None if it does; otherwise legal documents rely on the TypeScript clause chunker, which is the plan anyway |
| A4 | Voyage `output_dimension` is plain Matryoshka truncation, so a 1024 profile can be derived from 2048 vectors | Qwen3 dimension decision | The Voyage 1024 profile needs its own API backfill |
| A5 | 1024-dim Qwen3 loses little quality against 2048 | Qwen3 dimension decision | Keep 2048 as the default candidate; storage is still below the legacy column |
| A6 | OpenRouter's Qwen3 hosts produce vectors close to DeepInfra's | P-15 | Disable the fallback for document embedding and keep it for queries only, or pin the provider order |
| A7 | The Supabase API accepts request bodies of about 1 MB on RPC calls | Pattern 2 | Lower the bytes-per-call target |
| A8 | Service-role RPC calls are subject to a statement timeout of a few seconds on Supabase | Open Questions | Completeness count and backfill batches need smaller units or a per-function `statement_timeout` |
| A9 | The Supabase pooler on port 6543 is transaction mode, so session `SET` does not persist | Migration plan | Documentation only |
| A10 | The user's project has pgvector >= 0.7.0 (and ideally >= 0.8.0) installed | pgvector and Supabase | Below 0.7.0: upgrade the extension before any non-legacy profile. Below 0.8.0: no iterative scan, rely on F-9 only |
| A11 | The live database's `source` constraint differs from the committed SQL | F-1, P-2 | If it matches, Nango and scraper ingestion fail today and nobody noticed; the migration handles both cases |
| A12 | Route-level `maxDuration = 300` on the Nango sync and crawl routes may or may not override `vercel.json`'s 60 s | P-7 | The runner uses its own deadline, so only throughput changes |
| A13 | Voyage returns unit-length vectors | Pattern 5 | None: the registry can normalize; cosine ranking is unaffected |
| A14 | Repository URLs of `docling`, `rapidocr`, `tiktoken` | Package Legitimacy Audit | Informational |
| A15 | A cosine above 0.999 between hosts is a reasonable equality threshold | P-15 | Tune at live verification |
| A16 | `python-stdnum` (LGPL) and `reportlab` are acceptable dependency choices | Standard Stack | Hand-roll the three validators with the test vectors; generate fixture PDFs another way |

## Open Questions (RESOLVED)

1. **How long may a Supabase RPC run with the service key?**
   - What we know: the activation gate counts all current chunks; re-embed batches upsert up to 128 vectors.
   - What's unclear: the effective `statement_timeout` for the `service_role` through PostgREST on the user's plan.
   - Recommendation: design for short statements (batches by bytes, completeness counted per tenant inside one function with an index-only anti-join), set `statement_timeout` on the gate function, and measure on the live project. Live verification item.
   - RESOLVED: short statements by design. Chunk writes go in byte-sized batches of about 1 MB (plan 03-13), re-embed batches default to 128 rows (plan 03-36), and the activation gate counts completeness inside one function that carries its own `SET statement_timeout` (plan 03-09). The effective timeout on the real chunk count is measured as live item 5 of plan 03-48 Task 1.

2. **Where does the Docling sidecar run, and with how much memory?**
   - What we know: the repo has no deploy config for `rag-sidecar/` (no `fly.toml`); the voice agent runs on a 512 MB Fly machine, far too small for layout, table and OCR models.
   - Recommendation: Phase 3 ships the image and a documented size starting point (4 GB RAM, 2 shared CPUs, one parse worker) [ASSUMED], and the deploy config is a live verification task. `RAG_PARSER=llamaparse` stays the default, so nothing depends on the sidecar until the user turns it on or LlamaParse fails.
   - RESOLVED: Phase 3 ships the `docling` Docker target with baked models and no runtime download (plan 03-05) and no deploy config. AGENTS.md documents the starting size of 4 GB RAM, 2 CPUs and one parse worker (plan 03-47). `RAG_PARSER=llamaparse` stays the default (plan 03-03). The sidecar's peak memory on real scans is recorded in live item 2 of plan 03-48 Task 2.

3. **Which LlamaParse v2 `version` string to pin?**
   - What we know: `version` is required; `latest` is accepted; the job response carries no version.
   - Recommendation: a constant in the adapter (`'latest'` until a dated value is confirmed from `GET /api/v2/parse/versions` with a real key), recorded in `parser_version`. Live verification item.
   - RESOLVED: the unified LlamaParse v2 adapter sends `version: "latest"` as a constant, and `parser_used` and `parser_version` record what ran (plan 03-27). The dated value to pin is read from `GET /api/v2/parse/versions` in live item 1 of plan 03-48 Task 2.

4. **Should `chat_upload` and `config_upload` be distinguishable when both post to `/api/process-document`?**
   - Recommendation: the Config UI proxy (`scripts/config-server.js` L2679) adds a form field `upload_source=config_upload`; the route accepts it only when the caller is in `admin_users`, otherwise the source is `chat_upload`. Defaults (D-15) then resolve per source correctly.
   - RESOLVED: adopted as recommended. The Config UI proxy adds `upload_source=config_upload`, and `/api/process-document` honours it only when requireRagAdmin passes; otherwise the source is `chat_upload` (plan 03-31).

5. **Does the `scanned_image` type apply to uploaded image files in the image-upload path?**
   - What we know: image upload produces one caption chunk; `scanned_image` implies OCR of text pages.
   - Recommendation: `image_upload` keeps the `image_caption` chunker regardless of type (the picker is not shown there); a scanned page uploaded as PNG through chat or Config UI upload goes to Docling with `InputFormat.IMAGE` and full-page OCR.
   - RESOLVED: adopted as recommended. `image_upload` keeps the `image_caption` chunker whatever the type, as a source rule in the profiles module, and shows no picker (plan 03-32). An image file uploaded through chat or Config UI upload is submitted to the sidecar with `input_format` image (plan 03-27), and the Docling converter registers `InputFormat.IMAGE` with the same pipeline options, including full-page OCR for `scanned_image` (plan 03-15).

6. **Single-tenant write paths that pass a fake user id.**
   - What we know: scrapers pass `'single-tenant-user'` and `storeDocument` requires `user_id`, while the single-tenant table has no such column.
   - Recommendation: under `unified` the writer never sends `user_id` in single-tenant mode (`s:default`); a test ingests through every path in the single-tenant schema.
   - RESOLVED: adopted as recommended. The writer SQL functions are identical in both schemas (plan 03-10), and writer.ts never sends a user id for an `s:default` scope (plan 03-13). The single-tenant scraper path drops the fake `single-tenant-user` id (plan 03-23), and the ai-to-rag path tests the `s:default` scope (plan 03-24).

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | app, harness | ✓ | v22.23.5 | — |
| Python | sidecar, eval | ✓ (system 3.13.18; uv provides 3.12) | 3.12 via uv | — |
| uv | sidecar and eval environments | ✓ | 0.11.32 | — |
| PGlite + pgvector | DB tests | ✓ | PGlite 0.5.17 (PostgreSQL 18.7), pgvector 0.8.7 | — |
| PyPI access | installing the `chunking` extra | ✓ | — | — |
| Docker CLI | sidecar image build | CLI present, daemon not verified | 29.10.0 | CI builds the image |
| Full Docling with torch and models | real parsing | ✗ (not installed here; several GB) | — | Recorded outputs (D-23), nightly job |
| LlamaCloud, Voyage, DeepInfra, OpenRouter, OpenAI keys | live calls | ✗ | — | Fakes and recorded responses |
| Live Supabase project | migrations, index build, storage | ✗ | — | PGlite, in-memory object store |
| CJK font for fixture PDFs | generator (scanned and Chinese text PDFs) | not checked | — | `fonts-noto-cjk` in the nightly job; committed generator output for default CI |

**Missing dependencies with no fallback:** none for planning or for fixture-based execution.

**Missing dependencies with fallback:** everything live. Each has a ROADMAP live verification item; the plans must not claim them as verified.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 5.1.1 (`tests/**/*.test.ts`), `node:test` through `tsx` for PGlite-backed `*.test.mts`, pytest 9.2.0 in `rag-sidecar/` and `eval/` |
| Config file | `vitest.config.ts`, `rag-sidecar/pyproject.toml`, `eval/pyproject.toml` |
| Quick run command | `npx vitest run tests/rag/ingest` and `node --import tsx --test tests/rag-ingest-*.test.mts` |
| Full suite command | `npx vitest run && node --import tsx --test tests/*.test.mts && uv run --directory rag-sidecar pytest -q && uv run --directory eval pytest -q && npm run test-rag -- --out eval/out/smoke` |

All commands run without live services. New `.test.mts` files must be added to the `tsx tests` step of `.github/workflows/pr-smoke.yml` and to `scripts/ci/check-workflows.py`.

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| DATA-01 | Each of the seven write paths calls `ingest()` under `unified` and its legacy code under `legacy` (spy on injected deps; route handlers invoked in-process) | integration | `npx vitest run tests/rag/ingest/write-paths.test.ts` | ❌ Wave 0 |
| DATA-01 | Boundary check rejects chunk insert/update/upsert, document insert and writer RPC names outside `src/lib/rag/ingest/`; allow-list entries name their removal plan | script self-test | `node --test scripts/tests/check-rag-boundary.node-test.mjs` | ❌ extends 02-20 |
| DATA-02 | A fixture ingested through chat upload, Config UI upload, Nango, scraper and image upload yields chunks with the same promoted columns and `metadata` keys, URL metadata included | integration (PGlite) | `node --import tsx --test tests/rag-ingest-metadata-parity.test.mts` | ❌ Wave 0 |
| DATA-03 | Picker default comes from `GET /api/rag/doc-type-defaults`; picked value reaches `ingest()`; hidden under `legacy` | route + component | `npx vitest run tests/rag/ingest/doc-type-picker.test.ts tests/ui/doc-type-picker.test.ts` | ❌ Wave 0 |
| DATA-04 | One fixture per type applies its profile (parser options sent to the fake sidecar, chunker kind, extractors); profile JSON validates against generated Zod; no `doc_type ===` outside `profiles/` | unit + lint | `npx vitest run tests/rag/ingest/profiles.test.ts && node --test scripts/tests/check-doc-type-branching.node-test.mjs` | ❌ Wave 0 |
| DATA-05 | Recorded `DoclingDocument` → `ParseResult` adapter; every table chunk starts with header and separator rows; token counts within `max_tokens` on `cl100k_base` | contract (pytest, `chunking` extra) | `uv run --directory rag-sidecar --extra chunking pytest -q tests/test_docling_adapter.py` | ❌ Wave 0 |
| DATA-05 | Job API: submit, poll, delete, TTL expiry, bounded queue 429, auth fail-closed, `/health` answers while a job runs (stub converter) | API (pytest) | `uv run --directory rag-sidecar pytest -q tests/test_parse_jobs.py` | ❌ Wave 0 |
| DATA-05 | Fallback chain: LlamaParse missing key, LlamaParse 500, LlamaParse timeout → Docling; both down → plain text for md/txt/csv, `failed` for PDF; `parser_used` recorded | integration | `npx vitest run tests/rag/ingest/parser-chain.test.ts` | ❌ Wave 0 |
| DATA-05 | Interrupt after parse submission, resume to `ready`, no duplicate chunks | integration (PGlite) | `node --import tsx --test tests/rag-ingest-resume.test.mts` | ❌ Wave 0 |
| DATA-05 | Real Docling on the fixture PDFs | nightly, skipped with a notice when the extra cannot install | `uv run --directory rag-sidecar --extra docling pytest -q -m real_docling` | ❌ Wave 0 |
| DATA-06 | Same bytes and same normalized text in one tenant → `skipped_duplicate`, zero new chunks; same content in the other tenant ingests; hash lookups always carry `tenant_key` | two-tenant integration | `node --import tsx --test tests/rag-ingest-dedup-two-tenant.test.mts` | ❌ Wave 0 |
| DATA-06 | Hash normalization vectors (NFKC, line endings, whitespace, case kept) | unit | `npx vitest run tests/rag/ingest/hash.test.ts` | ❌ Wave 0 |
| DATA-07 | Publish v2: retrieval returns only v2 chunks, an old chunk id still loads text and document name, the swap is one transaction (failure injected mid-function leaves v1 current), concurrent publishes serialize | integration (PGlite) | `node --import tsx --test tests/rag-ingest-versioning.test.mts` | ❌ Wave 0 |
| DATA-07 | Legacy parity after migrations and the D-08 filter: gate passes and all paired differences are zero | eval smoke | `npm run test-rag -- --out eval/out/p3-parity && jq -e '.passed == true and .paired.all_zero == true' eval/out/p3-parity/gate.json` | ✅ harness exists |
| DATA-09 | zh/en/it invoice fixtures → validated `InvoiceFields`; bad checksum rejected; failure leaves plain text and `metadata.invoice_extraction.status = 'failed'` | pytest | `uv run --directory rag-sidecar pytest -q tests/test_invoice_extract.py` | ❌ Wave 0 |
| DATA-09 | Line-item table and header in one chunk; `findInvoices` by supplier, date range, amount range within scope; invoice-number question retrieves the exact invoice with `RAG_EXACT_ID_LOOKUP=true` and is unchanged with it off | two-tenant integration | `node --import tsx --test tests/rag-invoices.test.mts` | ❌ Wave 0 |
| DATA-09 | TypeScript and Python tax-id validators agree on the shared vector file | unit, both sides | `npx vitest run tests/rag/tax-id-vectors.test.ts && uv run --directory rag-sidecar pytest -q tests/test_tax_id_vectors.py` | ❌ Wave 0 |
| DATA-10 | Precedence table: picked > Nango folder > Nango connection > source > tenant > `general`; `auto` runs detection; origin stored | table-driven unit | `npx vitest run tests/rag/ingest/resolve-doc-type.test.ts` | ❌ Wave 0 |
| DATA-10 | Admin type change creates a new version, reuses the stored parse output when parser options are equal (zero parser calls asserted), re-parses otherwise; non-admin gets 403 | route + integration | `node --import tsx --test tests/rag-doc-type-change.test.mts` | ❌ Wave 0 |
| DATA-11 | Pictures from the recorded PDF become image chunks with `page_start` and `metadata.image_url`; size and count limits; the chunk streams as `source_images` in the chat characterization harness | integration | `npx vitest run tests/rag/ingest/pdf-images.test.ts tests/chat-source-images.test.ts` | partly ✅ (`chat-source-images` exists) |
| EMB-01 | Voyage sends `input_type` and `output_dimension`; Qwen3 sends the instruction prefix on queries only, truncates to dims and re-normalizes; OpenRouter fallback on 5xx; registry rejects bad dims | unit against fake endpoints | `npx vitest run tests/rag/embeddings/providers.test.ts` | ❌ Wave 0 |
| EMB-02 | `chunk_embeddings` accepts two profiles side by side; wrong-dims insert rejected; activation and rollback flip the pointer; exactly one active | integration (PGlite) | `node --import tsx --test tests/rag-embedding-profiles.test.mts` | ❌ Wave 0 |
| EMB-02 | `match_chunks_by_profile` returns the same visible documents as the legacy RPC on the two-tenant fixture; `anon` cannot execute it | two-tenant integration | `node --import tsx --test tests/rag-profile-rpc-two-tenant.test.mts` | ❌ Wave 0 |
| EMB-03 | Startup check logs `[Embedding Profile] MISMATCH` and sets the flag; per-request dims mismatch and same-dims model mismatch → retrieval status `error`, reason `embedding_profile_mismatch`; the app does not crash; `off` skips everything | unit + integration | `npx vitest run tests/rag/embeddings/mismatch.test.ts tests/rag/instrumentation.test.ts` | ❌ Wave 0 |
| EMB-04 | Dry run reports chunks, tokens, cost per tenant; kill between batches then `--resume` embeds every chunk exactly once; zero parser, sidecar and object-store calls; rollback deletes rows and is refused for the active profile | integration (PGlite) | `node --import tsx --test tests/rag-reembed.test.mts` | ❌ Wave 0 |
| EMB-05 | Dual-write mid-migration; provider failure on the backfilling profile still publishes and the sweep fills the gap; each refusal (incomplete, model mismatch, eval missing, eval failed, pre-migration slice missing) is named; one success then rollback | integration (PGlite) | `node --import tsx --test tests/rag-activation-gate.test.mts` | ❌ Wave 0 |
| CHK-01 | Every chunk has `section_path` (column and `metadata.section_path`); embedding text and `lexical_text` carry the prefix, `content` does not; embedding text rebuilt from stored columns equals the text embedded at ingest | unit + integration | `npx vitest run tests/rag/ingest/section-path.test.ts tests/rag/ingest/embedding-text.test.ts` | ❌ Wave 0 |
| CHK-02 | Clause patterns (zh, en, it); exception lead-in plus list in one chunk; over-long clause split by item with the heading on every piece; contract golden item retrieved as one chunk in `ingest` mode | unit + eval | `npx vitest run tests/rag/ingest/legal-clauses.test.ts` | ❌ Wave 0 |
| SEC-01 | zh, en and it injection fixtures are quarantined (including zero-width and full-width obfuscation); absent from chat, embed, voice, media and eval retrieval; present after release; rule file validates; ReDoS guard rejects a bad pattern; admin routes return 403 to non-admins | integration + route | `node --import tsx --test tests/rag-quarantine.test.mts && npx vitest run tests/rag/ingest/injection-scan.test.ts tests/rag/admin-routes.test.ts` | ❌ Wave 0 |
| XLG-02 | Contract accepts `cross_lingual` with `evidence_language`; at least 4 approved items per pair; evidence language equals the corpus folder; no parallel-document gold; `by_language_pair` in the report; baseline re-recorded with zero paired differences on old items | pytest + eval | `uv run --directory eval pytest -q tests/test_fixture_coverage.py tests/test_cross_lingual.py && npm run test-rag -- --out eval/out/xlg` | partly ✅ (`test_fixture_coverage.py` exists) |
| Cross-cutting | Schema equality: frozen setup plus migrations equals current setup plus migrations, both modes; migrations idempotent (run twice); legacy insert shapes accepted | integration (PGlite) | `node --import tsx --test tests/rag-schema-equality.test.mts` | ❌ Wave 0 |
| Cross-cutting | Contracts: new Pydantic models exported, Zod regenerated, no diff | parity | `npm run gen:schemas && git diff --exit-code -- rag-sidecar/schemas src/lib/rag-eval/contracts.generated.ts tests/fixtures/contracts/samples.json` | ✅ pipeline exists |
| Cross-cutting | Config drift with the new variables | script | `node scripts/check-config.mjs` | ✅ (pattern needs `VOYAGE_*`, `DEEPINFRA_*`) |
| Cross-cutting | `ingest` fixture mode gate and per-profile comparison report | eval | `npm run test-rag -- --fixture-mode ingest --out eval/out/ingest` and `npm run test-rag -- --embedding-profile voyage-4-large-2048 --out eval/out/profile-voyage` | ❌ flags are new |

### Sampling Rate

- **Per task commit:** the task's own test file plus `npm run typecheck:new`.
- **Per wave merge:** `npx vitest run`, all `tests/*.test.mts`, both pytest suites, `node scripts/check-config.mjs`, `node scripts/ci/check-rag-boundary.mjs`.
- **Phase gate:** full suite, legacy parity (zero paired differences), `ingest`-mode gate, per-profile comparison, schema parity, before `/gsd-verify-work`.

### Wave 0 Gaps

- [ ] `eval/harness/pglite-supabase.mts`: load `supabase/migrations/*.sql` after the setup file
- [ ] `eval/harness/fake-edge.mts`: RPC allow-list for the writer, re-embed, activation and profile-search functions; new columns and filters
- [ ] `tests/helpers/ingest-fakes.ts`: in-memory `ObjectStore` (with the Supabase key regex), fake sidecar client, fake LlamaParse v2 client, recorded captioner, counting embedders
- [ ] `eval/harness/fixture-embedder.mts`: `dims` argument; fake Voyage and Qwen3 endpoints in the fake edge
- [ ] `eval/fixtures/ingest/`: generator script, typed fixtures (table PDF, scanned zh/en/it, contract with the exceptions clause, zh/en/it invoices, PDF with images, zh/en/it injection documents), recorded `ParseResult` and Docling JSON, `manifest.json` keyed by `file_sha256`
- [ ] `tests/fixtures/sql/pre-phase3-{single,multi}-tenant-setup.sql`: frozen copies for the schema-equality test
- [ ] `tests/fixtures/tax-id-vectors.json`: generated with `python-stdnum`
- [ ] Sidecar: `chunking` extra and `python-multipart` in `pyproject.toml`, regenerated `uv.lock`, pytest marker `real_docling`
- [ ] CI: `uv sync --extra chunking` in PR jobs, new `.test.mts` files in the `tsx tests` step, a slim Docker target for the PR image build (the `docling` target builds only in the nightly job), `check-workflows.py` needles

## Security Domain

`security_enforcement` is enabled, ASVS level 1, block on high.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | Supabase SSR session for upload, status, resume and defaults routes; sidecar shared secret (constant-time, fail closed, Phase 1 D-21) |
| V3 Session Management | no (unchanged) | — |
| V4 Access Control | yes | `TenantScope` for every ingest and query; `admin_users` check per request on `/api/rag/admin/*` with no cache, 403 otherwise; `tenant_key` verified inside every writer function; functions and tables closed to `anon` and `authenticated` |
| V5 Input Validation | yes | Zod (`zod/v3`) on every new route; Pydantic on sidecar requests; profile and rule files validated at load; file size (20 MB) and MIME allow-list; page-count cap before parsing |
| V6 Cryptography | yes (hashing only) | `node:crypto` SHA-256 for file and content hashes; no custom crypto |
| V8 Data Protection | yes | Originals in a private bucket reachable only with the service key; no document text in logs or traces; quarantine snippets limited and never logged |
| V12 Files and Resources | yes | Server-generated ASCII storage keys (no user-controlled path segments), filename kept only as data; no temp files named after user input (the legacy `path.join(tempDir, filename)` stays on the legacy branch only) |
| V13 API | yes | Structured JSON errors, no stack traces; sidecar job ids are random UUIDs and jobs are not listable |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Cross-tenant dedup oracle (learning that another tenant holds a file by hash or by timing) | Information disclosure | Hash lookups only inside one `tenant_key`; a duplicate in another tenant follows the normal path with normal timing; two-tenant test |
| Writer or search function executed with the anon key | Elevation of privilege | `REVOKE … FROM PUBLIC, anon, authenticated`; privilege test (P-16) |
| Client-supplied tenant or user id (`ai-to-rag` body `userId`, form `organization_id`) | Spoofing | Scope minted server-side from the session with membership check; body ids ignored or 403 |
| Dynamic SQL in `match_chunks_by_profile` | Tampering | Only an integer from the registry and a `%L` literal are interpolated; everything else is bound |
| Prompt injection inside documents, including obfuscation (zero-width characters, full-width forms, OCR spacing) | Tampering | SEC-01 scan on normalized text and captions; quarantine enforced in SQL with no switch (D-08) |
| Rule files as a ReDoS vector | Denial of service | Pattern length cap, no backreferences or nested quantifiers, bounded windows |
| Oversized or hostile files (huge page counts, decompression bombs, malformed PDFs) | Denial of service | Size limit, page cap, Docling `document_timeout`, process-pool isolation, bounded queue |
| Path traversal or key injection through filenames | Tampering | Storage keys built from UUIDs and a fixed basename; original filename never used in a path |
| SSRF through fetched URLs (LlamaParse presigned image URLs, scraper URLs) | Information disclosure | Fetch only `https` URLs whose host matches the expected provider domains; no redirects to private ranges |
| PDF image URLs are public by URL | Information disclosure | Same exposure as today's image RAG; unguessable path (`rag/<tenant_key>/<lineage_id>/<version>/…` in `chat-images`); private images with signed URLs are a later change because `source_images` must stay unchanged in this phase |
| Quarantine bypass through the legacy writer or a legacy pipeline | Tampering | `RAG_INJECTION_SCAN` only acts under `unified`; this is documented as a limit of `legacy`. The D-08 filter itself applies to both pipelines |
| Secrets in logs (provider keys, sidecar secret) | Information disclosure | Log presence only; provider error bodies truncated and never echoed with headers |
| Stale or forged eval evidence used to pass the activation gate | Tampering | Evidence written only by the CLI with the service key, bound to `backfill_run_id` and checked against `embedded_at` |

## Sources

### Primary (HIGH confidence)

- Installed packages inspected and executed this session: `docling-slim` 2.152.0, `docling-core` 2.108.0, `rapidocr` 3.10.0, `tiktoken` 0.14.0 (Python) and `tiktoken` (npm), `python-stdnum` 2.2, `pypdfium2` 5.15.2
- PGlite 0.5.17 with pgvector 0.8.7: `halfvec` partial expression HNSW, dimension limits, filtered-scan behaviour, publish function, legacy-insert behaviour against both setup files
- PyPI JSON API (`pypi.org/pypi/<name>/json`) for versions, upload dates, `requires_python` and `requires_dist`
- `https://api.deepinfra.com/models/Qwen/Qwen3-Embedding-8B` and its schema endpoints; the model card file it links
- `https://openrouter.ai/api/v1/embeddings/models`
- `github.com/supabase/postgres` `nix/ext/versions.json`; `github.com/supabase/storage` `src/storage/limits.ts`
- Repository files read this session (paths and lines cited inline)

### Secondary (MEDIUM confidence)

- [Voyage embeddings docs](https://docs.voyageai.com/docs/embeddings)
- [LlamaParse REST API guide](https://developers.llamaindex.ai/llamaparse/parse/guides/api-reference/), [v1 to v2 migration](https://developers.llamaindex.ai/llamaparse/parse/guides/migration-v1-to-v2/), [parse job reference](https://developers.llamaindex.ai/reference/resources/parsing/methods/get/)
- [pgvector README](https://github.com/pgvector/pgvector/blob/master/README.md)
- [Supabase HNSW indexes](https://supabase.com/docs/guides/ai/vector-indexes/hnsw-indexes), [Supabase Storage access control](https://supabase.com/docs/guides/storage/security/access-control)
- [Next.js instrumentation](https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation)
- [OpenRouter embeddings](https://openrouter.ai/docs/api/reference/embeddings)
- [uv with PyTorch](https://docs.astral.sh/uv/guides/integration/pytorch/)
- [Docling chunking concepts](https://docling-project.github.io/docling/concepts/chunking/)

### Tertiary (LOW confidence)

- Web search summaries on Supabase pgvector availability (superseded by the `versions.json` reading above)
- Everything in the Assumptions Log

## Metadata

**Confidence breakdown:**

- Standard stack: HIGH for versions and APIs (registry and installed source); MEDIUM for the choice of RapidOCR until real zh/it scans are tested
- Architecture: HIGH for the SQL patterns (executed in PGlite); MEDIUM for the TypeScript layout, because it extends Phase 2 files of which only the 02-07 skeleton exists and the rest (stage runner, trace collector, resolvers, boundary check) are still plans
- Pitfalls: HIGH where reproduced here (F-1, F-3, F-8, F-9, P-4, P-12); MEDIUM for hosted-service limits (timeouts, body size)
- Vendor behaviour (LlamaParse v2 shapes, Voyage, Qwen3 hosts): MEDIUM, from official docs and public metadata endpoints without live keys. The research seam classifies fetched web pages as LOW; those claims carry `[CITED]` tags and a live verification item

**Research date:** 2026-11-23
**Valid until:** 2026-11-30 for Docling (weekly releases) and vendor APIs; 2026-12-23 for the schema, pgvector and codebase findings, provided Phase 2 lands the planned `src/lib/rag/` contracts unchanged
