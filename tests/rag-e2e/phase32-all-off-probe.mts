import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';

// Plan 03.2-66 (D-46): one probe that runs unchanged on the pre-phase tree (to record the reference) and on this tree (to compare).
// It only uses harness and app APIs that existed before Phase 3.2, and it ingests only the fixtures that existed then.

/** The eighteen variables of D-47; the probe runs with all of them absent except RAG_TABLE_HEADER_REPEAT, which it builds with at profile. */
export const PHASE_32_VARIABLES = [
  'RAG_SUPPORTED_LANGUAGES',
  'RAG_PRIMARY_LANGUAGE',
  'RAG_LANGUAGE_AWARE_INGEST',
  'RAG_TABLE_HEADER_REPEAT',
  'RAG_TABLE_ROW_SERIALIZATION',
  'RAG_CAPTION_LANGUAGE',
  'RAG_BGE_M3_SERVING',
  'RAG_DOC_TRANSLATION',
  'RAG_DOC_TRANSLATION_MODEL',
  'RAG_HIDDEN_TEXT_CHECK',
  'RAG_INGEST_LINK_CHECK',
  'RAG_OUTPUT_LINK_ALLOWLIST',
  'RAG_UPLOAD_APPROVAL',
  'RAG_SCOPE_TAGS',
  'RAG_SCOPE_TAG_SUGGEST',
  'RAG_SUPERSESSION_DETECT',
  'RAG_EFFECTIVE_DATES',
  'RAG_EFFECTIVE_DATE_LLM_EXTRACT',
] as const;

export const SNAPSHOT_TABLES = ['documents', 'document_chunks'] as const;
export type SnapshotTable = (typeof SNAPSHOT_TABLES)[number];
export type PathName = 'inline' | 'queued';
export type PipelineName = 'legacy' | 'v2';

export interface ColumnInfo {
  name: string;
  type: string;
  default: string | null;
}

export type SnapshotRow = Record<string, unknown>;

export interface PathSnapshot {
  documents: SnapshotRow[];
  document_chunks: SnapshotRow[];
  /** Row counts of every public table, so a table this phase created can be shown empty. */
  table_rows: Record<string, number>;
}

export interface RetrievalProbe {
  query_id: string;
  status: string;
  reason: string;
  retrieval_config_hash: string | null;
  candidates: Array<{ chunk: string; similarity: number | null }>;
  context_sha256: string;
  source_images: number;
}

export interface ProbeSnapshot {
  /** Calls outside Supabase (sidecar routes, model endpoints) by method and path, per build including its retrieval requests. */
  external_calls: Record<PathName, Record<string, number>>;
  columns: Record<SnapshotTable, ColumnInfo[]>;
  tables: string[];
  paths: Record<PathName, PathSnapshot>;
  retrieval: Record<PipelineName, RetrievalProbe[]>;
}

export interface ProbeInputs {
  /** The corpus files of the pre-phase tree; later corpus additions are left out so both trees ingest the same bytes. */
  corpus_files: Array<{ relpath: string; sha256: string }>;
  typed_fixture_ids: string[];
  parse_fixture_ids: string[];
  queries: Array<{ id: string; question: string }>;
}

const REPO_ROOT = process.cwd();
const CORPUS_DIR = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const TYPED_MANIFEST = path.join(REPO_ROOT, 'eval/fixtures/ingest/manifest.json');
const GOLDEN = path.join(REPO_ROOT, 'eval/fixtures/golden.jsonl');
const V2_LANGUAGES = { RAG_SUPPORTED_LANGUAGES: 'zh,en,it', RAG_PRIMARY_LANGUAGE: 'en' };
const QUERIES_PER_CATEGORY = 1;
// Above the pre-refusal pool, so the request cap that 04.1-15 added to the final v2 list cuts nothing in either tree.
const MAX_RESULTS = 100;
const SUPABASE_PATHS = /^\/(rest|storage|auth|functions|realtime)\/v1\//;

function recordExternalCalls(): { calls: Record<string, number>; restore: () => void } {
  const calls: Record<string, number> = {};
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (!SUPABASE_PATHS.test(url.pathname)) {
      const key = `${method} ${url.pathname.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, ':id')}`;
      calls[key] = (calls[key] ?? 0) + 1;
    }
    return original(input, init);
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

const VOLATILE_TYPES = new Set(['timestamp with time zone', 'timestamp without time zone']);

/** The inputs of the pre-phase tree: every typed and parse fixture it had and one single-turn question per golden category. */
export async function currentInputs(): Promise<ProbeInputs> {
  const manifest = JSON.parse(fs.readFileSync(TYPED_MANIFEST, 'utf8')) as { fixtures?: Array<{ id: string }> } | Array<{ id: string }>;
  const typed = (Array.isArray(manifest) ? manifest : (manifest.fixtures ?? [])).map((entry) => entry.id).sort();
  const { ingestModeParseFixtures } = await import('../../eval/harness/ingest-mode.mts');
  const parse = ingestModeParseFixtures()
    .filter((fixture: { typedTwin?: unknown }) => !fixture.typedTwin)
    .map((fixture: { id: string }) => fixture.id)
    .sort();
  const seen = new Map<string, number>();
  const queries: ProbeInputs['queries'] = [];
  for (const line of fs.readFileSync(GOLDEN, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const item = JSON.parse(line) as { id: string; category: string; question?: string; conversation?: unknown[] };
    if (!item.question || (item.conversation?.length ?? 0) > 0) continue;
    const count = seen.get(item.category) ?? 0;
    if (count >= QUERIES_PER_CATEGORY) continue;
    seen.set(item.category, count + 1);
    queries.push({ id: item.id, question: item.question });
  }
  const corpus_files: ProbeInputs['corpus_files'] = [];
  for (const language of fs.readdirSync(CORPUS_DIR).sort()) {
    const dir = path.join(CORPUS_DIR, language);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const name of fs.readdirSync(dir).sort()) {
      if (!name.endsWith('.md')) continue;
      const relpath = `${language}/${name}`;
      corpus_files.push({ relpath, sha256: fileSha256(path.join(CORPUS_DIR, relpath)) });
    }
  }
  return { corpus_files, typed_fixture_ids: typed, parse_fixture_ids: parse, queries };
}

async function columnsOf(db: PGlite, table: string): Promise<ColumnInfo[]> {
  const rows = (
    await db.query<{ name: string; type: string; default: string | null }>(
      `SELECT column_name AS name, data_type AS type, column_default AS default
         FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY column_name`,
      [table],
    )
  ).rows;
  return rows.map((row) => ({ name: row.name, type: row.type, default: row.default }));
}

async function publicTables(db: PGlite): Promise<string[]> {
  return (
    await db.query<{ name: string }>(
      "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1",
    )
  ).rows.map((row) => row.name);
}

function fileSha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** A corpus directory holding exactly the recorded files; a changed byte fails here instead of showing up as a row difference. */
export function pinnedCorpusDir(files: ProbeInputs['corpus_files']): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase32-corpus-'));
  for (const file of files) {
    const source = path.join(CORPUS_DIR, file.relpath);
    if (!fs.existsSync(source)) throw new Error(`[Phase 3.2 All-off] corpus file ${file.relpath} is missing`);
    if (fileSha256(source) !== file.sha256) throw new Error(`[Phase 3.2 All-off] corpus file ${file.relpath} changed since the recording`);
    fs.mkdirSync(path.dirname(path.join(dir, file.relpath)), { recursive: true });
    fs.copyFileSync(source, path.join(dir, file.relpath));
  }
  return dir;
}

function sha(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/** Canonical JSON with sorted keys, so a jsonb value compares by content. */
export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.keys(value as object).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
  }
  return value;
}

async function tableRows(db: PGlite, table: SnapshotTable, columns: ColumnInfo[]): Promise<SnapshotRow[]> {
  const order = table === 'documents' ? 'source, source_key, version' : 'document_id, chunk_index';
  // Vectors and other user-defined types are read as text and hashed; a timestamp is wall clock, so only whether it is set is kept.
  const select = columns
    .map((column) =>
      VOLATILE_TYPES.has(column.type)
        ? `(${column.name} IS NOT NULL) AS ${column.name}`
        : column.type === 'USER-DEFINED'
          ? `${column.name}::text AS ${column.name}`
          : column.name,
    )
    .join(', ');
  const rows = (await db.query<SnapshotRow>(`SELECT ${select} FROM ${table} ORDER BY ${order}`)).rows;
  const userDefined = new Set(columns.filter((column) => column.type === 'USER-DEFINED').map((column) => column.name));
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([name, value]) => [
        name,
        userDefined.has(name) && typeof value === 'string' ? `sha:${sha(value)}` : value instanceof Date ? value.toISOString() : canonical(value),
      ]),
    ),
  );
}

async function rowCounts(db: PGlite, tables: string[]): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of tables) counts[table] = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]?.n ?? -1;
  return counts;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const WALL_CLOCK_KEYS = /(_at|At)$/;

/**
 * Document and chunk ids come from gen_random_uuid(), so two builds differ in every id. Each document id is replaced by its source,
 * source key and version, each chunk id by that key and its chunk index, and any other id (a parse cache row) by a placeholder.
 * Wall-clock values inside JSON (quarantined_at and the like) are masked the same way top-level timestamps are left out.
 */
function stabilise(value: unknown, ids: Map<string, string>, key?: string): unknown {
  if (typeof value === 'string') {
    if (key && WALL_CLOCK_KEYS.test(key) && ISO_TIME.test(value)) return '<time>';
    return value.replace(UUID, (id) => ids.get(id) ?? '<uuid>');
  }
  if (Array.isArray(value)) return value.map((entry) => stabilise(entry, ids));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, entry]) => [name, stabilise(entry, ids, name)]));
  }
  return value;
}

function stableRows(documents: SnapshotRow[], chunks: SnapshotRow[]): { documents: SnapshotRow[]; chunks: SnapshotRow[]; ids: Map<string, string> } {
  const ids = new Map<string, string>();
  for (const row of documents) ids.set(String(row.id), `doc:${String(row.source)}|${String(row.source_key)}|v${String(row.version)}`);
  for (const row of chunks) ids.set(String(row.id), `${ids.get(String(row.document_id)) ?? '<uuid>'}#${String(row.chunk_index)}`);
  const docs = documents.map((row) => stabilise(row, ids) as SnapshotRow);
  const chunkRows = chunks
    .map((row) => stabilise(row, ids) as SnapshotRow)
    .sort((a, b) => String(a.id).localeCompare(String(b.id), 'en', { numeric: true }));
  return { documents: docs, chunks: chunkRows, ids };
}

async function snapshotPath(
  db: PGlite,
  columns: Record<SnapshotTable, ColumnInfo[]>,
  tables: string[],
): Promise<{ snapshot: PathSnapshot; chunkIds: Map<string, string> }> {
  const stable = stableRows(await tableRows(db, 'documents', columns.documents), await tableRows(db, 'document_chunks', columns.document_chunks));
  return {
    snapshot: { documents: stable.documents, document_chunks: stable.chunks, table_rows: await rowCounts(db, tables) },
    chunkIds: stable.ids,
  };
}

function clearProbeEnv(): void {
  for (const name of ['RAG_PIPELINE', 'RAG_INGEST_PIPELINE', 'RAG_SUPPORTED_LANGUAGES', 'RAG_PRIMARY_LANGUAGE']) delete process.env[name];
}

async function retrievalProbes(
  pipeline: PipelineName,
  inputs: ProbeInputs,
  chunkIds: Map<string, string>,
): Promise<RetrievalProbe[]> {
  const rag = await import('@/lib/rag');
  const ragConfig = await import('@/lib/rag/config');
  const { mintScope } = await import('@/lib/rag/tenant/scope');
  const scope = mintScope('single', null, null);
  if (pipeline === 'v2') Object.assign(process.env, { RAG_PIPELINE: 'v2', ...V2_LANGUAGES });
  else delete process.env.RAG_PIPELINE;
  ragConfig.resetRagConfigForTests();
  const out: RetrievalProbe[] = [];
  try {
    for (const query of inputs.queries) {
      const result = await rag.runRetrieval({
        scope,
        query: query.question,
        profile: 'eval',
        options: { maxResults: MAX_RESULTS, fallbackToLowerThreshold: true },
        signal: new AbortController().signal,
      } as Parameters<typeof rag.runRetrieval>[0]);
      out.push({
        query_id: query.id,
        status: result.status,
        reason: result.reason,
        retrieval_config_hash: result.retrievalConfigHash ?? null,
        candidates: result.candidates.map((candidate) => {
          const id = String(candidate.chunk_id);
          const similarity = candidate.similarity;
          return { chunk: chunkIds.get(id) ?? id, similarity: typeof similarity === 'number' ? Math.round(similarity * 1e6) / 1e6 : null };
        }),
        context_sha256: sha(result.context),
        source_images: result.sourceImages.length,
      });
    }
  } finally {
    for (const name of ['RAG_PIPELINE', ...Object.keys(V2_LANGUAGES)]) delete process.env[name];
    ragConfig.resetRagConfigForTests();
  }
  return out;
}

/** Builds the fixture corpus inline and through the queue, with every Phase 3.2 variable unset (header repetition at profile), and records what each build stored. */
export async function probeWritePaths(inputs: ProbeInputs, options: { queued?: boolean } = {}): Promise<ProbeSnapshot> {
  clearProbeEnv();
  const ingestMode = await import('../../eval/harness/ingest-mode.mts');
  const corpusDir = pinnedCorpusDir(inputs.corpus_files);
  const common = {
    deploymentMode: 'single-tenant' as const,
    corpusDir,
    includeTypedFixtures: true,
    typedFixtureIds: inputs.typed_fixture_ids,
    parseFixtureIds: inputs.parse_fixture_ids,
    // D-19 (03.2-67): header repetition defaults to always since this plan, so the pre-phase chunking is the explicit profile
    // value; the pre-phase tree ignores this option.
    ingestEnv: { RAG_TABLE_HEADER_REPEAT: 'profile' },
  };

  const inlineCalls = recordExternalCalls();
  let inline: Awaited<ReturnType<typeof ingestMode.buildIngestFixtureDatabase>>;
  try {
    inline = await ingestMode.buildIngestFixtureDatabase(common);
  } catch (error) {
    inlineCalls.restore();
    throw error;
  }
  let snapshot: ProbeSnapshot;
  try {
    const columns = { documents: await columnsOf(inline.db, 'documents'), document_chunks: await columnsOf(inline.db, 'document_chunks') };
    const tables = await publicTables(inline.db);
    const inlinePath = await snapshotPath(inline.db, columns, tables);
    const legacy = await retrievalProbes('legacy', inputs, inlinePath.chunkIds);
    const v2 = await retrievalProbes('v2', inputs, inlinePath.chunkIds);
    snapshot = {
      external_calls: { inline: inlineCalls.calls, queued: {} },
      columns,
      tables,
      paths: { inline: inlinePath.snapshot, queued: inlinePath.snapshot },
      retrieval: { legacy, v2 },
    };
  } finally {
    inlineCalls.restore();
    await inline.edge?.close().catch(() => undefined);
    await inline.db.close().catch(() => undefined);
  }
  clearProbeEnv();

  if (options.queued === false) {
    fs.rmSync(corpusDir, { recursive: true, force: true });
    return snapshot;
  }
  const queuedCalls = recordExternalCalls();
  let queued: Awaited<ReturnType<typeof ingestMode.buildIngestFixtureDatabase>>;
  try {
    queued = await ingestMode.buildIngestFixtureDatabase({ ...common, routing: { routing: 'fixed' } });
  } finally {
    queuedCalls.restore();
  }
  snapshot.external_calls.queued = queuedCalls.calls;
  try {
    snapshot.paths.queued = (await snapshotPath(queued.db, snapshot.columns, snapshot.tables)).snapshot;
  } finally {
    await queued.edge?.close().catch(() => undefined);
    await queued.db.close().catch(() => undefined);
  }
  clearProbeEnv();
  fs.rmSync(corpusDir, { recursive: true, force: true });
  return snapshot;
}

const INLINE_LIMIT = 32;
/** JSON columns whose keys are compared one by one, so an additive key can be named without hiding the rest of the object. */
export const KEYED_JSON_COLUMNS = new Set(['metadata', 'processing_state']);

export function compactValue(value: unknown): unknown {
  const text = JSON.stringify(canonical(value)) ?? 'null';
  return text.length <= INLINE_LIMIT ? value : `sha:${sha(text)}`;
}

/** Long values become a short hash (the committed reference stays small); keyed JSON columns are compacted per key. */
export function compactRow(row: SnapshotRow): SnapshotRow {
  return Object.fromEntries(
    Object.entries(row).map(([name, value]) => [
      name,
      KEYED_JSON_COLUMNS.has(name) && value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, compactValue(entry)]))
        : compactValue(value),
    ]),
  );
}

/** Rows stored column-wise: the column names once, then one value array per row. */
export interface ColumnarRows {
  columns: string[];
  rows: unknown[][];
}

export interface CompactPathSnapshot {
  documents: ColumnarRows;
  document_chunks: ColumnarRows;
  table_rows: Record<string, number>;
}

export type CompactProbeSnapshot = Omit<ProbeSnapshot, 'paths'> & { paths: Record<PathName, CompactPathSnapshot> };

function columnar(rows: SnapshotRow[]): ColumnarRows {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))].sort();
  return { columns, rows: rows.map((row) => columns.map((column) => (column in row ? row[column] : null))) };
}

export function fromColumnar(table: ColumnarRows): SnapshotRow[] {
  return table.rows.map((values) => Object.fromEntries(table.columns.map((column, index) => [column, values[index]])));
}

export function compactSnapshot(snapshot: ProbeSnapshot): CompactProbeSnapshot {
  const compactPath = (entry: PathSnapshot): CompactPathSnapshot => ({
    documents: columnar(entry.documents.map(compactRow)),
    document_chunks: columnar(entry.document_chunks.map(compactRow)),
    table_rows: entry.table_rows,
  });
  return { ...snapshot, paths: { inline: compactPath(snapshot.paths.inline), queued: compactPath(snapshot.paths.queued) } };
}
