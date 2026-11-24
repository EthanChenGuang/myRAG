import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createTwoTenantDatabase, TWO_TENANT_IDS, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';
import type { PGlite } from '@electric-sql/pglite';

const TENANT_USER_A = `u:${TWO_TENANT_IDS.userA}`;
const TENANT_ORG_B = `o:${TWO_TENANT_IDS.orgO}`;
const FILE_SHA =
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OPTIONS_HASH =
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const PARSER = 'docling';
const PARSER_VERSION = 'llamaparse-v2/cost_effective@latest';
const VERSION_SEGMENT = crypto.createHash('sha256').update(PARSER_VERSION, 'utf8').digest('hex').slice(0, 16);

const CACHE_RPCS = [
  'rag_parse_cache_prefix',
  'rag_parse_cache_lookup',
  'rag_parse_cache_put',
  'rag_set_document_parse_cache',
  'rag_parse_cache_for_document',
] as const;

type Role = 'anon' | 'authenticated' | 'service_role';

type CacheRow = {
  id: string;
  tenant_key: string;
  file_sha256: string;
  parser: string;
  parser_version: string;
  options_hash: string;
  object_prefix: string;
};

async function tryQuery(db: PGlite, sql: string, params: unknown[] = []): Promise<{ message: string; code: string | null } | null> {
  try {
    await db.query(sql, params);
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = typeof (error as { code?: string }).code === 'string' ? (error as { code: string }).code : null;
    return { message, code };
  }
}

function expectSqlState(err: { message: string; code: string | null } | null, state: string): void {
  assert.ok(err, `expected SQLSTATE ${state}`);
  assert.ok(err.code === state || err.message.includes(state), `expected ${state}, got code=${err.code} message=${err.message}`);
}

async function asRole<T>(db: PGlite, role: Role, run: () => Promise<T>): Promise<T> {
  await db.exec(`SET ROLE ${role}`);
  try {
    return await run();
  } finally {
    await db.exec('RESET ROLE');
  }
}

function cachePrefix(tenantKey: string): string {
  return `${tenantKey}/_parse-cache/${FILE_SHA}/${PARSER}-${VERSION_SEGMENT}-${OPTIONS_HASH}/`;
}

async function enqueueJob(
  db: PGlite,
  tenantKey: string,
  sourceKey: string,
  documentId: string | null = null,
): Promise<string> {
  const row = (
    await db.query<{ id: string }>(
      `SELECT id FROM rag_enqueue_ingestion_job(
        $1, 'ingest', 'config_upload', $2, $3, NULL, NULL, NULL, '{}'::jsonb, 100, $4, NULL, 'queued'
      )`,
      [tenantKey, sourceKey, FILE_SHA, documentId],
    )
  ).rows[0];
  assert.ok(row?.id);
  return row.id;
}

async function requireRpc(db: PGlite, signature: string): Promise<void> {
  const found = await db.query<{ found: boolean }>('SELECT to_regprocedure($1) IS NOT NULL AS found', [signature]);
  assert.equal(found.rows[0]?.found, true, `${signature} is missing`);
}

describe('parse cache RPCs (two-tenant, DATA-14)', () => {
  let fixture: TwoTenantDatabase;
  let db: PGlite;

  before(async () => {
    fixture = await createTwoTenantDatabase();
    db = fixture.db;
  });

  after(async () => {
    await db.close();
  });

  test('migrations define the parse cache RPCs', async () => {
    await requireRpc(db, 'rag_parse_cache_prefix(uuid,text,text,text)');
    await requireRpc(db, 'rag_parse_cache_lookup(uuid,text,text,text)');
    await requireRpc(
      db,
      'rag_parse_cache_put(uuid,text,text,text,text,jsonb,bigint)',
    );
    await requireRpc(db, 'rag_set_document_parse_cache(uuid,uuid)');
    await requireRpc(db, 'rag_parse_cache_for_document(text,uuid)');
  });

  test('prefix uses tenant, file hash and hashed parser version without raw slashes', async () => {
    const jobA = await enqueueJob(db, TENANT_USER_A, `parse-cache/a-${crypto.randomUUID()}`);
    const prefix = (
      await db.query<{ rag_parse_cache_prefix: string }>(
        'SELECT rag_parse_cache_prefix($1, $2, $3, $4) AS rag_parse_cache_prefix',
        [jobA, PARSER, PARSER_VERSION, OPTIONS_HASH],
      )
    ).rows[0]?.rag_parse_cache_prefix;
    assert.equal(prefix, cachePrefix(TENANT_USER_A));
    assert.ok(!prefix!.includes(PARSER_VERSION), 'raw parser_version must not appear in the path');
    assert.ok(prefix!.includes(VERSION_SEGMENT));
  });

  test('put then lookup is tenant-scoped; cross-tenant misses; duplicate put returns the first row', async () => {
    const jobA = await enqueueJob(db, TENANT_USER_A, `parse-cache/put-a-${crypto.randomUUID()}`);
    const jobB = await enqueueJob(db, TENANT_ORG_B, `parse-cache/put-b-${crypto.randomUUID()}`);
    const prefix = cachePrefix(TENANT_USER_A);
    const first = (
      await db.query<CacheRow>(
        `SELECT * FROM rag_parse_cache_put($1, $2, $3, $4, $5, $6::jsonb, NULL)`,
        [jobA, PARSER, PARSER_VERSION, OPTIONS_HASH, prefix, JSON.stringify({ pages: 3 })],
      )
    ).rows[0];
    assert.ok(first?.id);
    const hit = (
      await db.query<CacheRow>('SELECT * FROM rag_parse_cache_lookup($1, $2, $3, $4)', [
        jobA,
        PARSER,
        PARSER_VERSION,
        OPTIONS_HASH,
      ])
    ).rows;
    assert.equal(hit.length, 1);
    assert.equal(hit[0]?.id, first.id);
    const miss = await db.query<CacheRow>('SELECT * FROM rag_parse_cache_lookup($1, $2, $3, $4)', [
      jobB,
      PARSER,
      PARSER_VERSION,
      OPTIONS_HASH,
    ]);
    assert.equal(miss.rows.length, 0);
    const again = (
      await db.query<CacheRow>(
        `SELECT * FROM rag_parse_cache_put($1, $2, $3, $4, $5, '{"other":true}'::jsonb, NULL)`,
        [jobA, PARSER, PARSER_VERSION, OPTIONS_HASH, prefix],
      )
    ).rows[0];
    assert.equal(again?.id, first.id);
    const count = Number(
      (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM rag_parse_cache')).rows[0]?.n,
    );
    assert.equal(count, 1);
  });

  test('put refuses a foreign prefix and invalid parser or options_hash', async () => {
    const jobA = await enqueueJob(db, TENANT_USER_A, `parse-cache/refuse-${crypto.randomUUID()}`);
    const foreign = cachePrefix(TENANT_ORG_B);
    expectSqlState(
      await tryQuery(db, `SELECT rag_parse_cache_put($1, $2, $3, $4, $5, '{}'::jsonb, NULL)`, [
        jobA,
        PARSER,
        PARSER_VERSION,
        OPTIONS_HASH,
        foreign,
      ]),
      '22023',
    );
    expectSqlState(
      await tryQuery(db, `SELECT rag_parse_cache_put($1, 'Bad-Parser', $2, $3, $4, '{}'::jsonb, NULL)`, [
        jobA,
        PARSER_VERSION,
        OPTIONS_HASH,
        cachePrefix(TENANT_USER_A),
      ]),
      '22023',
    );
    expectSqlState(
      await tryQuery(db, `SELECT rag_parse_cache_put($1, $2, $3, 'NOT_HEX', $4, '{}'::jsonb, NULL)`, [
        jobA,
        PARSER,
        PARSER_VERSION,
        cachePrefix(TENANT_USER_A),
      ]),
      '22023',
    );
  });

  test('lookup for a missing job id returns no row', async () => {
    const missing = crypto.randomUUID();
    const rows = await db.query<CacheRow>('SELECT * FROM rag_parse_cache_lookup($1, $2, $3, $4)', [
      missing,
      PARSER,
      PARSER_VERSION,
      OPTIONS_HASH,
    ]);
    assert.equal(rows.rows.length, 0);
  });

  test('rag_set_document_parse_cache and rag_parse_cache_for_document stay tenant-local', async () => {
    const jobA = await enqueueJob(db, TENANT_USER_A, `parse-cache/doc-a-${crypto.randomUUID()}`, TWO_TENANT_IDS.docA);
    const prefix = cachePrefix(TENANT_USER_A);
    const entry = (
      await db.query<CacheRow>(
        `SELECT * FROM rag_parse_cache_put($1, $2, $3, $4, $5, '{"doc":true}'::jsonb, NULL)`,
        [jobA, PARSER, PARSER_VERSION, OPTIONS_HASH, prefix],
      )
    ).rows[0];
    assert.ok(entry?.id);
    await db.query('SELECT rag_set_document_parse_cache($1, $2)', [jobA, entry.id]);
    const parseCacheId = (
      await db.query<{ parse_cache_id: string | null }>('SELECT parse_cache_id FROM documents WHERE id = $1', [
        TWO_TENANT_IDS.docA,
      ])
    ).rows[0]?.parse_cache_id;
    assert.equal(parseCacheId, entry.id);
    const read = await db.query<CacheRow>('SELECT * FROM rag_parse_cache_for_document($1, $2)', [
      TENANT_USER_A,
      TWO_TENANT_IDS.docA,
    ]);
    assert.equal(read.rows.length, 1);
    assert.equal(read.rows[0]?.id, entry.id);
    const cross = await db.query<CacheRow>('SELECT * FROM rag_parse_cache_for_document($1, $2)', [
      TENANT_ORG_B,
      TWO_TENANT_IDS.docA,
    ]);
    assert.equal(cross.rows.length, 0);
    const jobB = await enqueueJob(db, TENANT_ORG_B, `parse-cache/doc-b-${crypto.randomUUID()}`, TWO_TENANT_IDS.docO);
    const other = (
      await db.query<CacheRow>(
        `SELECT * FROM rag_parse_cache_put($1, $2, $3, $4, $5, '{}'::jsonb, NULL)`,
        [jobB, PARSER, PARSER_VERSION, OPTIONS_HASH, cachePrefix(TENANT_ORG_B)],
      )
    ).rows[0];
    assert.ok(other?.id);
    expectSqlState(await tryQuery(db, 'SELECT rag_set_document_parse_cache($1, $2)', [jobA, other.id]), '22023');
  });

  test('anon and authenticated get 42501 on every parse cache RPC', async () => {
    const jobA = await enqueueJob(db, TENANT_USER_A, `parse-cache/roles-${crypto.randomUUID()}`);
    const prefix = cachePrefix(TENANT_USER_A);
    const entryId = crypto.randomUUID();
    for (const fn of CACHE_RPCS) {
      for (const role of ['anon', 'authenticated'] as const) {
        await asRole(db, role, async () => {
          let err: { message: string; code: string | null } | null = null;
          if (fn === 'rag_parse_cache_prefix') {
            err = await tryQuery(db, `SELECT ${fn}($1, $2, $3, $4)`, [jobA, PARSER, PARSER_VERSION, OPTIONS_HASH]);
          } else if (fn === 'rag_parse_cache_lookup') {
            err = await tryQuery(db, `SELECT * FROM ${fn}($1, $2, $3, $4)`, [jobA, PARSER, PARSER_VERSION, OPTIONS_HASH]);
          } else if (fn === 'rag_parse_cache_put') {
            err = await tryQuery(db, `SELECT * FROM ${fn}($1, $2, $3, $4, $5, '{}'::jsonb, NULL)`, [
              jobA,
              PARSER,
              PARSER_VERSION,
              OPTIONS_HASH,
              prefix,
            ]);
          } else if (fn === 'rag_set_document_parse_cache') {
            err = await tryQuery(db, `SELECT ${fn}($1, $2)`, [jobA, entryId]);
          } else {
            err = await tryQuery(db, `SELECT * FROM ${fn}($1, $2)`, [TENANT_USER_A, TWO_TENANT_IDS.docA]);
          }
          expectSqlState(err, '42501');
        });
      }
    }
  });
});