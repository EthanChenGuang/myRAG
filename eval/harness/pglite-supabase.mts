import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { vector } from '@electric-sql/pglite-pgvector';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { detectLanguage } from '@/lib/rag/lang/detect';
import { LEXICAL_VERSION, chunkLexicalText } from '@/lib/rag/lexical/chunk-text';
import { normalizeLexical } from '@/lib/rag/lexical/tokenize';
import { runRelex } from '@/lib/rag/ingest/relex/run';
import { fixtureLineageUuid, loadCorpus, type CorpusDocument } from './corpus.mts';
import type { FakeEdge } from './fake-edge.mts';
import { applyMigrations } from './migrations.mts';
import { embedText } from './fixture-embedder.mts';

export const FIXTURE_USER_ID = '00000000-0000-4000-8000-0000000000f1';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export type DeploymentMode = 'single-tenant' | 'multi-tenant';

/** prechunked inserts the corpus as pre-cut rows (the Phase 1 and 2 baseline); ingest sends every document through ingest(). */
export type FixtureMode = 'prechunked' | 'ingest';

const SQL_FILES: Record<DeploymentMode, string> = {
  'single-tenant': 'supabase/single-tenant-setup.sql',
  'multi-tenant': 'supabase/multi-tenant-setup.sql',
};

export interface FixtureDatabase {
  db: PGlite;
  fixtureUserId: string;
  corpusSha256: string;
  sqlSha256: Record<string, string>;
  /** Set by the ingest mode, which fills the database through a fake edge and leaves it running; the caller closes it. */
  edge?: FakeEdge;
  /** Parse-job uploads the ingest-mode builder saw while ingesting eval/fixtures/ingest/manifest.json fixtures. */
  ingestSidecarUploads?: Array<{ fileSha256: string; request: Record<string, unknown> }>;
  /** LlamaParse parse attempts during the ingest-mode build (expected zero). */
  ingestLlamaParseAttempts?: number;
  /** Chunking profile ids the ingest-mode builder seeded as building before ingestion. */
  seededChunkingProfiles?: string[];
  /** Ingest mode with table_split items: the isolated tenants of the long-table documents; the caller closes their databases. */
  tableSplitTenants?: import('./table-split.mts').TableSplitTenant[];
  /**
   * Ingest mode only: the golden id of every corpus document (the prechunked derivation from its path) to the id of the document the
   * build wrote from the same file, so item filters name the documents ingest mode actually wrote.
   */
  ingestDocumentIds?: Record<string, string>;
}

export const SUPABASE_SHIM_SQL = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA auth; CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon') $$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
CREATE SCHEMA storage; CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
CREATE TABLE storage.objects (id uuid DEFAULT gen_random_uuid() PRIMARY KEY, bucket_id text, name text, owner uuid);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;`;

export const SUPABASE_GRANTS_SQL = `
GRANT USAGE ON SCHEMA public, auth, storage TO anon, authenticated, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon, authenticated, service_role;
ALTER ROLE service_role BYPASSRLS;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;`;

/** Hosted Supabase grants EXECUTE on every new public function to the API roles; opt in to reproduce it. */
const SUPABASE_FUNCTION_DEFAULTS_SQL = `
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;`;

function vectorLiteral(values: number[]): string {
  return `[${values.join(',')}]`;
}

const LEXICAL_SHA_KEY = `lexical_version:${LEXICAL_VERSION}`;

type RelexRow = Record<string, unknown>;

/** Service-role RPC access over an in-process PGlite database (no HTTP). */
function pgliteRpcClient(db: PGlite): RpcClient {
  return {
    rpc(fn, args) {
      const keys = Object.keys(args);
      const sql = `SELECT * FROM ${fn}(${keys.map((key, index) => `${key} => $${index + 1}`).join(', ')})`;
      const run = db
        .query<RelexRow>(sql, keys.map((key) => args[key]))
        .then((result): RpcResponse => ({ data: result.rows as unknown[], error: null }))
        .catch((error: unknown): RpcResponse => {
          const code = (error as { code?: unknown } | null)?.code;
          return {
            data: null,
            error: { code: typeof code === 'string' ? code : 'P0001', message: error instanceof Error ? error.message : String(error) },
          };
        });
      const request: RpcRequest = {
        abortSignal: () => request,
        then: (onFulfilled, onRejected) => run.then(onFulfilled, onRejected),
      };
      return request;
    },
  };
}

export async function runFixtureRelex(db: PGlite): Promise<void> {
  await runRelex({ db: pgliteRpcClient(db), batchSize: 500 });
}

/**
 * Relex for the given chunk ids only, with the inputs and RPCs runRelex uses: a database ingest() filled keeps its own rows exactly as
 * written, including any it left without the current lexical version.
 */
export async function relexFixtureChunks(db: PGlite, chunkIds: ReadonlySet<string>): Promise<number> {
  const rpc = pgliteRpcClient(db);
  const rows: Array<{ id: string; lexical_text: string; language?: string }> = [];
  let after: string | null = null;
  for (;;) {
    const page: RpcResponse = await rpc.rpc('rag_relex_candidates', { p_after: after, p_version: LEXICAL_VERSION, p_limit: 1000, p_tenant_key: null });
    if (page.error) throw new Error(`[Fixture DB] rag_relex_candidates failed (${page.error.code ?? 'unknown'})`);
    const candidates = (page.data ?? []) as RelexRow[];
    for (const candidate of candidates) {
      const id = String(candidate.id);
      if (!chunkIds.has(id)) continue;
      const content = typeof candidate.content === 'string' ? candidate.content : '';
      const metadata = candidate.metadata;
      const row: { id: string; lexical_text: string; language?: string } = {
        id,
        lexical_text: chunkLexicalText({
          sectionPath: Array.isArray(candidate.section_path) ? candidate.section_path.map((entry) => String(entry)) : [],
          content,
          chunkKind: typeof candidate.chunk_kind === 'string' ? candidate.chunk_kind : null,
          metadata: metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? (metadata as Record<string, unknown>) : null,
          documentFilename: typeof candidate.document_filename === 'string' ? candidate.document_filename : '',
        }),
      };
      if (typeof candidate.language !== 'string') {
        const detected = detectLanguage(content);
        if (detected !== null) row.language = detected;
      }
      rows.push(row);
    }
    if (candidates.length < 1000) break;
    after = String(candidates[candidates.length - 1].id);
  }
  if (rows.length === 0) return 0;
  const written: RpcResponse = await rpc.rpc('rag_relex_batch', { p_rows: rows, p_version: LEXICAL_VERSION });
  if (written.error) throw new Error(`[Fixture DB] rag_relex_batch failed (${written.error.code ?? 'unknown'})`);
  return rows.length;
}

export interface EmptyFixtureDatabase {
  db: PGlite;
  fixtureUserId: string;
  sqlSha256: Record<string, string>;
}

/** The schema, the migrations and the fixture user, with no documents. */
export async function createEmptyFixtureDatabase(options: {
  deploymentMode: DeploymentMode;
  supabaseGrants?: boolean;
  supabaseFunctionDefaults?: boolean;
  migrations?: boolean;
  setupSqlPath?: string;
}): Promise<EmptyFixtureDatabase> {
  const { deploymentMode } = options;
  if (deploymentMode !== 'single-tenant' && deploymentMode !== 'multi-tenant') {
    throw new Error(`[Fixture DB] unsupported deployment mode: ${String(deploymentMode)}`);
  }

  const sqlRelpath = options.setupSqlPath ?? SQL_FILES[deploymentMode];
  const sqlBytes = fs.readFileSync(path.join(REPO_ROOT, sqlRelpath));

  const db = new PGlite({ extensions: { vector, pg_trgm } });
  try {
    await db.waitReady;
    await db.exec(SUPABASE_SHIM_SQL);
    if (options.supabaseGrants !== false) await db.exec(SUPABASE_GRANTS_SQL);
    if (options.supabaseFunctionDefaults === true) await db.exec(SUPABASE_FUNCTION_DEFAULTS_SQL);
    await db.exec(sqlBytes.toString('utf8'));
    if (options.migrations !== false) await applyMigrations(db, deploymentMode);

    if (deploymentMode === 'multi-tenant') {
      await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [FIXTURE_USER_ID, 'fixture-user@example.invalid']);
    }
  } catch (error) {
    await db.close().catch(() => undefined);
    throw error;
  }

  return { db, fixtureUserId: FIXTURE_USER_ID, sqlSha256: { [sqlRelpath]: crypto.createHash('sha256').update(sqlBytes).digest('hex') } };
}

type InsertColumn = [column: string, value: unknown, cast?: string];

async function insertRow(db: PGlite, table: string, columns: InsertColumn[]): Promise<void> {
  const names = columns.map(([column]) => column).join(', ');
  const placeholders = columns.map(([, , cast], index) => (cast ? `$${index + 1}::${cast}` : `$${index + 1}`)).join(', ');
  await db.query(`INSERT INTO ${table} (${names}) VALUES (${placeholders})`, columns.map(([, value]) => value));
}

async function hasPublicColumn(db: PGlite, table: string, column: string): Promise<boolean> {
  const result = await db.query<{ present: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2) AS present",
    [table, column],
  );
  return result.rows[0]?.present === true;
}

/** The highest version of every fixture lineage: that version is seeded current, the earlier ones superseded (D-40). */
export function latestLineageVersions(documents: readonly CorpusDocument[]): Map<string, number> {
  const latest = new Map<string, number>();
  for (const doc of documents) {
    if (doc.lineage) latest.set(doc.lineage.id, Math.max(latest.get(doc.lineage.id) ?? 0, doc.lineage.version));
  }
  return latest;
}

/**
 * The prechunked writer: inserts one corpus document and its pre-cut chunks as ready rows of the fixture tenant, bypassing ingest()
 * and its quarantine. Ingest mode uses it for the documents that simulate legacy or pre-scan content (D-13). A document with a fixture
 * lineage shares its lineage id, source and source key with the other versions; only the latest version is inserted current, so the
 * caller passes the latest versions and supersedes the earlier ones after relex (supersedeFixtureLineages).
 */
export async function prechunkedWriter(
  db: PGlite,
  deploymentMode: DeploymentMode,
  latestVersions?: ReadonlyMap<string, number>,
): Promise<(doc: CorpusDocument) => Promise<void>> {
  const multiTenant = deploymentMode === 'multi-tenant';
  // A setup from before Phase 3 (the frozen pre-Phase-3 files, migrations:false) has no doc_type columns; 0301 and 0304 add them as 'general' on upgrade.
  const documentsDocType = await hasPublicColumn(db, 'documents', 'doc_type');
  const chunksDocType = await hasPublicColumn(db, 'document_chunks', 'doc_type');
  return async (doc) => {
    let lineageColumns: InsertColumn[] = [];
    if (doc.lineage) {
      const latest = latestVersions?.get(doc.lineage.id);
      if (latest === undefined) throw new Error(`[Fixture DB] ${doc.relpath} declares a lineage; only the prechunked fixture build seeds lineages`);
      lineageColumns = [
        ['lineage_id', fixtureLineageUuid(doc.lineage.id)],
        ['version', doc.lineage.version],
        ['source', 'config_upload'],
        ['source_key', `fixture-lineage:${doc.lineage.id}`],
        ['is_current', doc.lineage.version === latest],
      ];
    }
    await insertRow(db, 'documents', [
      ['id', doc.id],
      ['filename', doc.filename],
      ['content', doc.content],
      [
        'metadata',
        JSON.stringify({
          relpath: doc.relpath,
          language: doc.language,
          ...(doc.fixtureDupTemplate !== undefined ? { fixture_dup_template: doc.fixtureDupTemplate } : {}),
        }),
        'jsonb',
      ],
      ...(multiTenant ? [['user_id', FIXTURE_USER_ID] satisfies InsertColumn] : []),
      ...(documentsDocType ? [['doc_type', doc.docType] satisfies InsertColumn] : []),
      ...lineageColumns,
      ['created_at', doc.createdAt],
    ]);

    for (const chunk of doc.chunks) {
      const metadata = {
        document_title: doc.filename,
        chunk_index: chunk.index,
        chunk_position: chunk.index + 1,
        total_chunks: doc.chunks.length,
        section: chunk.section,
        ...(doc.imageUrl ? { image_url: doc.imageUrl } : {}),
      };
      await insertRow(db, 'document_chunks', [
        ['id', chunk.id],
        ['document_id', doc.id],
        ['content', chunk.stored],
        ['embedding', vectorLiteral(embedText(chunk.text)), 'vector'],
        ...(multiTenant ? [['chunk_index', chunk.index] satisfies InsertColumn] : []),
        ['metadata', JSON.stringify(metadata), 'jsonb'],
        ...(chunksDocType ? [['doc_type', doc.docType] satisfies InsertColumn] : []),
        ['created_at', doc.createdAt],
      ]);
    }
  };
}

/**
 * D-40: every earlier version of a fixture lineage ends in the shape rag_publish_document_version leaves a superseded version in: ready,
 * not current, superseded_by the next version, chunks not current with no vector in any profile. Runs after relex, which writes lexical
 * text for current chunks only, so the superseded chunks keep the lexical text they had while current.
 */
export async function supersedeFixtureLineages(db: PGlite, documents: readonly CorpusDocument[]): Promise<void> {
  const byLineage = new Map<string, CorpusDocument[]>();
  for (const doc of documents) {
    if (!doc.lineage) continue;
    byLineage.set(doc.lineage.id, [...(byLineage.get(doc.lineage.id) ?? []), doc]);
  }
  for (const versions of byLineage.values()) {
    versions.sort((a, b) => a.lineage!.version - b.lineage!.version);
    for (let index = 0; index < versions.length - 1; index += 1) {
      const previous = versions[index].id;
      await db.query("UPDATE documents SET is_current = false, status = 'ready', superseded_by = $2 WHERE id = $1", [previous, versions[index + 1].id]);
      await db.query('UPDATE document_chunks SET is_current = false, embedding = NULL WHERE document_id = $1', [previous]);
      await db.query('DELETE FROM chunk_embeddings ce USING document_chunks c WHERE ce.chunk_id = c.id AND c.document_id = $1', [previous]);
      await db.query('DELETE FROM embedding_backfill_gaps g USING document_chunks c WHERE g.chunk_id = c.id AND c.document_id = $1', [previous]);
    }
  }
}

/** D-27: one dictionary row for a fixture database, written as the database owner (the writer RPCs are plan 04's). */
export interface TerminologySeedRow {
  /** 'shared' or a tenant key of the fixture's deployment mode. */
  layer: string;
  canonical: string;
  variants: string[];
  language: string;
  kind: 'synonym' | 'abbreviation' | 'alias' | 'identifier' | 'translation' | 'misspelling';
  mode: 'one_way' | 'equivalent';
  source_language?: string | null;
  target_language?: string | null;
}

/** Inserts the rows and a version-1 layer row per layer; normalized_variants come from the tokenizer's normalizer (D-09). */
export async function seedTerminology(db: PGlite, rows: readonly TerminologySeedRow[]): Promise<void> {
  if (rows.length === 0) return;
  for (const layer of new Set(rows.map((row) => row.layer))) {
    await db.query('INSERT INTO public.rag_term_layers (layer_key, version) VALUES ($1, 1) ON CONFLICT (layer_key) DO NOTHING', [layer]);
  }
  for (const row of rows) {
    await db.query(
      `INSERT INTO public.rag_term_entries
         (layer_key, canonical, variants, normalized_variants, language, kind, mode, source_language, target_language)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        row.layer,
        row.canonical,
        row.variants,
        row.variants.map((variant) => normalizeLexical(variant)),
        row.language,
        row.kind,
        row.mode,
        row.source_language ?? null,
        row.target_language ?? null,
      ],
    );
  }
}

export async function createFixtureDatabase(options: {
  deploymentMode: DeploymentMode;
  corpusDir: string;
  fixtureMode?: FixtureMode;
  /** Variables the run reads from the app environment; the ingest mode sets them before it imports the app, which is earlier than the caller can. */
  processEnv?: Record<string, string>;
  /** Ingest mode only: fill the database through the queue (D-40). */
  ingestRouting?: import('./ingest-mode.mts').IngestRoutingOptions;
  supabaseGrants?: boolean;
  migrations?: boolean;
  setupSqlPath?: string;
  /** Rebuild lexical_text after corpus load. Defaults to whether migrations run: the relex RPCs come from 0402, so a migrations:false caller applies them and then calls runFixtureRelex. */
  relex?: boolean;
  /** Ingest mode only: candidate chunking profiles seeded before the first document. */
  chunkingProfiles?: import('../../src/lib/rag-eval/contracts.generated.ts').ChunkingProfile[];
  /** Ingest mode only: also load the isolated table_split tenants. */
  tableSplit?: boolean;
  /** Ingest mode only: the doc type the table_split documents are loaded with (default: the manifest's). */
  tableSplitDocType?: string;
  /** Ingest mode only: ingestion switches layered over the build's fixed ingest env. */
  ingestEnv?: Record<string, string>;
  /** D-27: dictionary rows written after the corpus load, in either fixture mode. */
  terminologySeed?: readonly TerminologySeedRow[];
}): Promise<FixtureDatabase> {
  const { deploymentMode, corpusDir } = options;
  if (deploymentMode !== 'single-tenant' && deploymentMode !== 'multi-tenant') {
    throw new Error(`[Fixture DB] unsupported deployment mode: ${String(deploymentMode)}`);
  }
  const fixtureMode = options.fixtureMode ?? 'prechunked';
  if (fixtureMode !== 'prechunked' && fixtureMode !== 'ingest') {
    throw new Error(`[Fixture DB] unsupported fixture mode: ${String(fixtureMode)}`);
  }
  if (fixtureMode === 'ingest') {
    // Loaded on demand: the ingest code reads its environment at import time, which prechunked runs must not disturb.
    const { buildIngestFixtureDatabase } = await import('./ingest-mode.mts');
    const built = await buildIngestFixtureDatabase({
      deploymentMode,
      corpusDir,
      processEnv: options.processEnv,
      supabaseGrants: options.supabaseGrants,
      migrations: options.migrations,
      setupSqlPath: options.setupSqlPath,
      ...(options.chunkingProfiles?.length ? { chunkingProfiles: options.chunkingProfiles } : {}),
      ...(options.ingestRouting ? { routing: options.ingestRouting } : {}),
      ...(options.tableSplit ? { tableSplit: true } : {}),
      ...(options.tableSplit && options.tableSplitDocType ? { tableSplitDocType: options.tableSplitDocType } : {}),
      ...(options.ingestEnv ? { ingestEnv: options.ingestEnv } : {}),
    });
    if (options.terminologySeed?.length) {
      try {
        await seedTerminology(built.db, options.terminologySeed);
      } catch (error) {
        await built.db.close().catch(() => undefined);
        throw error;
      }
    }
    return built;
  }
  if (options.tableSplit) throw new Error('[Fixture DB] the table_split tenants need the ingest fixture mode');
  if (options.chunkingProfiles?.length) throw new Error('[Fixture DB] chunking profiles are seeded only in the ingest fixture mode');
  if (options.ingestRouting) throw new Error('[Fixture DB] routing and forced tiers need the ingest fixture mode');

  const corpus = loadCorpus(corpusDir);
  const { db, sqlSha256 } = await createEmptyFixtureDatabase(options);
  try {
    const writer = await prechunkedWriter(db, deploymentMode, latestLineageVersions(corpus.documents));
    for (const doc of corpus.documents) await writer(doc);
    if (options.terminologySeed?.length) await seedTerminology(db, options.terminologySeed);
    if (options.relex ?? (options.migrations !== false)) {
      await runFixtureRelex(db);
      sqlSha256[LEXICAL_SHA_KEY] = crypto.createHash('sha256').update(String(LEXICAL_VERSION)).digest('hex');
    }
    await supersedeFixtureLineages(db, corpus.documents);
  } catch (error) {
    await db.close().catch(() => undefined);
    throw error;
  }

  return { db, fixtureUserId: FIXTURE_USER_ID, corpusSha256: corpus.corpusSha256, sqlSha256 };
}
