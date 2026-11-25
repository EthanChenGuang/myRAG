import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { vector } from '@electric-sql/pglite-pgvector';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { LEXICAL_VERSION } from '@/lib/rag/lexical/chunk-text';
import { runRelex } from '@/lib/rag/ingest/relex/run';
import { loadCorpus } from './corpus.mts';
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
}

const SUPABASE_SHIM_SQL = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA auth; CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon') $$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
CREATE SCHEMA storage; CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
CREATE TABLE storage.objects (id uuid DEFAULT gen_random_uuid() PRIMARY KEY, bucket_id text, name text, owner uuid);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;`;

const SUPABASE_GRANTS_SQL = `
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

export async function createFixtureDatabase(options: {
  deploymentMode: DeploymentMode;
  corpusDir: string;
  fixtureMode?: FixtureMode;
  /** Variables the run reads from the app environment; the ingest mode sets them before it imports the app, which is earlier than the caller can. */
  processEnv?: Record<string, string>;
  supabaseGrants?: boolean;
  migrations?: boolean;
  setupSqlPath?: string;
  /** Rebuild lexical_text after corpus load. Defaults to whether migrations run: the relex RPCs come from 0402, so a migrations:false caller applies them and then calls runFixtureRelex. */
  relex?: boolean;
  /** Ingest mode only: candidate chunking profiles seeded before the first document. */
  chunkingProfiles?: import('../../src/lib/rag-eval/contracts.generated.ts').ChunkingProfile[];
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
    return buildIngestFixtureDatabase({
      deploymentMode,
      corpusDir,
      processEnv: options.processEnv,
      supabaseGrants: options.supabaseGrants,
      migrations: options.migrations,
      setupSqlPath: options.setupSqlPath,
      ...(options.chunkingProfiles?.length ? { chunkingProfiles: options.chunkingProfiles } : {}),
    });
  }
  if (options.chunkingProfiles?.length) throw new Error('[Fixture DB] chunking profiles are seeded only in the ingest fixture mode');

  const corpus = loadCorpus(corpusDir);
  const { db, sqlSha256 } = await createEmptyFixtureDatabase(options);
  try {
    const multiTenant = deploymentMode === 'multi-tenant';
    // A setup from before Phase 3 (the frozen pre-Phase-3 files, migrations:false) has no doc_type columns; 0301 and 0304 add them as 'general' on upgrade.
    const documentsDocType = await hasPublicColumn(db, 'documents', 'doc_type');
    const chunksDocType = await hasPublicColumn(db, 'document_chunks', 'doc_type');
    for (const doc of corpus.documents) {
      await insertRow(db, 'documents', [
        ['id', doc.id],
        ['filename', doc.filename],
        ['content', doc.content],
        ['metadata', JSON.stringify({ relpath: doc.relpath, language: doc.language }), 'jsonb'],
        ...(multiTenant ? [['user_id', FIXTURE_USER_ID] satisfies InsertColumn] : []),
        ...(documentsDocType ? [['doc_type', doc.docType] satisfies InsertColumn] : []),
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
    }
    if (options.relex ?? (options.migrations !== false)) {
      await runFixtureRelex(db);
      sqlSha256[LEXICAL_SHA_KEY] = crypto.createHash('sha256').update(String(LEXICAL_VERSION)).digest('hex');
    }
  } catch (error) {
    await db.close().catch(() => undefined);
    throw error;
  }

  return { db, fixtureUserId: FIXTURE_USER_ID, corpusSha256: corpus.corpusSha256, sqlSha256 };
}
