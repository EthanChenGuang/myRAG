# Phase 3: Unified Ingestion & Embedding Profiles - Context

**Gathered:** 2026-11-23
**Status:** Ready for planning
**Mode:** `--auto`. Every gray area was resolved with the recommended option, because the user's standing instruction is "all questions follow your recommendations". Phase 2 is being executed in the same working tree while this was written, so these decisions target Phase 2's planned contracts (`02-CONTEXT.md` and plans 02-07..02-20), not only today's code.

<domain>
## Phase Boundary

Every document enters the knowledge base through one TypeScript entry point, `ingest()` under `src/lib/rag/ingest/`. Each document is typed, deduplicated within its tenant, versioned, scanned for prompt injection and stamped with the same metadata. Its chunks get a section path and are embedded under a switchable embedding profile. Profiles are stored side by side, activated by a pointer flip that can be rolled back, and filled by a resumable re-embed job that never re-parses. With `RAG_INGEST_PIPELINE=legacy` and `RAG_EMBEDDING_PROFILES=off` (the defaults), ingestion and retrieval behave exactly as Phase 2 leaves them.

**In scope:**

- **Ingestion entry point and writer.** One `ingest()` behind every write path into the knowledge base:
  - chat upload and Config UI upload (`process-document`)
  - Nango sync
  - scrapers
  - image upload
  - `ai-to-rag`

  One chunk writer is the only code that inserts `document_chunks`.
- **Schema.** Additive migrations for:
  - document identity, versions, status and hashes
  - promoted chunk metadata columns
  - `section_path`, `embedding_text_version` and `lexical_text`
  - quarantine
  - doc-type defaults
  - embedding profiles and per-profile vector storage
  - re-embed runs
- **Document types.** Six types, each with a processing profile defined as data (DATA-03, DATA-04). Admin defaults per tenant and per source, applied with the DATA-10 precedence. Rules-based auto-detect. A picker in the chat upload and the Config UI upload. Changing a document's type re-processes it as a new version.
- **Parsing.** Docling runs as an async parse job in the sidecar, with:
  - HybridChunker
  - table headers repeated in each chunk
  - an explicit tokenizer
  - OCR for zh/en/it

  The parser is switchable with LlamaParse, falls back to Docling, and is recorded as `parser_used`.
- **Chunking.** CHK-01 section paths. The CHK-02 clause-aware legal chunker.
- **Invoices.** The DATA-09 invoice extraction and promoted invoice fields. Exact invoice-number lookup.
- **PDF images.** The DATA-11 image chunks extracted from PDFs.
- **Injection quarantine.** The SEC-01 ingestion scan, with rules stored as data, plus admin release or delete in the Config UI.
- **Embedding profiles.** EMB-01..EMB-05:
  - the provider registry (OpenAI, Voyage, hosted Qwen3)
  - side-by-side storage with `halfvec`
  - the active-profile pointer
  - the startup and per-request mismatch checks
  - the re-embed job
  - dual-write
  - the activation gate
- **Evaluation.** The `cross_lingual` golden category (XLG-02) with its legacy baseline. Per-profile comparison tooling. An ingest-mode fixture run that sends the corpus through the real `ingest()`.

**Out of scope (other phases):**

- **Phase 3.1:**
  - tiered parse routing and the preflight probe
  - the cloud/budget constraints
  - the `ingestion_jobs` ledger
  - the parse cache
  - the async upload queue (202 plus worker)
  - bulk backfill
  - parser eval
- **Phase 4:**
  - hybrid lexical search and its index on `lexical_text`
  - query-side tokenization
  - DATA-08 filters inside hybrid search
  - rerankers
  - parent-child retrieval (CHK-03/04)
  - the chunk-size sweep (CHK-05)
- **Phase 5.1:** retrieval-time injection checks (SEC-03).
- **Phase 6:** query translation (XLG-01).
- **Phase 7:** syncing profiles to Weaviate and Qdrant.

Phase 3 must leave clean seams for all of these (see D-02, D-10, D-13, D-18, D-30, D-32, D-35).

</domain>

<decisions>
## Implementation Decisions

### Ingestion entry point and rollout
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

### Schema, identity and versions
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

### Dedup and versioning
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

### Document types, profiles and defaults
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

### Parsing
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

### Chunking and section paths
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

### Invoices and exact identifiers
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

### PDF images
- **D-29:** Images inside PDFs come from Docling `pictures[]` or the LlamaParse image list, which `process-document` already extracts. Images smaller than a minimum area (default 0.02 of the page), or above a per-document cap (default 30), are skipped.

  Each kept image is:
  1. stored in tenant-scoped storage
  2. captioned by the existing image-RAG captioning (the same function `processImageDocument` uses today)
  3. written as an `image` chunk of the same document and version, with `page_start`, `metadata.image_url`, `section_path` from the enclosing heading, and the caption as `content`

  `source_images` streaming is unchanged, because it reads `metadata.image_url`. A fixture test asserts:
  - the image chunk's page number
  - that the image chunk streams as `source_images` through the chat characterization harness

  Behind `RAG_PDF_IMAGE_CHUNKS` (default `false`). Captioning in tests uses a recorded fake.

### Prompt-injection quarantine
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

### Lexical text (seam for Phase 4)
- **D-32:** `lexical_text` is produced by a shared tokenizer module, `src/lib/rag/lexical/tokenize.ts`:
  - **zh:** `Intl.Segmenter` word segmentation.
  - **en and it:** whitespace and punctuation split, lowercase, diacritics folded.
  - **Identifiers:** tokens such as invoice numbers and model numbers are kept verbatim.

  The output carries a `LEXICAL_VERSION`. This settles the research conflict in favor of one application tokenizer (ARCHITECTURE and PITFALLS) over PGroonga. Phase 4 owns the index, the query side and the Chinese exact-term test (RET-03), and can rebuild `lexical_text` from stored chunk text if it bumps the version.

  **Reversibility:** reversible. The text can be rebuilt from stored columns.

### Embedding profiles
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

### Re-embed job and activation gate
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

### Evaluation
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

### Config, endpoints and observability
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

### Decision index
IDs cited by the plans. Each entry summarizes a decision recorded above in this file.
- **D-01:** one `ingest({scope: TenantScope, source, sourceKey, file|text, filename, mimeType, docType?, options, signal, trace})` via `@/lib/rag`, returning `IngestResult` (ready, skipped_duplicate, quarantined, processing, failed); each write path resolves its scope server-side (costly)
- **D-02:** `ingest()` = idempotent named stages (identify, file_hash_dedup, store_original, parse, content_hash_dedup, scan_injection, chunk, enrich, extract, images, embed, write, publish); state on the document row; `resumeIngest`; Phase 3.1 reuses the stages unchanged
- **D-03:** `RAG_INGEST_PIPELINE=legacy|unified`, default legacy = today's writers byte for byte; switch read per request
- **D-04:** boundary check: only `src/lib/rag/ingest/` writes `document_chunks` and `documents`; legacy writers allow-listed with the plan that removes them
- **D-05:** `supabase/migrations/` ordered idempotent SQL applied by setup-database.sh; setup files updated to match (CI schema-equality test); PGlite loads them; additive with safe defaults (one-way)
- **D-06:** one documents row per version: lineage_id, widened source enum, source_key, version, is_current, superseded_by, status, processing state, doc_type and origin, doc_date, language, file_sha256, content_hash, parser_used and version, profile id, original_path, generated tenant_key; partial unique on (tenant_key, source, source_key) WHERE is_current (costly)
- **D-07:** chunk promoted columns (tenant_key, version, is_current, status, doc_type, doc_date, language, source, page_start/end, section_path, content_hash, chunk_kind, parser_used, embedding_text_version, lexical_text), mirrored in metadata; URL metadata kept; no lexical index yet
- **D-08:** all retrieval RPCs filter is_current AND status='ready', no switch; parity must stay zero-diff
- **D-09:** file_sha256 (skip parse) and normalized content_hash (NFKC, whitespace, line endings; dedup authority), compared within tenant_key only; two-tenant test (costly)
- **D-10:** identity (tenant_key, source, source_key) per the ingestion-routing spec; uploads use logical folder + normalized filename; same hash skip, new hash = new version, known hash under new identity = duplicate
- **D-11:** `rag_publish_document_version` swaps is_current in one transaction; old rows kept so citations resolve; test with an old citation
- **D-12:** doc types: financial_report, contract_legal, invoice_receipt, product_technical, scanned_image, general (costly)
- **D-13:** profiles as data in `config/rag/processing-profiles.json` (Pydantic ProcessingProfile, Zod generated); reserved min/max tier and parent_child fields; CI forbids doc_type branching outside profiles/
- **D-14:** starting per-type parser, chunker, token sizes (cl100k_base) and extractors as in the table above
- **D-15:** `rag_doc_type_defaults` table; precedence picked > Nango folder > Nango connection > source > tenant > general; `auto` runs detection; origin stored
- **D-16:** rules-first auto-detect (filename, zh/en/it keywords, text-layer share, invoice/VAT patterns), confidence < 0.6 → general; optional LLM detector `RAG_DOC_TYPE_LLM_DETECT` (Pydantic DocTypeDetection)
- **D-17:** per-file picker in chat upload and Config UI upload, pre-selected via `GET /api/rag/doc-type-defaults`; hidden under legacy
- **D-18:** admin type change re-ingests as a new version; originals and parse output in private `rag-originals/<tenant_key>/...`; reuses parse output when parser options are unchanged
- **D-19:** `RAG_PARSER=llamaparse|docling` default llamaparse; chain configured → other → plain text → failed retryable; parser_used and parser_version recorded
- **D-20:** sidecar `POST/GET/DELETE /v1/parse/jobs` with Pydantic ParseJobRequest and ParseResult; bounded worker pool; TTL results; stateless toward Supabase; `docling` extra (costly)
- **D-21:** app polls within `RAG_PARSE_POLL_BUDGET_MS` (45 s); otherwise processing with job id; status GET and resume POST; no queue (3.1)
- **D-22:** HybridChunker repeat_table_header, tokenizer cl100k_base on both sides, OCR zh/en/it (engine chosen by researcher), header row on every table chunk
- **D-23:** recorded Docling outputs plus a fake sidecar in CI; adapter contract tests; optional nightly real-Docling job; fixture PDFs from a deterministic generator
- **D-24:** section_path on every chunk; embedding text = path prefix + content + type template, rebuilt from stored columns by a versioned template; lexical_text same prefix; LLM content plain (costly)
- **D-25:** legal_clauses chunker with clause patterns as data; exception lead-in and list kept together; over-long clauses split by item with the heading on every piece; contract fixture item
- **D-26:** sidecar `POST /v1/extract/invoice` returning Pydantic InvoiceFields; deterministic zh/en/it extraction with tax-ID checksums; optional LLM fill-in `RAG_INVOICE_LLM_EXTRACT`; failures leave plain text and are reported
- **D-27:** promoted invoice columns with tenant-leading btree indexes; full fields in metadata.invoice; header and line-item table in one chunk; `findInvoices(scope, filters)`
- **D-28:** optional `exact_id_lookup` stage (`RAG_EXACT_ID_LOOKUP`) that adds exact-ID matches within scope ahead of vector results
- **D-29:** PDF images (Docling pictures / LlamaParse images) → storage → existing captioning → image chunks with page and image_url on the same document; size and count limits; `RAG_PDF_IMAGE_CHUNKS`
- **D-30:** injection rules as data (`config/rag/injection-rules.json`, Pydantic InjectionRuleSet), NFKC case-folded matching on text and captions; `RAG_INJECTION_SCAN=off|quarantine`; chunks written but quarantined; rules reused by SEC-03
- **D-31:** quarantined rows excluded everywhere (D-08); Config UI Quarantine panel with admin-only list, release (via publish function, audited) and delete; `/api/rag/admin/*` requires admin_users, fail closed; test across all retrieval profiles
- **D-32:** shared tokenizer `src/lib/rag/lexical/tokenize.ts` (Intl.Segmenter for zh, fold for en/it, identifiers verbatim) with LEXICAL_VERSION writes lexical_text; Phase 4 owns index, query side and the zh exact-term test
- **D-33:** EmbeddingProvider registry extending Phase 2 embeddings/openai.ts; Voyage input_type; Qwen3 via DeepInfra with OpenRouter fallback, query-only instruction prefix, MRL truncation and re-normalization; new keys as placeholders
- **D-34:** profiles openai-3-small-1536 (existing column), voyage-4-large-2048 and qwen3-8b-2048 (halfvec); >2000 dims → halfvec, >4000 rejected
- **D-35:** `chunk_embeddings` (chunk_id, profile_id, tenant_key, halfvec, embedding_model, dims) with a partial expression HNSW index per profile; legacy rows record model and dims; `match_chunks_by_profile` server-role only; adapter picks the RPC by active profile (costly)
- **D-36:** `embedding_profiles` table with exactly one active; activate and rollback SQL functions; CLI `rag:embedding` and Config UI panel; `RAG_EMBEDDING_PROFILES=off|on` default off; deployment-level
- **D-37:** startup check in `src/instrumentation.ts` and per-request dims and model asserts; mismatch → logged and retrieval status error `embedding_profile_mismatch`, app not crashed
- **D-38:** `npm run rag:reembed` (TS module, reprocess-documents.js `--reembed` delegates); reads stored chunk text only (zero parser calls asserted); `embedding_backfill_runs` cursor; upsert; dry-run cost; rollback; kill-and-resume test
- **D-39:** dual-write to active and every backfilling profile in ingest's embed stage; provider failure on the backfilling profile records a gap for the next pass
- **D-40:** activation refuses unless the target has 100% of current ready chunks (same transaction), passing eval evidence with a pre_migration slice, and matching model and dims on every row
- **D-41:** golden `cross_lingual` with evidence_language, ≥4 approved items for each of 6 direction pairs; by_language_pair; slice and pairs gated; baseline under legacy with zero paired diffs on old items
- **D-42:** eval fixture modes `prechunked` (default, baseline and parity) and `ingest` (real ingest() with fakes and typed fixtures, own baseline)
- **D-43:** per-profile eval via `--embedding-profile`, fake Voyage and Qwen endpoints, comparison report with the cross-lingual default-candidate rule; the real decision is live verification
- **D-44:** new env vars and defaults listed above, five locations, managed in env-manifest; embedding model ids live in the registry, not the chat model lists
- **D-45:** new authenticated endpoints (doc-type defaults, ingest status and resume, type change, quarantine, embedding profiles) and three Config UI panels
- **D-46:** one Langfuse ingestion trace per document with a span per stage; `[Ingest Trace]` fallback; `[Ingest]` and `[Embedding Profile]` log prefixes; no document text logged
- **D-47:** rollout order: migrations and filter plus parity → contracts → XLG-02 baseline → ingest core → one write path per plan → Docling → chunking → invoices → images → quarantine → picker → embeddings → re-embed and gate → comparison → final gates

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Scope and requirements
- `.planning/ROADMAP.md` §"Phase 3: Unified Ingestion & Embedding Profiles": the goal, ten success criteria and live verification. Also §"Phase 3.1", which must stay compatible.
- `.planning/REQUIREMENTS.md`: DATA-01..07, DATA-09..11, EMB-01..05, CHK-01, CHK-02, SEC-01, XLG-02. Plus the mapping notes on DATA-08 (Phase 4) and DATA-12..17 (Phase 3.1).
- `.planning/PROJECT.md` §Constraints and §Key Decisions:
  - config sync
  - pgvector dimension limit and `halfvec`
  - the Python sidecar for Docling
  - Pydantic as the contract source
  - doc-type picker per file
  - Qwen3 on hosted inference

### Specs
- `.planning/specs/ingestion-routing.md`: the Phase 3.1 design. Phase 3 must provide what it builds on:
  - stable identity `(tenant, source, source_key)`
  - `parser_used`
  - file and content hashes
  - idempotent stages
  - the DATA-07 swap
  - the per-type profile with `min_tier`/`max_tier`
  - one `ingest()` entry
- `.planning/specs/semantic-cache.md`: document insert, replace and delete invalidate the cache in Phase 6. Phase 3's publish and delete are the events it will hook.
- `.planning/specs/query-rewrite-gate.md`: protected tokens. Same identifier shapes as D-28.

### Prior phase decisions
- `.planning/phases/01-evaluation-harness-baseline/01-CONTEXT.md`:
  - D-04 golden contract
  - D-06 Pydantic→Zod
  - D-08 fixture embedder
  - D-13 quote span match
  - D-18 edge fakes
  - D-21 sidecar auth
- `.planning/phases/02-unified-retrieval-pipeline-tenant-scope/02-CONTEXT.md`:
  - D-01 `runRetrieval`
  - D-03 stage runner
  - D-05/06 status
  - D-07 `TenantScope` and `tenantKey`
  - D-11 no off switch for security
  - D-13 embedding re-home
  - D-14 boundary check
  - D-17 no RPC change in Phase 2
  - D-18..20 tracing
  - D-25 golden and baseline rules
  - §"Adjustments after research"
- `.planning/phases/02-unified-retrieval-pipeline-tenant-scope/02-07-PLAN.md`: `src/lib/rag/` core layout, `deps.ts`, `embeddings/openai.ts` (`embedText` / `embedBatch`), `backend/supabase-rpc.ts`.
- `.planning/phases/02-unified-retrieval-pipeline-tenant-scope/02-19-PLAN.md`: ingestion embeddings routed through `@/lib/rag`. This is Phase 3's starting point.
- `.planning/phases/02-unified-retrieval-pipeline-tenant-scope/02-20-PLAN.md`: the boundary check that D-04 extends.

### Research
- `.planning/research/ARCHITECTURE.md`:
  - Pattern 4 (side-by-side embedding profiles)
  - Pattern 5 (shared lexical normalizer)
  - Pattern 6 (processing profiles as data)
  - the ingestion flow
  - the sidecar parse contract
  - the schema additions table
- `.planning/research/PITFALLS.md`:
  - sync Docling in handlers
  - cross-tenant hashes
  - tokenizer mismatch
  - mixed-model indexes
  - in-place ALTER
  - pooler index builds
- `.planning/research/SUMMARY.md` §"Phase 3", §"Phase 4" (embedding registry), §"Gaps to Address" (lexical approach, settled by D-32).
- `.planning/research/STACK.md`: Docling, Voyage and Qwen3 hosting notes.

### Codebase maps
- `.planning/codebase/ARCHITECTURE.md`, `.planning/codebase/CONCERNS.md`, `.planning/codebase/INTEGRATIONS.md`

### Code
- **Legacy ingestion path:**
  - `src/app/api/process-document/route.ts`: its own LlamaParse upload and poll (~L175–365), image extraction (~L373), document insert (~L440), chunk insert with the `Document: X. Chunk n of m` prefix (~L485–523), character chunker (~L68)
  - `src/lib/document-processor.ts`: `processDocument`, `processImageDocument`, semantic chunking that drops section and subsection
  - `src/lib/supabase.ts` `storeDocument` (~L165–275): the chunk metadata and URL metadata to preserve
- **Other write paths:**
  - `src/app/api/upload/route.ts` (image upload)
  - `src/app/api/ai-to-rag/route.ts`
  - `src/lib/nango/document-adapter.ts`, `src/lib/nango/sync-manager.ts` (`processDocumentWithMetadata` call sites ~L322, L473, L613)
  - `src/lib/scrapers/scraper-adapter.ts`
- **Schema:** `supabase/single-tenant-setup.sql`, `supabase/multi-tenant-setup.sql` (documents ~L144 with the `source` CHECK; document_chunks ~L203 with `vector(1536)` and HNSW; `match_documents_by_workspace`), `scripts/setup-database.sh`
- **Scripts and config:** `scripts/rag/reprocess-documents.js`, `scripts/rag/env-manifest.json`, `scripts/check-config.mjs`, `scripts/config-server.js`, `scripts/config-ui/index.html`
- **Eval harness:** `eval/harness/corpus.mts`, `fake-edge.mts`, `fixture-embedder.mts`, `pglite-supabase.mts`, `two-tenant.mts`; `eval/fixtures/`
- **Sidecar:** `rag-sidecar/src/rag_sidecar/` (`main.py`, `auth.py`, `contracts/`, `export_schemas.py`), `rag-sidecar/pyproject.toml`, `rag-sidecar/Dockerfile`

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **Phase 2 core (being built now):**
  - `TenantScope` and resolvers in `src/lib/rag/tenant/`
  - stage runner and trace collector in `src/lib/rag/pipeline.ts` and `trace/`
  - `embeddings/openai.ts` (`embedText` / `embedBatch`)
  - `backend/supabase-rpc.ts`
  - the boundary check
  - the two-tenant fixture

  Ingestion reuses the scope, the trace collector and the embeddings entry. Retrieval gains the profile-aware backend choice and the optional `exact_id_lookup` stage.
- **Existing helpers worth keeping:**
  - `temporal-metadata-extractor.ts` and the financial-entity extraction in `storeDocument`: re-homed as profile extractors.
  - `url-extractor` URL metadata: kept verbatim.
  - `processImageDocument`'s captioning: reused for PDF images.
- **Phase 1 eval stack:**
  - PGlite with the repo SQL
  - the fake PostgREST edge
  - the fake OpenAI embeddings endpoint and the deterministic fixture embedder (extend it to any dims, and add Voyage and Qwen fakes)
  - `npm run gen:schemas` for Pydantic→Zod
  - the check-config manifest
- **Sidecar skeleton:** FastAPI with shared-secret auth, `/health` and `/ready`, the contracts package and schema export. The parse job and invoice extraction plug in here.

### Established Patterns
- Zod via `zod/v3`, `validateRequest`, structured JSON errors, bracketed log prefixes, env read through `src/lib/env.ts`, no new `any`.
- Provider switches are env-driven (`USE_REPLICATE_PROVIDER` style). New switches default to today's behavior.
- The admin identity comes from the `admin_users` table and `/api/admin/check`. The Config UI forwards the `Authorization` header through `config-server.js`.

### Integration Points
- Every write path listed in Canonical References switches to `ingest()` under `unified`.
- The retrieval RPCs gain the D-08 filter. The backend adapter gains a profile switch and the new `match_chunks_by_profile` RPC.
- New tables: `rag_doc_type_defaults`, `embedding_profiles`, `chunk_embeddings`, `embedding_backfill_runs`. New storage bucket: `rag-originals`.
- Sidecar routes: `/v1/parse/jobs`, `/v1/extract/invoice`.
- Config UI panels: document-type defaults, quarantine, embedding profiles. The doc-type picker goes in the chat upload component.
- `src/instrumentation.ts` (new) holds the embedding profile startup check.
- CI additions:
  - schema-equality test for setup plus migrations
  - the doc-type branching lint
  - single-writer rules in the boundary check
  - the optional nightly real-Docling job
  - ingest-mode and per-profile eval runs

</code_context>

<specifics>
## Specific Ideas

- **Tenant isolation:** cross-tenant leakage is the worst failure. Dedup, versioning, defaults, quarantine, invoices, `findInvoices`, `exact_id_lookup`, `chunk_embeddings` and the re-embed job are each tested with the two-tenant fixture.
- **Fixture data:** all fixtures (invoices, contracts, scans, injection documents) are synthetic. They contain no real company names, tax IDs or phone numbers. Tax IDs are generated to pass checksums but are not assigned to any real entity, following AGENTS.md rule 7.
- **No live services here:** no live keys, Supabase or Docker are available. The live checks are the ROADMAP Phase 3 live verification items:
  - real LlamaParse
  - real Docling OCR on scanned zh and it documents
  - Voyage, DeepInfra and OpenRouter keys
  - the `halfvec` HNSW build
  - the per-profile eval on the real golden set
  - a real Nango sync

</specifics>

<deferred>
## Deferred Ideas

- **Editing processing profiles in the Config UI** (parser options, extractors). This is OPS-03 (v2). Phase 3 makes only the defaults editable.
- **Document version-history UI.** This is UX-06 (v2). Phase 3 keeps old versions, but the UI shows only the current one.
- **Chat filter chips for doc type, date and source.** This is UX-05 (v2). Phase 3 provides the columns, and Phase 4 adds the retrieval filters.
- **Removing the legacy writers and the `RAG_INGEST_PIPELINE` switch.** This happens after Phase 7 sets the release defaults.
- **Replacing `exact_id_lookup` with Phase 4 hybrid lexical search** once eval shows lexical search covers exact invoice numbers.
- **LLM-based doc-type detection or invoice extraction as the default.** This needs eval evidence on real documents first.
- **Per-tenant embedding profiles.** This is out of scope ("per-tenant provider choice").
- **Garbage collection of superseded versions and their originals** (a retention policy). This belongs in the backlog. Citations need the old rows for now.

</deferred>

---

*Phase: 03-unified-ingestion-embedding-profiles*
*Context gathered: 2026-11-23*
