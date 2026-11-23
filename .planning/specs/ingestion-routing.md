# Tiered parsing, ingestion ledger, incremental queue and bulk backfill (DATA-12..17) — spec

Status: added 2026-11-23, Phase 3.1. Everything here is behind switches; with `RAG_PARSE_ROUTING=fixed` (default) ingestion behaves as Phase 3 leaves it (LlamaParse, falling back to Docling per DATA-05).

## Priority order

Routing decisions apply these in order:

1. **Hard constraints:** whether cloud parsing is allowed, and the hard budget cap.
2. **Quality floor:** the document-type profile's minimum tier, and the post-parse quality check.
3. **Cost:** the cheapest tier that passes the quality check.
4. **Speed:** concurrency and progressive mode.

**Exception:** when a user must query a file right after uploading it, progressive mode (DATA-15) puts speed ahead of cost for that first answer.

## Tiers

| Tier | Name | When | Technology |
|---|---|---|---|
| 0 | `native` | txt, md, csv, html, docx | Existing extractors in the app, no parser service |
| 1 | `fast` | Digital PDF with a good text layer and no table or multi-column hints | Docling with the pypdfium2 backend, OCR off, table structure off |
| 2 | `structured` | Tables, multi-column layout, or some pages without a text layer | Docling full: layout model, TableFormer, OCR (zh/en/it) on pages without text, HybridChunker |
| 3 | `premium` | Fully scanned or complex layouts, or escalated from tier 2 | LlamaParse; only when cloud parsing is allowed and budget remains |

Tier 1 keeps Docling's output format.

PyMuPDF is not used. It is AGPL-3.0, while pypdfium2 is Apache/BSD.

Reducto stays out of scope (REQUIREMENTS "Out of Scope").

## Preflight probe (sidecar, pypdfium2, target < 1 s for 100 pages)

- **Measured per file:**
  - page count
  - encryption
  - share of pages with a text layer
  - characters per page
  - image area ratio
  - table hints: ruling lines, aligned number columns
  - multi-column hint
- **Output:** a document class (`text_pdf`, `tables`, `layout`, `scanned`, `mixed`) and a proposed tier. The document-type profile (DATA-04) can raise the proposal with `min_tier` and cap it with `max_tier`. For example, `invoice` has a minimum of `structured`, and `scanned/image` has a minimum of `structured`.

## Quality check and escalation

A parse result fails the check when any of these holds:

- the text is empty
- characters per page are below the class threshold
- the garbled ratio is above a threshold (U+FFFD, mojibake patterns, private-use characters)
- the detected language differs from the expected language
- tables were hinted by the preflight but none were produced
- Docling reports a partial conversion

On failure the document is escalated one tier, at most twice, and never above `max_tier` or past a hard constraint. When escalation is blocked, the best result is kept and the document is marked `needs_review`.

Every attempt is recorded in the ledger as `{tier, parser, parser_version, reason, ms, pages, est_cost}`.

## Hard constraints and budget

| Setting | Effect |
|---|---|
| `RAG_PARSER_ALLOW_CLOUD` | Off: no file leaves the deployment for parsing, and tier 3 is never used. |
| `RAG_PARSE_PREMIUM_PAGE_BUDGET` | Pages per tenant per calendar month for tier 3. |
| `RAG_PARSE_PREMIUM_MAX_PAGES_PER_DOC` | A document over this cap does not go to tier 3. |

- **Budget exceeded:** no tier 3. The document stays on the best allowed tier and is marked `needs_review`. Budget use is shown in the Config UI.
- **Scope:** settings are deployment-level ("Per-tenant provider choice" is out of scope). Budget use is counted per tenant.

## Parse cache

- **Key:** `(tenant, file_hash, parser, parser_version, options_hash)`, never matched across tenants.
- **Storage:** the parser output (Docling JSON or LlamaParse markdown) in tenant-scoped storage.
- **What reuses it, with zero parser calls:**
  - re-chunking after a chunk-size change
  - the CHK-05 size sweep
  - a changed document type whose parse options are unchanged
  - a retry after an embedding failure
- **Invalidation:** a changed `parser_version` or `options_hash`.

## Ingestion ledger (`ingestion_jobs`, RLS, server role only)

The columns of `ingestion_jobs` are:

- `id`, `tenant`, `source`, `source_key`, `document_id`, `version`, `file_hash`, `batch_id`, `priority`
- `status`, one of: queued, preflight, parsing, checking, chunking, embedding, ready, failed, quarantined, needs_review, skipped_duplicate
- `doc_class`, `tier`, `parser_used`, `attempts[]`, `escalations`, `pages`, `est_cost`, `embedding_profile`
- `retries`, `error`, `lease_until`, per-stage `timings`, `created_at`, `updated_at`

Each stage is idempotent: running a stage twice yields the same chunks and never writes duplicates. Chunks are written per `(document_id, version)` and replaced as a whole.

## Incremental path (DATA-15)

- **Identity:** a document's stable identity is `(tenant, source, source_key)`:
  - Config UI or chat upload: the storage path
  - Nango: the provider file id
  - scraper: the canonical URL
  - image upload: the storage path
- **Change handling:**
  - same identity and same hash: skipped
  - same identity and a new hash: a new version through the DATA-07 atomic swap
  - deleted at the source (Nango deletion event or sync diff): the current version is soft-deleted, and semantic-cache entries are invalidated through the RET-05 outbox
- **Upload response:** the upload route returns 202 with the job id at once. The UI shows the job status, read by polling or by Supabase Realtime on `ingestion_jobs`.
- **Queue:** the `ingestion_jobs` table itself, claimed with `FOR UPDATE SKIP LOCKED` and a lease. It works the same on Supabase and in PGlite fixtures, and needs no Redis, Celery, SQS or pgmq.
- **Worker:** a loop in the Python sidecar, which is already long-running. Vercel functions are capped at 60 s and do not parse.
- **Retries and failures:**
  - Retries back off exponentially (30 s × 2^n), up to 3 times, then the job is `failed`.
  - Failed jobs appear in a Config UI list with retry and delete buttons, and raise an alert in the trace.
  - An expired lease is reclaimed.
- **Latency target:** a digital PDF of up to 20 pages is `ready` within 60 s p95 with fake providers. The target is measured and reported.
- **Progressive mode** (`RAG_PARSE_PROGRESSIVE`, default off):
  - The fast tier is published at once, and its chunks are marked `provisional`.
  - The proposed tier then runs in the background and replaces that version through DATA-07.
  - Citations to the provisional version still resolve.

## Bulk backfill (DATA-16)

- **Entry point:** `npm run rag:backfill`, with `--tenant`, `--source <folder|bucket|manifest>`, `--budget`, `--concurrency` and `--dry-run`.
- **Order of work:**
  1. **Inventory and dedupe:** hash every file and drop duplicates within the tenant before any parsing.
  2. **Sample dry run:**
     - Sample 1% of files, at least 20, per class, and run them through preflight and the routed parse.
     - The report shows each class's share, the projected pages per tier, the projected cost and the projected wall time.
     - A run without `--budget` stops after the dry run.
  3. **Run:**
     - Jobs go into the same queue, tagged with `batch_id` and a low priority, so incremental uploads are never starved.
     - Concurrency is set by `--concurrency`.
     - Chunk rows are written in batches of 200–500.
     - A killed run resumes by skipping `ready` jobs.
     - At the end it reports failures and documents marked `needs_review`.
  4. **Embeddings:**
     - `RAG_EMBED_BATCH_MODE=sync|batch_api` (default `sync`). With `batch_api`, OpenAI embeddings go through the Batch API: 50% cheaper, up to 24 h, at most 50,000 inputs per batch. The run splits, submits, polls and resumes.
     - The incremental path always embeds synchronously.
     - Providers without a batch API embed synchronously.
  5. **Runner** (`--runner worker|ray`, default `worker`):
   - `worker`: the sidecar worker pool claims jobs from the ledger with `SKIP LOCKED`. No extra infrastructure.
   - `ray`: Ray Data reads the queued job ids of the batch and maps the same per-document stage functions (preflight → parse → check → chunk → embed) across a Ray cluster. CPU-heavy stages (Docling layout and OCR) get their own actor pool; API-bound stages (LlamaParse, embeddings) are capped by provider rate limits.
   - Both runners write through the same ledger functions. Leases, budget checks, dedup, idempotent chunk writes, priority and resume behave the same, and a batch can switch runners mid-run.
   - Ray is an optional dependency group of the sidecar (`uv sync --extra ray`), excluded from the default image, and its use is recorded on the ledger (`runner`).
   - It pays off for millions of pages, heavy local OCR, or self-hosted GPU embedding. At ~1M pages the default worker runner is enough.
6. **Into a new embedding profile:** when the backfill fills a new profile, it writes side by side and goes live only through the EMB-05 activation gate (blue-green).

## Parser evaluation (DATA-17)

- **Parse test set:** fixture documents per class, with expected structure:
  - classes: digital text, table, multi-column, scanned zh, scanned en, scanned it, invoice
  - expected structure: table cell grid, reading order, heading levels
- **Scored per tier:**
  - text similarity
  - table cell F1
  - reading-order and heading accuracy
  - seconds per page and estimated cost per page
- **End-to-end:**
  - Each golden item linked to these documents is retrieved with each tier, and Recall@k is reported per tier.
  - Routing thresholds are chosen from these results on the dev split.
- **Gate:** `tiered` must not lower Recall@k or correct-refusal against `fixed` beyond the noise band. The report shows the premium page share and the projected cost per 1,000 pages for both modes.

## Observability

Each document gets a Langfuse ingestion trace, following the OBS-01 conventions. Its spans are preflight, parse (one per attempt), check, chunk and embed, and each span carries the tier, the pages, the estimated cost and the escalation reason.

## Config UI (Ingestion panel)

**Settings:**
- routing mode
- cloud parsing allowed
- premium budget and per-document cap
- escalation on or off
- worker concurrency
- progressive mode
- embedding batch mode (backfill only)
- the minimum and maximum tier for each document-type profile

**Views:**
- the job list, with status filters
- failed jobs and jobs marked `needs_review`, with retry and delete buttons
- budget use this month

## Not adopted

| Option | Why |
|---|---|
| LlamaIndex `IngestionPipeline` docstore | Duplicates the ledger and DATA-06/07, which live in Postgres. The main app is TypeScript. |
| Redis + Celery/RQ, SQS | New infrastructure for about 50 documents a day. A Postgres table queue is enough and is testable in PGlite. |
| LlamaIndex `RayIngestionPipeline` | Ray Data is offered directly as the optional `--runner ray` (DATA-16) on our own stage functions; LlamaIndex's pipeline is not used. |
| PyMuPDF | AGPL-3.0 |
| Reducto | Out of scope by user decision |
