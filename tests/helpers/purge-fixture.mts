import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';

export const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
export const PROFILE_1024 = 'voyage-4-large-1024';
export const FILE_NAME_MARK = 'synthetic-purge-source';
export const TEXT_MARK = 'Synthetic purge sentence';
export const TEXT_LEAKS = new RegExp(`${FILE_NAME_MARK}|${TEXT_MARK}|archive/purge-`, 'i');

type Row = Record<string, unknown>;
export type Role = 'anon' | 'authenticated' | 'service_role';

export interface Tenant {
  key: string;
  userId: string;
  orgId: string | null;
}

export interface PurgeWorld {
  db: PGlite;
  mode: DeploymentMode;
  tenantA: Tenant;
  /** Multi-tenant only; null in single-tenant (one tenant). */
  tenantB: Tenant | null;
  /** Administers tenant A. */
  adminA: string;
  /** Multi-tenant: an admin of tenant B only. Single-tenant: a user who is not an admin. */
  outsider: string;
  otherModeKey: string;
}

export interface SeededLineage {
  lineageId: string;
  versionIds: string[];
  chunkIds: string[];
  hashes: string[];
  objectKeys: string[];
  parsePrefix: string;
  sourceKey: string;
  fileId: string | null;
  connectionId: string | null;
  answerRecordId: string;
  chatId: string;
  cacheId: string;
}

export interface SeedOptions {
  nango?: { connectionUuid: string; connectionId: string; fileId: string };
  /** file_sha256 of version 1 (to share a parse-cache row with another lineage). */
  sharedHash?: string;
}

const hex = (bytes = 32): string => crypto.randomBytes(bytes).toString('hex');

export function halfvec(dims: number, seed: number): string {
  return `[${Array.from({ length: dims }, (_, i) => (((i * 31 + seed) % 97) / 97).toFixed(4)).join(',')}]`;
}

export async function rows(db: PGlite, sql: string, params: unknown[] = []): Promise<Row[]> {
  return (await db.query<Row>(sql, params)).rows;
}

export async function count(db: PGlite, sql: string, params: unknown[] = []): Promise<number> {
  const result = await db.query<{ n: number | string }>(sql, params);
  return Number(result.rows[0]?.n ?? 0);
}

export function sqlState(error: unknown): string {
  return typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : '';
}

export async function asRole<T>(db: PGlite, role: Role, userId: string | null, run: () => Promise<T>): Promise<T> {
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claim.role', $2, false)", [userId ?? '', role]);
  await db.exec(`SET ROLE ${role}`);
  try {
    return await run();
  } finally {
    await db.exec('RESET ROLE');
    await db.query("SELECT set_config('request.jwt.claim.sub', '', false), set_config('request.jwt.claim.role', '', false)");
  }
}

async function createUser(db: PGlite): Promise<string> {
  const id = crypto.randomUUID();
  await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [id, `user-${id.slice(0, 8)}@example.invalid`]);
  return id;
}

async function createOrganization(db: PGlite, ownerId: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.query('INSERT INTO organizations (id, name, slug, owner_id) VALUES ($1, $2, $3, $4)', [id, 'Synthetic org', `org-${id.slice(0, 8)}`, ownerId]);
  await db.query(
    `INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'owner')
     ON CONFLICT (organization_id, user_id) DO UPDATE SET role = 'owner'`,
    [id, ownerId],
  );
  return id;
}

export async function createWorld(mode: DeploymentMode): Promise<PurgeWorld> {
  const db = (await createEmptyFixtureDatabase({ deploymentMode: mode })).db;
  const userA = await createUser(db);
  const userB = await createUser(db);
  await db.query('INSERT INTO admin_users (id) VALUES ($1)', [userA]);
  if (mode === 'multi-tenant') {
    const orgA = await createOrganization(db, userA);
    const orgB = await createOrganization(db, userB);
    await db.query('INSERT INTO admin_users (id) VALUES ($1)', [userB]);
    return {
      db,
      mode,
      tenantA: { key: `o:${orgA}`, userId: userA, orgId: orgA },
      tenantB: { key: `o:${orgB}`, userId: userB, orgId: orgB },
      adminA: userA,
      outsider: userB,
      otherModeKey: 's:default',
    };
  }
  return {
    db,
    mode,
    tenantA: { key: 's:default', userId: userA, orgId: null },
    tenantB: null,
    adminA: userA,
    outsider: userB,
    otherModeKey: `o:${crypto.randomUUID()}`,
  };
}

export async function createConnection(world: PurgeWorld, tenant: Tenant): Promise<{ connectionUuid: string; connectionId: string }> {
  const connectionUuid = crypto.randomUUID();
  const connectionId = `conn-${hex(6)}`;
  await world.db.query(
    "INSERT INTO nango_connections (id, user_id, connection_id, provider, status) VALUES ($1, $2, $3, $4, 'connected')",
    [connectionUuid, tenant.userId, connectionId, `provider-${hex(4)}`],
  );
  return { connectionUuid, connectionId };
}

function citation(n: number, documentId: string, quote: string): Row {
  return {
    n,
    alias: `S${n}`,
    chunkIds: [`chunk-${n}`],
    documentId,
    documentName: `${FILE_NAME_MARK}-${n}.md`,
    documentVersion: 2,
    page: 1,
    sectionPath: ['Synthetic part'],
    quote,
    quoteHash: crypto.createHash('sha256').update(quote).digest('hex'),
    strategy: 'chunk-alias',
  };
}

async function insertDocument(world: PurgeWorld, tenant: Tenant, fields: Row): Promise<void> {
  const base: Row = { filename: `${FILE_NAME_MARK}.md`, content: `${TEXT_MARK} full text.`, metadata: '{}' };
  if (world.mode === 'multi-tenant') {
    base.user_id = tenant.userId;
    base.organization_id = tenant.orgId;
  }
  const all = { ...base, ...fields };
  const names = Object.keys(all);
  const placeholders = names.map((name, i) => (name === 'metadata' || name === 'processing_state' ? `$${i + 1}::jsonb` : `$${i + 1}`));
  await world.db.query(`INSERT INTO documents (${names.join(', ')}) VALUES (${placeholders.join(', ')})`, Object.values(all));
}

/** Two versions (v1 superseded by v2), chunks with per-profile vectors, a parent, jobs, a parse-cache row, a cache entry, an answer record and a chat. */
export async function seedLineage(world: PurgeWorld, tenant: Tenant, options: SeedOptions = {}): Promise<SeededLineage> {
  const { db } = world;
  const lineageId = crypto.randomUUID();
  const v1 = crypto.randomUUID();
  const v2 = crypto.randomUUID();
  const hashes = [options.sharedHash ?? hex(), hex()];
  const nango = options.nango;
  const sourceKey = nango ? nango.fileId : `archive/purge-${lineageId.slice(0, 8)}.md`;
  const objectKeys: string[] = [];
  for (const [index, id] of [v1, v2].entries()) {
    const version = index + 1;
    const original = `${tenant.key}/${lineageId}/${version}/original.md`;
    const parse = `${tenant.key}/${lineageId}/${version}/parse.md`;
    objectKeys.push(original, parse);
    const fields: Row = {
      id,
      lineage_id: lineageId,
      version,
      is_current: version === 2,
      source_key: sourceKey,
      file_sha256: hashes[index],
      original_path: original,
      processing_state: JSON.stringify({ artifacts: { parse } }),
    };
    if (nango) {
      Object.assign(fields, { source: 'nango', source_provider: 'google-drive', source_file_id: nango.fileId, source_connection_id: nango.connectionId });
    }
    await insertDocument(world, tenant, fields);
  }
  await db.query('UPDATE documents SET superseded_by = $1 WHERE id = $2', [v2, v1]);
  const keys = await rows(db, 'SELECT DISTINCT tenant_key FROM documents WHERE lineage_id = $1', [lineageId]);
  assert.deepEqual(keys.map((row) => row.tenant_key), [tenant.key], 'seeded documents carry the tenant key');

  await db.query(
    `INSERT INTO document_chunks (id, document_id, content, metadata, chunk_index)
     SELECT gen_random_uuid(), d.id, $2 || ' chunk ' || g, '{}'::jsonb, g
       FROM documents d CROSS JOIN generate_series(0, 1) AS g WHERE d.lineage_id = $1`,
    [lineageId, TEXT_MARK],
  );
  const chunkIds = (await rows(db, 'SELECT c.id FROM document_chunks c JOIN documents d ON d.id = c.document_id WHERE d.lineage_id = $1 ORDER BY c.id', [lineageId])).map(
    (row) => String(row.id),
  );
  await db.query(
    `INSERT INTO chunk_embeddings (chunk_id, profile_id, tenant_key, embedding, embedding_model, dims)
     SELECT c.id, $2, c.tenant_key, $3::halfvec, 'voyage-4-large', 1024 FROM document_chunks c WHERE c.id = ANY ($1::uuid[])`,
    [chunkIds, PROFILE_1024, halfvec(1024, 7)],
  );
  await db.query(
    `INSERT INTO document_parents (document_id, tenant_key, organization_id, version, chunking_profile_id, content, token_count, parent_index)
     VALUES ($1, $2, $3, 2, 'legacy', $4, 4, 0)`,
    [v2, tenant.key, tenant.orgId, `${TEXT_MARK} parent`],
  );
  const source = nango ? 'nango' : 'config_upload';
  await db.query(
    `INSERT INTO ingestion_jobs (tenant_key, kind, status, source, source_key, lineage_id, document_id, version, filename, file_sha256)
     VALUES ($1, 'ingest', 'ready', $2, $3, $4, $5, 2, $6, $7)`,
    [tenant.key, source, sourceKey, lineageId, v2, `${FILE_NAME_MARK}.md`, hashes[1]],
  );
  await db.query(
    `INSERT INTO ingestion_jobs_archive (id, tenant_key, kind, source, source_key, lineage_id, document_id, version, file_sha256, status, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, 'ingest', $2, $3, $4, $5, 1, $6, 'ready', now(), now())`,
    [tenant.key, source, sourceKey, lineageId, v1, hashes[0]],
  );
  const parsePrefix = `${tenant.key}/_parse-cache/${hashes[1]}/docling-a-${hex(4)}/`;
  await db.query(
    "INSERT INTO rag_parse_cache (tenant_key, file_sha256, parser, parser_version, options_hash, object_prefix) VALUES ($1, $2, 'docling', '1', $3, $4)",
    [tenant.key, hashes[1], hex(), parsePrefix],
  );
  const cache = await rows(
    db,
    `INSERT INTO rag_semantic_cache (tenant_key, key_hash, embedding_profile_id, embedding, query_text_masked, answer, source_versions, is_refusal, expires_at)
     VALUES ($1, $2, 'p1', '[1,0,0,0]'::halfvec, 'masked placeholder', '{}'::jsonb, $3::jsonb, false, now() + interval '1 hour') RETURNING id`,
    [tenant.key, hex(), JSON.stringify([{ document_id: v2, version: 2 }])],
  );
  const answerRecordId = crypto.randomUUID();
  await db.query(
    "INSERT INTO rag_answer_records (id, user_id, organization_id, rag_mode, citations) VALUES ($1, $2, $3, 'strict', $4::jsonb)",
    [answerRecordId, tenant.userId, tenant.orgId, JSON.stringify([citation(1, v2, `${TEXT_MARK} quoted.`)])],
  );
  const chatId = crypto.randomUUID();
  const messages = [
    { id: 'm-user', role: 'user', content: 'A synthetic question.' },
    {
      id: 'm-assistant',
      role: 'assistant',
      content: [{ type: 'text', text: 'A synthetic answer [S1].' }],
      metadata: { citations: [citation(1, v2, `${TEXT_MARK} quoted.`)] },
    },
  ];
  if (world.mode === 'multi-tenant') {
    await db.query("INSERT INTO chats (id, user_id, organization_id, title, messages) VALUES ($1, $2, $3, 'Synthetic chat', $4::jsonb)", [
      chatId,
      tenant.userId,
      tenant.orgId,
      JSON.stringify(messages),
    ]);
  } else {
    await db.query("INSERT INTO chats (id, user_id, title, messages) VALUES ($1, $2, 'Synthetic chat', $3::jsonb)", [chatId, tenant.userId, JSON.stringify(messages)]);
  }
  if (nango) {
    await db.query(
      "INSERT INTO nango_sync_records (user_id, connection_id, provider, file_id, file_name, document_id, status) VALUES ($1, $2, 'google-drive', $3, $4, $5, 'completed')",
      [tenant.userId, nango.connectionId, nango.fileId, `${FILE_NAME_MARK}.md`, v2],
    );
  }
  return {
    lineageId,
    versionIds: [v1, v2],
    chunkIds,
    hashes,
    objectKeys,
    parsePrefix,
    sourceKey,
    fileId: nango?.fileId ?? null,
    connectionId: nango?.connectionId ?? null,
    answerRecordId,
    chatId,
    cacheId: String(cache[0]?.id),
  };
}

export interface PurgeResult {
  audit_id: string;
  counts: Record<string, number>;
  object_keys: string[];
  parse_cache_prefixes: string[];
  image_prefixes: string[];
}

export const adminActor = (id: string): string => JSON.stringify({ kind: 'admin', id });
export const syncActor = (id: string): string => JSON.stringify({ kind: 'source_sync', id });
export const reason = (code: string, note?: string): string => JSON.stringify(note === undefined ? { code } : { code, note });

export async function purge(db: PGlite, tenantKey: string, lineageId: string, actor: string, why: string = reason('added_in_error', 'A synthetic note.')): Promise<PurgeResult> {
  const result = await db.query<PurgeResult>('SELECT * FROM public.rag_purge_lineage($1, $2::uuid, $3::jsonb, $4::jsonb)', [tenantKey, lineageId, actor, why]);
  const row = result.rows[0];
  assert.ok(row, 'purge returns one row');
  return row;
}

export async function verify(db: PGlite, tenantKey: string, lineageId: string): Promise<Array<{ store: string; remaining: number; state: string | null }>> {
  const result = await db.query<{ store: string; remaining: number | string; state: string | null }>('SELECT * FROM public.rag_purge_verify($1, $2::uuid)', [
    tenantKey,
    lineageId,
  ]);
  return result.rows.map((row) => ({ store: row.store, remaining: Number(row.remaining), state: row.state }));
}

export async function errorOf(run: () => Promise<unknown>): Promise<{ message: string; code: string }> {
  try {
    await run();
  } catch (error) {
    return { message: (error as Error).message, code: sqlState(error) };
  }
  assert.fail('expected an error');
}
