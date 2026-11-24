import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { vector } from '@electric-sql/pglite-pgvector';
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

function vectorLiteral(values: number[]): string {
  return `[${values.join(',')}]`;
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
    if (options.supabaseGrants) await db.exec(SUPABASE_GRANTS_SQL);
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

export async function createFixtureDatabase(options: {
  deploymentMode: DeploymentMode;
  corpusDir: string;
  fixtureMode?: FixtureMode;
  /** Variables the run reads from the app environment; the ingest mode sets them before it imports the app, which is earlier than the caller can. */
  processEnv?: Record<string, string>;
  supabaseGrants?: boolean;
  migrations?: boolean;
  setupSqlPath?: string;
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
    });
  }

  const corpus = loadCorpus(corpusDir);
  const { db, sqlSha256 } = await createEmptyFixtureDatabase(options);
  try {
    const multiTenant = deploymentMode === 'multi-tenant';
    for (const doc of corpus.documents) {
      if (multiTenant) {
        await db.query(
          'INSERT INTO documents (id, filename, content, metadata, user_id, created_at) VALUES ($1, $2, $3, $4::jsonb, $5, $6)',
          [doc.id, doc.filename, doc.content, JSON.stringify({ relpath: doc.relpath, language: doc.language }), FIXTURE_USER_ID, doc.createdAt],
        );
      } else {
        await db.query('INSERT INTO documents (id, filename, content, metadata, created_at) VALUES ($1, $2, $3, $4::jsonb, $5)', [
          doc.id,
          doc.filename,
          doc.content,
          JSON.stringify({ relpath: doc.relpath, language: doc.language }),
          doc.createdAt,
        ]);
      }

      for (const chunk of doc.chunks) {
        const metadata = {
          document_title: doc.filename,
          chunk_index: chunk.index,
          chunk_position: chunk.index + 1,
          total_chunks: doc.chunks.length,
          section: chunk.section,
          ...(doc.imageUrl ? { image_url: doc.imageUrl } : {}),
        };
        const embedding = vectorLiteral(embedText(chunk.text));
        if (multiTenant) {
          await db.query(
            'INSERT INTO document_chunks (id, document_id, content, embedding, chunk_index, metadata, created_at) VALUES ($1, $2, $3, $4::vector, $5, $6::jsonb, $7)',
            [chunk.id, doc.id, chunk.stored, embedding, chunk.index, JSON.stringify(metadata), doc.createdAt],
          );
        } else {
          await db.query(
            'INSERT INTO document_chunks (id, document_id, content, embedding, metadata, created_at) VALUES ($1, $2, $3, $4::vector, $5::jsonb, $6)',
            [chunk.id, doc.id, chunk.stored, embedding, JSON.stringify(metadata), doc.createdAt],
          );
        }
      }
    }
  } catch (error) {
    await db.close().catch(() => undefined);
    throw error;
  }

  return { db, fixtureUserId: FIXTURE_USER_ID, corpusSha256: corpus.corpusSha256, sqlSha256 };
}
