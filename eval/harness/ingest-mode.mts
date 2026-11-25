import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCorpus } from './corpus.mts';
import { startFakeEdge, type FakeEdge } from './fake-edge.mts';
import {
  createEmptyFixtureDatabase,
  prechunkedWriter,
  relexFixtureChunks,
  type DeploymentMode,
  type EmptyFixtureDatabase,
  type FixtureDatabase,
} from './pglite-supabase.mts';
import { applyFixtureProcessEnv } from './process-env.mts';
import { RunConfigError } from './run-config.mts';
import { isTableSplitItem, loadTableSplitTenants, tableSplitCorpusParts, type TableSplitTenant } from './table-split.mts';
import type { ChunkingProfile } from '../../src/lib/rag-eval/contracts.generated.ts';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { IngestInput } from '@/lib/rag/ingest/types';

const MANIFEST_PATH = path.join('eval/fixtures/ingest/manifest.json');
const PARSE_MANIFEST_PATH = path.join('eval/fixtures/parse/manifest.json');
const PARSE_RECORDED_DIR = path.join('eval/fixtures/parse/recorded');
/** The latency fixture is routed and timed, not retrieved from: 100 near-identical pages would only crowd the corpus. */
const EXCLUDED_PARSE_CLASSES = new Set(['bench']);
const RECORDED_PRESETS = ['fast', 'structured_layout', 'structured_full', 'structured_ocr'] as const;
const QUEUE_SIDECAR_SECRET = 'ingest-mode-queue-sidecar-secret-0000';
/** Large enough for every fixture page under --force-tier premium (D-40); the parse fixtures have 26 pages, the typed ones 14. */
const FORCED_PREMIUM_BUDGET = 1000;
const FORCED_PREMIUM_MAX_PAGES_PER_DOC = 200;
const WORKER_TIMEOUT_MS = 180_000;
/**
 * The sec-attacks documents simulate legacy or pre-scan content (D-13): ingest() would quarantine them, so ingest mode writes them as
 * ready pre-chunked rows through the prechunked writer, and every other corpus document goes through ingest().
 */
const PRECHUNKED_ONLY_RE = /^sec-attacks\.[a-z]{2}\.md$/;

export function isPrechunkedOnlyDocument(relpath: string): boolean {
  return PRECHUNKED_ONLY_RE.test(path.posix.basename(relpath));
}

interface ManifestFixture {
  id: string;
  doc_type: string;
  mime: string;
  path: string;
  file_sha256: string;
  recorded?: { docling?: string };
  expected?: { injection?: { expected_status?: string }; page_count?: number };
}

interface ParseManifestFixture {
  id: string;
  class: string;
  language: string;
  pdf_path: string;
  sha256: string;
  page_count: number;
}

export type IngestRouting = 'fixed' | 'tiered';
export type ForcedTier = 'fast' | 'structured' | 'premium';

/** How ingest mode fills the database: without it, the inline ingest() of Phase 3; with it, the queue (D-40). */
export interface IngestRoutingOptions {
  routing: IngestRouting;
  /** Pins every page to this tier through rag_parse_tier_overrides (min = max); needs tiered routing. */
  forceTier?: ForcedTier;
  /** When set, the ledger row of every queued job is written here as JSON (the parse gate reads tiers and pages from it). */
  ledgerOut?: string;
}

const ROUTINGS: readonly IngestRouting[] = ['fixed', 'tiered'];
const FORCED_TIERS: readonly ForcedTier[] = ['fast', 'structured', 'premium'];

/** The --routing and --force-tier flags of the smoke harness; a forced tier implies tiered routing. */
export function parseIngestRoutingFlags(values: { routing?: string; 'force-tier'?: string }): IngestRoutingOptions | undefined {
  const routing = values.routing;
  const forceTier = values['force-tier'];
  if (routing !== undefined && !(ROUTINGS as readonly string[]).includes(routing)) {
    throw new Error(`--routing must be fixed or tiered, got ${routing}`);
  }
  if (forceTier !== undefined && !(FORCED_TIERS as readonly string[]).includes(forceTier)) {
    throw new Error(`--force-tier must be fast, structured or premium, got ${forceTier}`);
  }
  if (forceTier !== undefined && routing === 'fixed') throw new Error('--force-tier needs tiered routing; fixed routing has no tiers');
  if (forceTier !== undefined) return { routing: 'tiered', forceTier: forceTier as ForcedTier };
  if (routing !== undefined) return { routing: routing as IngestRouting };
  return undefined;
}

/** One parse fixture (eval/fixtures/parse) as a document of the ingest corpus. */
export interface ParseFixtureDocument {
  id: string;
  class: string;
  language: string;
  /** The document name golden items cite: `<fixture id>.pdf`. */
  filename: string;
  path: string;
  sha256: string;
  pageCount: number;
  /**
   * A typed ingest fixture (eval/fixtures/ingest) with the same id has the same text (the scans and invoice-en), so content-hash
   * dedup would drop a second copy: the typed document stands for the parse fixture, and under --routing it is converted from the
   * parse fixture's recordings.
   */
  typedTwin: boolean;
}

function loadTypedManifest(): ManifestFixture[] {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as { fixtures: ManifestFixture[] };
  return manifest.fixtures;
}

/** The parse fixtures of the ingest corpus, by id: every class but the latency fixture. */
export function ingestModeParseFixtures(): ParseFixtureDocument[] {
  const typed = new Set(loadTypedManifest().map((entry) => entry.id));
  const manifest = JSON.parse(fs.readFileSync(PARSE_MANIFEST_PATH, 'utf8')) as { fixtures: ParseManifestFixture[] };
  return manifest.fixtures
    .filter((row) => !EXCLUDED_PARSE_CLASSES.has(row.class))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((row) => ({
      id: row.id,
      class: row.class,
      language: row.language,
      filename: `${row.id}.pdf`,
      path: path.join('eval', row.pdf_path),
      sha256: row.sha256,
      pageCount: row.page_count,
      typedTwin: typed.has(row.id),
    }));
}

/** Repo-relative golden files the ingest mode scores; ingest-only items are added here. */
export function ingestModeGoldenPaths(): string[] {
  return ['eval/fixtures/golden.jsonl', 'eval/fixtures/ingest/golden-ingest.jsonl'];
}

/**
 * How ingest mode routes golden items by category: table_split items run against their isolated tenants (table-split.mts) after
 * every other item, so the other items run exactly as they did before the table documents existed (research Pitfall 10).
 */
export function partitionIngestModeItems<T extends { category: string }>(items: T[]): { main: T[]; tableSplit: T[] } {
  return { main: items.filter((item) => !isTableSplitItem(item)), tableSplit: items.filter((item) => isTableSplitItem(item)) };
}

/**
 * Retrieval-time env for ingest-mode fixture eval. The ingest builder turns exact-id lookup on; the recorded ingest baseline
 * assumes retrieval still runs it. Pinned smoke env sets it off, and live process.env must override frozen `@/lib/env` for
 * v2 harness overlays, so this is applied again when the eval route is prepared.
 */
export function ingestModeRetrievalEnv(): Record<string, string> {
  return { RAG_EXACT_ID_LOOKUP: 'true' };
}

/** One golden file to score: a single path is returned as it is, several are concatenated in order into `outPath`. */
export function mergeGoldenFiles(paths: string[], outPath: string): string {
  const [first, ...rest] = paths;
  if (first === undefined) throw new Error('[Ingest Mode] no golden file to merge');
  if (rest.length === 0) return first;
  const lines = paths.flatMap((file) => fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== ''));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${lines.join('\n')}\n`);
  return outPath;
}

/**
 * The corpus hash of an ingest-mode run. The chunks differ from the prechunked ones, so a run must not be gated against the
 * prechunked baseline: the gate compares this value and refuses the pair. The parse fixtures are part of the corpus, and a queued
 * build names its routing and forced tier, so a routed run is never gated against the inline baseline by accident.
 */
function ingestCorpusSha256(
  corpusSha256: string,
  parseFixtures: ParseFixtureDocument[],
  routing?: IngestRoutingOptions,
  tableSplit = false,
): string {
  const hash = crypto.createHash('sha256').update('fixture-mode:ingest').update(Buffer.from([0])).update(corpusSha256);
  for (const fixture of parseFixtures) hash.update(Buffer.from([0])).update(`parse:${fixture.filename}:${fixture.sha256}`);
  if (routing) hash.update(Buffer.from([0])).update(`routing:${routing.routing}:${routing.forceTier ?? 'none'}`);
  if (tableSplit) for (const part of tableSplitCorpusParts()) hash.update(Buffer.from([0])).update(part);
  return hash.digest('hex');
}

/**
 * The fixture database filled by the real ingest(): every corpus document, with the chunk markers and the fixture-meta line already
 * removed by the corpus loader, goes through the stages as a picked-general config upload of the fixture tenant. Typed fixtures from
 * eval/fixtures/ingest/manifest.json follow, each with its picked doc_type, then the parse fixtures as general PDFs. The fake edge it
 * ingests through stays up and is handed to the caller together with the database; the app environment points at it.
 */
export interface IngestFixtureBuildState {
  fixture: FixtureDatabase;
  edge: FakeEdge;
  scope: import('@/lib/rag/tenant/scope').TenantScope;
}

interface IngestWork {
  label: string;
  input: IngestInput;
  expected: 'ready' | 'quarantined';
  /** Under --routing: where the recorded converter finds the pages, and how many there are (PDFs only). */
  recordedSha?: string;
  pageCount?: number;
}

/** What a queued build did, for the caller's checks. */
export interface IngestRoutingSummary {
  routing: IngestRouting;
  forceTier: ForcedTier | null;
  jobs: number;
  llamaUploads: number;
  /** Documents a forced tier could not publish (job needs_review), with the reason. */
  needsReview: Array<{ filename: string; reason: string }>;
  /** The ledger row of every queued job, with the page count the harness knows for a PDF (fixed routing records none). */
  ledger: IngestLedgerRow[];
}

/** What the parse gate reads from a queued job's ledger row (D-40). */
export interface IngestLedgerRow {
  filename: string;
  mime_type: string | null;
  status: string;
  doc_class: string | null;
  tier: string | null;
  pages: number | null;
  harness_page_count: number | null;
  tier_page_counts: Record<string, number>;
  page_ranges: unknown[];
  est_cost_usd: number | null;
  attempts: unknown[];
}

function writeRecordedPage(root: string, sha: string, preset: string, page: number, source: string): void {
  const dir = path.join(root, sha, preset);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(source, path.join(dir, `page-${page}.json`));
}

/**
 * The recordings the worker's recorded converter reads under --routing: every parse fixture as recorded (03.1-13); a typed twin of a
 * parse fixture under its own file hash with the parse fixture's pages; any other typed fixture with its one whole-document recording
 * (eval/fixtures/ingest/recorded/<id>.docling.json) for every preset and page, since it has no per-preset recordings.
 */
function buildRecordedDir(typed: ManifestFixture[], parseFixtures: ParseFixtureDocument[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-mode-recorded-'));
  const absoluteRecorded = path.resolve(PARSE_RECORDED_DIR);
  for (const entry of fs.readdirSync(absoluteRecorded)) fs.symlinkSync(path.join(absoluteRecorded, entry), path.join(root, entry), 'dir');
  const twins = new Map(parseFixtures.filter((fixture) => fixture.typedTwin).map((fixture) => [fixture.id, fixture]));
  for (const entry of typed) {
    if (entry.mime !== 'application/pdf') continue;
    const twin = twins.get(entry.id);
    if (twin) {
      fs.symlinkSync(path.join(absoluteRecorded, twin.sha256), path.join(root, entry.file_sha256), 'dir');
      continue;
    }
    const docling = entry.recorded?.docling;
    const pages = entry.expected?.page_count;
    if (!docling || !pages) throw new Error(`[Ingest Mode] typed fixture ${entry.id} has no Docling recording or page count`);
    for (const preset of RECORDED_PRESETS) {
      for (let page = 1; page <= pages; page += 1) writeRecordedPage(root, entry.file_sha256, preset, page, path.join('eval/fixtures/ingest', docling));
    }
  }
  return root;
}

interface DoclingNode {
  text?: string;
  label?: string;
  prov?: Array<{ page_no?: number }>;
  children?: Array<{ $ref: string }>;
  data?: { num_rows?: number; num_cols?: number; table_cells?: Array<{ text?: string; start_row_offset_idx: number; start_col_offset_idx: number }> };
}

interface DoclingJson {
  body?: DoclingNode;
  texts?: DoclingNode[];
  tables?: DoclingNode[];
  groups?: DoclingNode[];
}

function markdownTable(node: DoclingNode): string {
  const rows = node.data?.num_rows ?? 0;
  const cols = node.data?.num_cols ?? 0;
  if (rows === 0 || cols === 0) return '';
  const grid = Array.from({ length: rows }, () => Array.from({ length: cols }, () => ''));
  for (const cell of node.data?.table_cells ?? []) {
    const row = grid[cell.start_row_offset_idx];
    if (row && cell.start_col_offset_idx < cols) row[cell.start_col_offset_idx] = (cell.text ?? '').trim();
  }
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`;
  const [header, ...body] = grid;
  return [line(header ?? []), line(Array.from({ length: cols }, () => '---')), ...body.map(line)].join('\n');
}

/** One page of a structured recording as the markdown a page-aware premium parser returns: headings, paragraphs and pipe tables in body order. */
function pageMarkdown(doc: DoclingJson, page: number): string {
  const blocks: string[] = [];
  const resolve = (ref: string): DoclingNode | undefined => {
    const [, kind, index] = /^#\/(texts|tables|groups)\/(\d+)$/.exec(ref) ?? [];
    if (!kind || index === undefined) return undefined;
    return doc[kind as 'texts' | 'tables' | 'groups']?.[Number(index)];
  };
  const walk = (node: DoclingNode | undefined, kind: string): void => {
    if (!node) return;
    const onPage = (node.prov?.[0]?.page_no ?? page) === page;
    if (kind === 'tables') {
      const table = markdownTable(node);
      if (onPage && table !== '') blocks.push(table);
      return;
    }
    if (kind === 'texts' && onPage && (node.text ?? '').trim() !== '') {
      const heading = node.label === 'section_header' || node.label === 'title';
      blocks.push(heading ? `## ${node.text!.trim()}` : node.text!.trim());
    }
    for (const child of node.children ?? []) walk(resolve(child.$ref), /^#\/(\w+)\//.exec(child.$ref)?.[1] ?? '');
  };
  walk(doc.body, 'body');
  return `${blocks.join('\n\n')}\n`;
}

/**
 * What the fake LlamaParse answers for a whole PDF under --force-tier premium: the recorded premium markdown of a page when 03.1-13
 * recorded one, otherwise the page's structured recording rendered as markdown (headings, paragraphs, pipe tables), which is what a
 * page-aware premium parser returns. parser_eval scores premium only on fixtures with real premium recordings.
 */
function premiumPages(recordedRoot: string, sha: string, pageCount: number): Array<{ page_number: number; success: boolean; markdown: string }> {
  const pages = [];
  for (let page = 1; page <= pageCount; page += 1) {
    const recorded = path.join(recordedRoot, sha, 'premium', `page-${page}.md`);
    const markdown = fs.existsSync(recorded)
      ? fs.readFileSync(recorded, 'utf8')
      : pageMarkdown(JSON.parse(fs.readFileSync(path.join(recordedRoot, sha, 'structured_full', `page-${page}.json`), 'utf8')) as DoclingJson, page);
    pages.push({ page_number: page, success: true, markdown });
  }
  return pages;
}

const RANDOM_DOCUMENT_ID_DECLARATION = 'new_id uuid := gen_random_uuid();';
/**
 * A document id derived from stable inputs: the tenant, the source key, the file hash and how many versions of that source the tenant
 * already holds, with the RFC 4122 version 4 and variant bits set (the ledger validates ids as UUIDs). Chunk ids are derived from the
 * document id by the writer, so they follow.
 */
const DETERMINISTIC_DOCUMENT_ID_DECLARATION =
  'new_id uuid := (SELECT substr(encode(set_byte(set_byte(h, 6, (get_byte(h, 6) & 15) | 64), 8, (get_byte(h, 8) & 63) | 128), ' +
  "'hex'), 1, 32)::uuid FROM (SELECT sha256(convert_to(concat_ws(':', 'eval-ingest-document', p_tenant_key, p_source, p_source_key, " +
  "COALESCE(p_file_sha256, ''), (SELECT count(*) FROM public.documents d WHERE d.tenant_key = p_tenant_key " +
  "AND d.source_key = p_source_key)::text), 'UTF8')) AS h) s);";

export class DeterministicIngestIdsError extends Error {
  constructor(detail: string) {
    super(`[Ingest Mode] cannot make document ids deterministic: ${detail}`);
    this.name = 'DeterministicIngestIdsError';
  }
}

/**
 * Harness only: redefines rag_begin_document_version in this fixture database so a new document's id is derived from stable inputs
 * instead of gen_random_uuid(). Random ids made repeated ingest runs differ wherever retrieval breaks a score tie by chunk id, and
 * left no fixed id for item filters to name. Grants, owner and SECURITY DEFINER survive CREATE OR REPLACE.
 */
export async function installDeterministicDocumentIds(db: FixtureDatabase['db']): Promise<void> {
  const { rows } = await db.query<{ def: string }>(
    `SELECT pg_get_functiondef(p.oid) AS def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'rag_begin_document_version'`,
  );
  if (rows.length !== 1) throw new DeterministicIngestIdsError(`expected one rag_begin_document_version, found ${rows.length}`);
  const def = rows[0]!.def;
  if (def.split(RANDOM_DOCUMENT_ID_DECLARATION).length !== 2) {
    throw new DeterministicIngestIdsError('rag_begin_document_version no longer declares its id with gen_random_uuid()');
  }
  await db.exec(def.replace(RANDOM_DOCUMENT_ID_DECLARATION, DETERMINISTIC_DOCUMENT_ID_DECLARATION));
}

/** The doc types an override must pin: every type a document of this build is uploaded with. */
function docTypesOf(work: IngestWork[]): string[] {
  return [...new Set(work.map((item) => item.input.docType ?? 'general'))].sort();
}

export async function buildIngestFixtureDatabase(options: {
  deploymentMode: DeploymentMode;
  corpusDir: string;
  processEnv?: Record<string, string>;
  supabaseGrants?: boolean;
  migrations?: boolean;
  setupSqlPath?: string;
  /** When set, only these corpus documents are ingested (half-open range). */
  corpusRange?: { start: number; end: number };
  includeTypedFixtures?: boolean;
  continueFrom?: IngestFixtureBuildState;
  onAfterCorpusSlice?: (state: IngestFixtureBuildState) => Promise<void>;
  /** Ingest corpus documents [0, index) first, run the callback, then ingest [index, end) and typed fixtures. */
  splitAtCorpusIndex?: number;
  /** Candidate chunking profiles seeded as building before the first document, so ingestion dual-write (RAG_PIPELINE=v2) fills them. */
  chunkingProfiles?: ChunkingProfile[];
  /** When set, only these typed fixtures (eval/fixtures/ingest ids) are ingested. */
  typedFixtureIds?: string[];
  /** When set, only these parse fixtures (eval/fixtures/parse ids) are ingested; a typed twin comes with its typed fixture. */
  parseFixtureIds?: string[];
  /** Through the queue instead of inline ingest() (D-40). */
  routing?: IngestRoutingOptions;
  /**
   * After the fixture tenant is filled, load the long-table documents into the isolated table_split tenants (table-split.mts).
   * Inline ingest() only: a queued --routing build leaves the table_split items out.
   */
  tableSplit?: boolean;
}): Promise<
  FixtureDatabase & { buildState: IngestFixtureBuildState; routingSummary?: IngestRoutingSummary; tableSplitTenants?: TableSplitTenant[] }
> {
  const { deploymentMode, routing } = options;
  const tableSplit = options.tableSplit === true;
  if (tableSplit && routing) throw new Error('[Ingest Mode] the table_split tenants are loaded by inline ingest(); drop them under --routing');
  if (tableSplit && (options.continueFrom || options.onAfterCorpusSlice || options.splitAtCorpusIndex !== undefined)) {
    throw new Error('[Ingest Mode] the table_split tenants are loaded only by a build in one pass');
  }
  if (routing && (options.continueFrom || options.onAfterCorpusSlice || options.splitAtCorpusIndex !== undefined)) {
    throw new Error('[Ingest Mode] --routing builds the whole database in one pass');
  }
  if (routing?.forceTier && routing.routing !== 'tiered') throw new Error('[Ingest Mode] a forced tier needs tiered routing');
  const includeTyped = options.includeTypedFixtures ?? true;
  const corpus = loadCorpus(options.corpusDir);
  const corpusStart = options.corpusRange?.start ?? 0;
  const corpusEnd = options.corpusRange?.end ?? corpus.documents.length;
  const splitAt = options.splitAtCorpusIndex;
  const corpusSlice =
    splitAt === undefined
      ? corpus.documents.slice(corpusStart, corpusEnd)
      : corpus.documents.slice(corpusStart, Math.min(splitAt, corpusEnd));
  const corpusTail =
    splitAt === undefined ? [] : corpus.documents.slice(Math.max(corpusStart, splitAt), corpusEnd);
  const seeded = options.chunkingProfiles ?? [];
  if (seeded.length > 0 && options.continueFrom) throw new Error('[Ingest Mode] chunking profiles are seeded only on a fresh build');
  if (seeded.length > 0 && (options.processEnv?.RAG_PIPELINE ?? '').trim().toLowerCase() !== 'v2') {
    throw new RunConfigError('[Eval Harness] chunking_profiles needs RAG_PIPELINE=v2');
  }
  const typedWanted = options.typedFixtureIds ? new Set(options.typedFixtureIds) : null;
  const typedFixtures = includeTyped ? loadTypedManifest().filter((entry) => typedWanted === null || typedWanted.has(entry.id)) : [];
  const parseWanted = options.parseFixtureIds ? new Set(options.parseFixtureIds) : null;
  const allParseFixtures = ingestModeParseFixtures();
  const parseFixtures = includeTyped
    ? allParseFixtures.filter((fixture) => !fixture.typedTwin && (parseWanted === null || parseWanted.has(fixture.id)))
    : [];
  const corpusSha256 = ingestCorpusSha256(corpus.corpusSha256, includeTyped ? allParseFixtures : [], routing, tableSplit);
  const parseById = new Map(allParseFixtures.map((fixture) => [fixture.id, fixture]));

  const createIngestDatabase = async (): Promise<EmptyFixtureDatabase> => {
    const created = await createEmptyFixtureDatabase(options);
    try {
      await installDeterministicDocumentIds(created.db);
    } catch (error) {
      await created.db.close().catch(() => undefined);
      throw error;
    }
    return created;
  };
  const empty = options.continueFrom?.fixture ?? (await createIngestDatabase());
  const ingestDocumentIds: Record<string, string> = { ...(options.continueFrom?.fixture.ingestDocumentIds ?? {}) };
  let edge: FakeEdge | undefined;
  let scope: import('@/lib/rag/tenant/scope').TenantScope | undefined;
  let uninstall: (() => Promise<void>) | undefined;
  let sidecarUploads: FixtureDatabase['ingestSidecarUploads'];
  let llamaAttempts = 0;
  let routingSummary: IngestRoutingSummary | undefined;
  let tableSplitTenants: TableSplitTenant[] | undefined;
  const harnessEnv: Record<string, string> = {
    RAG_INGEST_PIPELINE: 'unified',
    RAG_PARSER: 'llamaparse',
    RAG_INJECTION_SCAN: 'quarantine',
    RAG_PDF_IMAGE_CHUNKS: 'true',
    RAG_EXACT_ID_LOOKUP: 'true',
    LLAMA_CLOUD_API_KEY: '',
    ...(routing
      ? {
          RAG_INGEST_ASYNC: 'on',
          RAG_PARSE_ROUTING: routing.routing,
          RAG_SIDECAR_SECRET: QUEUE_SIDECAR_SECRET,
          RAG_PARSER_ALLOW_CLOUD: routing.forceTier === 'premium' ? 'true' : 'false',
          RAG_PARSE_PREMIUM_PAGE_BUDGET: String(routing.forceTier === 'premium' ? FORCED_PREMIUM_BUDGET : 0),
          RAG_PARSE_PREMIUM_MAX_PAGES_PER_DOC: String(FORCED_PREMIUM_MAX_PAGES_PER_DOC),
          RAG_PARSE_VLM_DETECT: 'false',
        }
      : {}),
    ...options.processEnv,
  };
  const cleanups: Array<() => Promise<void> | void> = [];
  try {
    edge = options.continueFrom?.edge ?? (await startFakeEdge({ db: empty.db }));
    applyFixtureProcessEnv({
      edgeUrl: edge.url,
      deploymentMode,
      extra: options.continueFrom ? { ...harnessEnv, ...options.processEnv } : harnessEnv,
      vendorEmbeddingRoutes: Boolean(harnessEnv.RAG_EMBEDDING_PROFILES === 'on' || options.processEnv?.RAG_EMBEDDING_PROFILES === 'on'),
    });

    const { fixtureAdminClient, installIngestFakes } = await import('./ingest-fakes.mts');
    const { ingest } = await import('@/lib/rag/ingest');
    const { buildSourceKey } = await import('@/lib/rag/ingest/identity');
    const { mintScope, scopeKey } = await import('@/lib/rag/tenant/scope');

    const { INGEST_MODE_FEATURE_ENV } = await import('./ingest-fakes.mts');
    const fakes = await installIngestFakes({ db: fixtureAdminClient(edge.url), env: INGEST_MODE_FEATURE_ENV });
    uninstall = fakes.uninstall;

    if (seeded.length > 0) await seedChunkingProfiles(empty.db, seeded);

    scope =
      options.continueFrom?.scope ??
      (deploymentMode === 'multi-tenant' ? mintScope('personal', empty.fixtureUserId, null) : mintScope('single', null, null));
    const tenant = scope;

    const corpusWork = (docs: typeof corpusSlice): IngestWork[] =>
      docs.filter((doc) => !isPrechunkedOnlyDocument(doc.relpath)).map((doc) => ({
        label: doc.relpath,
        expected: 'ready',
        input: {
          scope: tenant,
          source: 'config_upload',
          sourceKey: buildSourceKey('config_upload', { filename: doc.filename }),
          text: doc.content,
          filename: doc.filename,
          mimeType: 'text/markdown',
          docType: 'general',
          signal: new AbortController().signal,
        },
      }));
    const typedWork = (): IngestWork[] =>
      typedFixtures.map((entry) => {
        const filename = path.basename(entry.path);
        return {
          label: `typed fixture ${entry.id}`,
          expected: entry.expected?.injection?.expected_status === 'quarantined' ? 'quarantined' : 'ready',
          recordedSha: entry.file_sha256,
          pageCount: entry.expected?.page_count ?? parseById.get(entry.id)?.pageCount,
          input: {
            scope: tenant,
            source: 'config_upload',
            sourceKey: buildSourceKey('config_upload', { filename }),
            file: new Uint8Array(fs.readFileSync(path.join('eval/fixtures/ingest', entry.path))),
            filename,
            mimeType: entry.mime,
            docType: entry.doc_type as import('@/lib/rag/ingest/profiles/load').DocType,
            signal: new AbortController().signal,
          },
        };
      });
    const parseWork = (): IngestWork[] =>
      parseFixtures.map((fixture) => ({
        label: `parse fixture ${fixture.id}`,
        expected: 'ready',
        recordedSha: fixture.sha256,
        pageCount: fixture.pageCount,
        input: {
          scope: tenant,
          source: 'config_upload',
          sourceKey: buildSourceKey('config_upload', { filename: fixture.filename }),
          file: new Uint8Array(fs.readFileSync(fixture.path)),
          filename: fixture.filename,
          mimeType: 'application/pdf',
          docType: 'general',
          signal: new AbortController().signal,
        },
      }));

    let run: (item: IngestWork) => Promise<string | null> = async (item) => {
      const result = await ingest(item.input);
      if (result.status !== item.expected) {
        throw new Error(
          `[Ingest Mode] ${item.label} ended ${result.status} (expected ${item.expected}; ${result.reason ?? 'no reason'}; warnings: ${result.warnings.join(', ') || 'none'})`,
        );
      }
      return result.documentId ?? result.duplicateOf ?? null;
    };
    let queuedSummary: (() => IngestRoutingSummary) | undefined;
    if (routing) {
      const queued = await startQueuedIngest({
        routing,
        edge,
        pg: empty.db,
        typedFixtures,
        parseFixtures: allParseFixtures,
        docTypes: docTypesOf([...corpusWork(corpusSlice), ...typedWork(), ...parseWork()]),
        cleanups,
      });
      run = queued.run;
      queuedSummary = queued.summary;
    }

    const writePrechunked = await prechunkedWriter(empty.db, deploymentMode);
    const fillCorpus = async (docs: typeof corpusSlice): Promise<void> => {
      const prechunkedIds = new Set<string>();
      for (const doc of docs) {
        if (isPrechunkedOnlyDocument(doc.relpath)) {
          await writePrechunked(doc);
          for (const chunk of doc.chunks) prechunkedIds.add(chunk.id);
          ingestDocumentIds[doc.id] = doc.id;
        } else {
          for (const item of corpusWork([doc])) {
            const documentId = await run(item);
            if (documentId) ingestDocumentIds[doc.id] = documentId;
          }
        }
      }
      // Lexical text for the pre-chunked rows only, as prechunked mode builds it; the rows ingest() wrote stay as written.
      if (prechunkedIds.size > 0 && options.migrations !== false) await relexFixtureChunks(empty.db, prechunkedIds);
    };

    await fillCorpus(corpusSlice);

    if (options.onAfterCorpusSlice && edge !== undefined) {
      const partialFixture = { ...empty, corpusSha256, ingestDocumentIds: { ...ingestDocumentIds } } as FixtureDatabase;
      await options.onAfterCorpusSlice({ fixture: partialFixture, edge, scope });
    }

    await fillCorpus(corpusTail);

    const ingestTyped = includeTyped && (splitAt === undefined || corpusTail.length > 0);
    if (ingestTyped) {
      for (const item of typedWork()) await run(item);
      for (const item of parseWork()) await run(item);
    }
    routingSummary = queuedSummary?.();
    if (routing?.ledgerOut && routingSummary) {
      fs.mkdirSync(path.dirname(routing.ledgerOut), { recursive: true });
      fs.writeFileSync(
        routing.ledgerOut,
        `${JSON.stringify({ routing: routingSummary.routing, force_tier: routingSummary.forceTier, jobs: routingSummary.ledger }, null, 2)}\n`,
      );
    }

    sidecarUploads = fakes.sidecar.uploads.map((upload) => ({
      fileSha256: upload.fileSha256,
      request: upload.request,
    }));
    llamaAttempts = fakes.llamaParseAttempts();

    if (tableSplit) {
      tableSplitTenants = await loadTableSplitTenants({
        edge,
        homeDb: empty.db,
        deploymentMode,
        createDatabase: createIngestDatabase,
        ingest,
        buildSourceKey,
        mintScope,
        scopeKey,
      });
      if (fakes.llamaParseAttempts() !== llamaAttempts) throw new Error('[Ingest Mode] the table_split tenants reached LlamaParse');
    }

    if (edge.errors.length > 0) {
      const sample = edge.errors
        .slice(0, 3)
        .map((error) => `${error.method} ${error.url} -> ${error.status}`)
        .join('; ');
      throw new Error(`[Ingest Mode] the fake edge refused ${edge.errors.length} request(s) while ingesting: ${sample}`);
    }
  } catch (error) {
    for (const tenant of tableSplitTenants ?? []) await tenant.db.close().catch(() => undefined);
    await runCleanups(cleanups);
    await uninstall?.().catch(() => undefined);
    uninstall = undefined;
    await edge?.close().catch(() => undefined);
    await empty.db.close().catch(() => undefined);
    throw error;
  } finally {
    await runCleanups(cleanups);
    await uninstall?.();
  }

  if (edge === undefined || scope === undefined) throw new Error('[Ingest Mode] internal error: ingest did not finish');
  const fixtureWithCorpus = { ...empty, corpusSha256, ingestDocumentIds } as FixtureDatabase;
  const buildState: IngestFixtureBuildState = { fixture: fixtureWithCorpus, edge, scope };
  return {
    ...empty,
    corpusSha256,
    edge,
    ingestSidecarUploads: sidecarUploads,
    ingestLlamaParseAttempts: llamaAttempts,
    ingestDocumentIds,
    ...(seeded.length > 0 ? { seededChunkingProfiles: seeded.map((profile) => profile.id) } : {}),
    buildState,
    ...(routingSummary ? { routingSummary } : {}),
    ...(tableSplitTenants ? { tableSplitTenants } : {}),
  };
}

/**
 * Validates each candidate against the hard rules with the active embedding profile's input limit (validateChunkingProfile), then inserts it
 * with status building through the fixture's superuser connection. Runs after the run-config env overlay is applied and before the first
 * document is ingested; the RAG config memo is reset so dual-write reads RAG_PIPELINE=v2.
 */
async function seedChunkingProfiles(db: FixtureDatabase['db'], profiles: ChunkingProfile[]): Promise<void> {
  const { resetRagConfigForTests } = await import('@/lib/rag/config');
  resetRagConfigForTests();
  const { validateChunkingProfile } = await import('@/lib/rag/chunking/validate');
  for (const profile of profiles) {
    const { errors } = await validateChunkingProfile(profile);
    if (errors.length > 0) throw new RunConfigError(`[Eval Harness] chunking profile ${profile.id} is invalid: ${errors.join(', ')}`);
  }
  for (const profile of profiles) {
    await db.query(
      `INSERT INTO public.chunking_profiles (id, doc_type, child_tokens, parent_mode, parent_tokens, status, preset)
       VALUES ($1, $2, $3, $4, $5, 'building', $6)`,
      [profile.id, profile.doc_type, profile.child_tokens, profile.parent_mode, profile.parent_tokens, profile.preset],
    );
  }
}

async function runCleanups(cleanups: Array<() => Promise<void> | void>): Promise<void> {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    try {
      await cleanup?.();
    } catch (error) {
      console.error('[Ingest Mode] cleanup failed', { error: error instanceof Error ? error.message : String(error) });
    }
  }
}

/**
 * The queued half of ingest mode (D-40): the app's internal callback routes behind a local server, the object store and tier bounds
 * pointed at this build's edge, the routing switches in the job snapshot, and per document enqueueIngest then the sidecar's one-shot
 * runner for that job, spawned through spawnSidecarModule (its RAG_SIDECAR_ENV=test marker is what lets the worker settings accept
 * the recorded converter). Jobs run one at a time in upload order. A forced tier is written to rag_parse_tier_overrides for every doc
 * type of the build before the first upload and removed after the last.
 */
async function startQueuedIngest(options: {
  routing: IngestRoutingOptions;
  edge: FakeEdge;
  pg: FixtureDatabase['db'];
  typedFixtures: ManifestFixture[];
  parseFixtures: ParseFixtureDocument[];
  docTypes: string[];
  cleanups: Array<() => Promise<void> | void>;
}): Promise<{ run: (item: IngestWork) => Promise<string | null>; summary: () => IngestRoutingSummary }> {
  const { routing, edge, cleanups } = options;
  const { fixtureAdminClient } = await import('./ingest-fakes.mts');
  const { fixtureProcessEnv } = await import('./fake-edge.mts');
  const { startIngestAppServer } = await import('./ingest-app-server.mts');
  const { spawnSidecarModule } = await import('./sidecar-worker.mts');
  const { startFakeLlamaParse } = await import('../../tests/helpers/fake-llamaparse.ts');
  const { enqueueIngest } = await import('@/lib/rag/ingest/enqueue');
  const { loadQueueConfig, resetQueueConfigForTests } = await import('@/lib/rag/ingest/queue-config');
  const objectStore = await import('@/lib/rag/ingest/object-store');
  const tierBounds = await import('@/lib/rag/ingest/routing/tier-bounds');
  const llamaParse = await import('@/lib/rag/ingest/parsers/llamaparse-v2');
  type IngestRouteHandler = import('./ingest-app-server.mts').IngestRouteHandler;

  const db = fixtureAdminClient(edge.url) as unknown as SupabaseClient;

  const recordedDir = buildRecordedDir(options.typedFixtures, options.parseFixtures);
  cleanups.push(() => fs.rmSync(recordedDir, { recursive: true, force: true }));

  // The worker reads the original and writes its cache objects over HTTP, so the app must use the same storage: the Supabase object
  // store on this build's edge instead of the in-memory fake.
  type StorageClient = ReturnType<Parameters<typeof objectStore.createSupabaseObjectStore>[0]>;
  objectStore.setObjectStoreForTests(objectStore.createSupabaseObjectStore(() => db as unknown as StorageClient));
  tierBounds.setTierBoundsDepsForTests({ admin: () => db });
  cleanups.push(() => tierBounds.resetTierBoundsDepsForTests());

  let currentPremium: ReturnType<typeof premiumPages> | null = null;
  const llama = await startFakeLlamaParse({ resolveSpec: () => (currentPremium ? { pages: currentPremium } : undefined) });
  cleanups.push(() => llama.close());
  if (routing.routing === 'tiered') {
    // Fixed routing keeps the always-unavailable stub, so its chain is the inline one; tiered premium pages go to the fake.
    llamaParse.setLlamaParseParserForTests(
      llamaParse.createLlamaParseParser({ baseUrl: llama.url, apiKey: llama.apiKey, tier: 'cost_effective', sleep: async () => undefined }),
    );
  }

  const parseExternal = (await import('@/app/api/internal/rag/ingest/jobs/[id]/parse-external/route')) as { POST: IngestRouteHandler };
  const advance = (await import('@/app/api/internal/rag/ingest/jobs/[id]/advance/route')) as { POST: IngestRouteHandler };
  const app = await startIngestAppServer({ 'parse-external': parseExternal.POST, advance: advance.POST });
  cleanups.push(() => app.close());

  const live = {
    RAG_INGEST_PIPELINE: 'unified',
    RAG_INGEST_ASYNC: 'on',
    RAG_PARSE_ROUTING: routing.routing,
    RAG_PARSER_ALLOW_CLOUD: process.env.RAG_PARSER_ALLOW_CLOUD ?? 'false',
    RAG_PARSE_PREMIUM_PAGE_BUDGET: process.env.RAG_PARSE_PREMIUM_PAGE_BUDGET ?? '0',
    RAG_PARSE_PREMIUM_MAX_PAGES_PER_DOC: process.env.RAG_PARSE_PREMIUM_MAX_PAGES_PER_DOC ?? String(FORCED_PREMIUM_MAX_PAGES_PER_DOC),
    RAG_PARSE_VLM_DETECT: 'false',
  };
  resetQueueConfigForTests();
  const queueConfig = () => loadQueueConfig(live);

  if (routing.forceTier) {
    const tier = routing.forceTier;
    for (const docType of options.docTypes) {
      await options.pg.query(
        `INSERT INTO rag_parse_tier_overrides (doc_type, min_tier, max_tier, updated_by) VALUES ($1, $2, $2, 'ingest-mode-harness')
         ON CONFLICT (doc_type) DO UPDATE SET min_tier = EXCLUDED.min_tier, max_tier = EXCLUDED.max_tier, updated_by = EXCLUDED.updated_by`,
        [docType, tier],
      );
    }
    cleanups.push(async () => {
      await options.pg.query('DELETE FROM rag_parse_tier_overrides WHERE doc_type = ANY($1::text[])', [options.docTypes]);
    });
  }

  const serviceKey = fixtureProcessEnv(edge.url).SUPABASE_SERVICE_ROLE_KEY as string;
  let jobs = 0;
  const needsReview: IngestRoutingSummary['needsReview'] = [];
  const ledger: IngestLedgerRow[] = [];

  async function run(item: IngestWork): Promise<string | null> {
    const queued = await enqueueIngest(item.input, { queueConfig });
    if (queued.status === 'failed' || queued.jobId === null) {
      throw new Error(`[Ingest Mode] ${item.label} was not queued (${queued.reason ?? 'no reason'})`);
    }
    if (queued.status === 'queued') {
      jobs += 1;
      currentPremium =
        routing.forceTier === 'premium' && item.recordedSha && item.pageCount ? premiumPages(recordedDir, item.recordedSha, item.pageCount) : null;
      const worker = await spawnSidecarModule(
        'rag_sidecar.ingest.run_once',
        ['--job', queued.jobId],
        {
          NEXT_PUBLIC_SUPABASE_URL: edge.url,
          SUPABASE_SERVICE_ROLE_KEY: serviceKey,
          RAG_APP_INTERNAL_URL: app.url,
          RAG_SIDECAR_SECRET: QUEUE_SIDECAR_SECRET,
          RAG_INGEST_CONVERTER: 'recorded',
          RAG_INGEST_RECORDED_DIR: recordedDir,
          UV_OFFLINE: '1',
          UV_FROZEN: '1',
        },
        { timeoutMs: WORKER_TIMEOUT_MS },
      ).done;
      currentPremium = null;
      if (worker.exitCode !== 0) {
        throw new Error(
          `[Ingest Mode] the worker for ${item.label} exited ${String(worker.exitCode)}${worker.timedOut ? ' (timed out)' : ''}: ${worker.stderr.slice(-1500)}`,
        );
      }
    }
    const [document] = (await options.pg.query<{ status: string }>('SELECT status FROM documents WHERE id = $1', [queued.documentId])).rows;
    const [job] = (
      await options.pg.query<Record<string, unknown>>(
        `SELECT status, error_class, error, needs_review_reason, filename, mime_type, doc_class, tier, pages, tier_page_counts, page_ranges,
                est_cost_usd, attempts
           FROM ingestion_jobs WHERE id = $1`,
        [queued.jobId],
      )
    ).rows;
    if (job && queued.status === 'queued') ledger.push(ledgerRowOf(job, item));
    // The ledger's terminal transition (0353) sets a quarantined job's unpublished document to failed rather than quarantined (logged
    // in deferred-items.md); either way it stays out of retrieval, so the job status is what says the injection scan held it.
    const status = item.expected === 'quarantined' && job?.status === 'quarantined' && document?.status !== 'ready' ? 'quarantined' : (document?.status ?? 'missing');
    if (status !== item.expected) {
      // A forced tier is a measurement: a page the pinned tier cannot parse ends needs_review (max_tier) and its document stays
      // unpublished, which is what retrieval on that tier sees.
      if (routing.forceTier && job?.status === 'needs_review') {
        needsReview.push({ filename: item.input.filename, reason: String(job.needs_review_reason ?? 'unknown') });
        return queued.documentId;
      }
      throw new Error(`[Ingest Mode] ${item.label} ended ${status} under ${routing.routing} routing (expected ${item.expected}; job ${JSON.stringify(job ?? null)})`);
    }
    return queued.documentId;
  }

  return {
    run,
    summary: () => ({
      routing: routing.routing,
      forceTier: routing.forceTier ?? null,
      jobs,
      llamaUploads: llama.uploads.length,
      needsReview: [...needsReview],
      ledger: [...ledger],
    }),
  };
}

function numberOrNull(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function ledgerRowOf(job: Record<string, unknown>, item: IngestWork): IngestLedgerRow {
  const counts: Record<string, number> = {};
  const raw = job.tier_page_counts && typeof job.tier_page_counts === 'object' ? (job.tier_page_counts as Record<string, unknown>) : {};
  for (const [tier, value] of Object.entries(raw)) {
    const count = numberOrNull(value);
    if (count !== null) counts[tier] = count;
  }
  return {
    filename: String(job.filename ?? item.input.filename),
    mime_type: typeof job.mime_type === 'string' ? job.mime_type : null,
    status: String(job.status),
    doc_class: typeof job.doc_class === 'string' ? job.doc_class : null,
    tier: typeof job.tier === 'string' ? job.tier : null,
    pages: numberOrNull(job.pages),
    harness_page_count: item.pageCount ?? null,
    tier_page_counts: counts,
    page_ranges: Array.isArray(job.page_ranges) ? job.page_ranges : [],
    est_cost_usd: numberOrNull(job.est_cost_usd),
    attempts: Array.isArray(job.attempts) ? job.attempts : [],
  };
}
