import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase, createFixtureDatabase, type DeploymentMode, type FixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { applyMigrationFiles, migrationFiles } from '../../eval/harness/migrations.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

async function lexicalCatalogSignature(db: PGlite): Promise<string[]> {
  const result = await db.query<Record<string, unknown>>(
    `SELECT 'fn:' || p.oid::regprocedure::text AS line
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname IN ('rag_lexical_tsvector', 'rag_lexical_tsquery', 'rag_chunks_lexical_tsv', 'rag_relex_candidates', 'rag_relex_batch')
     UNION ALL
     SELECT 'idx:' || indexrelid::regclass::text
     FROM pg_index WHERE indrelid = 'public.document_chunks'::regclass AND indexrelid::regclass::text LIKE '%lexical%'
     ORDER BY 1`,
  );
  return result.rows.map((row) => String(row.line));
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REAL_CORPUS = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const M0401 = 'supabase/migrations/0401_lexical_index.sql';
const M0402 = 'supabase/migrations/0402_relex_batch.sql';

type Row = Record<string, unknown>;
type Role = 'anon' | 'authenticated' | 'service_role';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function relfileNodes(db: PGlite): Promise<{ table: number; hnsw: number | null }> {
  const table = await db.query<{ relfilenode: number }>(
    `SELECT c.relfilenode::int AS relfilenode FROM pg_class c WHERE c.oid = 'public.document_chunks'::regclass`,
  );
  const idx = await db.query<{ relfilenode: number }>(
    `SELECT i.relfilenode::int AS relfilenode FROM pg_class t
     JOIN pg_index x ON x.indrelid = t.oid
     JOIN pg_class i ON i.oid = x.indexrelid
     WHERE t.relname = 'document_chunks' AND i.relname = 'idx_document_chunks_embedding'`,
  );
  return { table: Number(table.rows[0]?.relfilenode), hnsw: idx.rows[0]?.relfilenode ?? null };
}

async function asRole<T>(db: PGlite, role: Role, run: () => Promise<T>): Promise<T> {
  await db.exec(`SET ROLE ${role}`);
  try {
    return await run();
  } finally {
    await db.exec('RESET ROLE');
  }
}

async function expectDenied(db: PGlite, role: Role, sql: string, params: unknown[] = []): Promise<void> {
  await assert.rejects(
    () => asRole(db, role, () => db.query(sql, params)),
    (error: unknown) => {
      const message = messageOf(error);
      const code = typeof (error as { code?: string }).code === 'string' ? (error as { code: string }).code : '';
      return code === '42501' || message.includes('permission denied');
    },
  );
}

function vector(dims = 1536): string {
  return `[${Array.from({ length: dims }, (_, index) => (index === 0 ? 1 : 0)).join(',')}]`;
}

let sequence = 0;

async function seedChunk(
  db: PGlite,
  mode: DeploymentMode,
  fixtureUserId: string,
  lexicalText: string,
  metadata: Record<string, unknown> = {},
  language: string | null = 'en',
): Promise<string> {
  const docId = crypto.randomUUID();
  const chunkId = crypto.randomUUID();
  const sourceKey = `lexical-${++sequence}.md`;
  if (mode === 'multi-tenant') {
    await db.query(
      'INSERT INTO documents (id, filename, content, user_id, source_key, lineage_id, is_current, status) VALUES ($1, $2, $3, $4, $5, $1, true, $6)',
      [docId, sourceKey, 'fixture body', fixtureUserId, sourceKey, 'ready'],
    );
    await db.query(
      `INSERT INTO document_chunks (id, document_id, content, embedding, lexical_text, metadata, language, is_current, status, chunk_index)
       VALUES ($1, $2, $3, $4::vector, $5, $6::jsonb, $7, true, 'ready', 0)`,
      [chunkId, docId, 'fixture body', vector(), lexicalText, JSON.stringify(metadata), language],
    );
  } else {
    await db.query(
      'INSERT INTO documents (id, filename, content, source_key, lineage_id, is_current, status) VALUES ($1, $2, $3, $4, $1, true, $5)',
      [docId, sourceKey, 'fixture body', sourceKey, 'ready'],
    );
    await db.query(
      `INSERT INTO document_chunks (id, document_id, content, embedding, lexical_text, metadata, language, is_current, status, chunk_index)
       VALUES ($1, $2, $3, $4::vector, $5, $6::jsonb, $7, true, 'ready', 0)`,
      [chunkId, docId, 'fixture body', vector(), lexicalText, JSON.stringify(metadata), language],
    );
  }
  return chunkId;
}

for (const mode of MODES) {
  describe(`lexical index (0401, ${mode})`, () => {
    let fixture: FixtureDatabase;

    before(async () => {
      fixture = await createFixtureDatabase({ deploymentMode: mode, corpusDir: REAL_CORPUS });
    });

    after(async () => {
      await fixture.db.close();
    });

    async function query<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
      return (await fixture.db.query<T>(sql, params)).rows;
    }

    test('adding lexical columns does not rewrite document_chunks or its HNSW index', async () => {
      const base = await createEmptyFixtureDatabase({ deploymentMode: mode, migrations: false });
      try {
        const pre = migrationFiles(mode).filter((file) => !file.includes('0401_') && !file.includes('0402_'));
        await applyMigrationFiles(base.db, pre);
        const before = await relfileNodes(base.db);
        await applyMigrationFiles(base.db, [M0401]);
        const after = await relfileNodes(base.db);
        assert.equal(after.table, before.table);
        assert.equal(after.hnsw, before.hnsw);
      } finally {
        await base.db.close();
      }
    });

    test('rag_lexical_tsvector keeps hyphenated tokens whole and tsquery finds them', async () => {
      const rows = await query<{ tsv: string; matches: boolean }>(
        `SELECT rag_lexical_tsvector($1)::text AS tsv,
                rag_lexical_tsvector($1) @@ rag_lexical_tsquery(ARRAY['xr-2000']) AS matches`,
        ['型号 xr-2000 xr2000 设备'],
      );
      assert.equal(rows[0]?.tsv, `'xr-2000':2 'xr2000':3 '型号':1 '设备':4`);
      assert.equal(rows[0]?.matches, true);
      const rank = await query<{ score: number }>(
        `SELECT ts_rank_cd(rag_lexical_tsvector($1), rag_lexical_tsquery(ARRAY['xr-2000']), 1) AS score`,
        ['型号 xr-2000 xr2000 设备'],
      );
      assert.ok(Number(rank[0]?.score) > 0);
    });

    test('rag_lexical_tsquery rejects hostile tokens, caps at 64 terms, and empty input is null', async () => {
      const hostile = await query<{ q: string | null }>(
        `SELECT rag_lexical_tsquery(ARRAY['a''b', 'x & y', ':*', '!', 'drop table', 'canary'])::text AS q`,
      );
      assert.ok(hostile[0]?.q?.includes('canary'));
      const empty = await query<{ q: string | null }>(`SELECT rag_lexical_tsquery('{}'::text[])::text AS q`);
      assert.equal(empty[0]?.q, null);
      const tokens = Array.from({ length: 70 }, (_, index) => `tok${index}`);
      const capped = await query<{ q: string }>(`SELECT rag_lexical_tsquery($1::text[])::text AS q`, [tokens]);
      const termCount = String(capped[0]?.q ?? '').split(' | ').length;
      assert.equal(termCount, 64);
      const chunkId = await seedChunk(fixture.db, mode, fixture.fixtureUserId, 'alpha beta canary delta');
      const hit = await query<{ found: boolean }>(`SELECT lexical_tsv @@ rag_lexical_tsquery(ARRAY['canary']) AS found FROM document_chunks WHERE id = $1`, [
        chunkId,
      ]);
      assert.equal(hit[0]?.found, true);
    });

    test('a 300-byte token is skipped instead of raising word is too long', async () => {
      const longTok = 'x'.repeat(300);
      const rows = await query<{ tsv: string }>(`SELECT rag_lexical_tsvector($1)::text AS tsv`, [`short ${longTok} tail`]);
      assert.equal(rows[0]?.tsv, `'short':1 'tail':3`);
      const q = await query<{ built: string | null }>(`SELECT rag_lexical_tsquery(ARRAY[$1, 'tail'])::text AS built`, [longTok]);
      assert.equal(q[0]?.built, `'tail'`);
    });

    test('the trigger mirrors metadata.lexical_version and respects metadata-only updates', async () => {
      const chunkId = await seedChunk(fixture.db, mode, fixture.fixtureUserId, 'policy refund', { lexical_version: 2 });
      const inserted = await query<{ lexical_version: number | null; tsv: string | null }>(
        `SELECT lexical_version, lexical_tsv::text AS tsv FROM document_chunks WHERE id = $1`,
        [chunkId],
      );
      assert.equal(inserted[0]?.lexical_version, 2);
      assert.ok(inserted[0]?.tsv?.includes('policy'));
      const tsvBefore = inserted[0]?.tsv;
      await fixture.db.query(`UPDATE document_chunks SET metadata = metadata || '{"note":"touch"}'::jsonb WHERE id = $1`, [chunkId]);
      const metaOnly = await query<{ tsv: string | null }>(`SELECT lexical_tsv::text AS tsv FROM document_chunks WHERE id = $1`, [chunkId]);
      assert.equal(metaOnly[0]?.tsv, tsvBefore);
      await fixture.db.query(`UPDATE document_chunks SET lexical_text = 'policy refund updated', metadata = '{"note":"touch"}'::jsonb WHERE id = $1`, [
        chunkId,
      ]);
      const stale = await query<{ lexical_version: number | null }>(`SELECT lexical_version FROM document_chunks WHERE id = $1`, [chunkId]);
      assert.equal(stale[0]?.lexical_version, null);
    });

    test('applying 0401 twice leaves the same catalog', async () => {
      const empty = await createEmptyFixtureDatabase({ deploymentMode: mode, migrations: false });
      try {
        const pre = migrationFiles(mode).filter((file) => !file.includes('0401_') && !file.includes('0402_'));
        await applyMigrationFiles(empty.db, pre);
        await applyMigrationFiles(empty.db, [M0401]);
        const once = await lexicalCatalogSignature(empty.db);
        await applyMigrationFiles(empty.db, [M0401]);
        const twice = await lexicalCatalogSignature(empty.db);
        assert.deepEqual(twice, once);
      } finally {
        await empty.db.close();
      }
    });

    test('rag_chunks_lexical_tsv is not executable by anon or authenticated', async () => {
      const priv = await query<{ anon: boolean; auth: boolean }>(
        `SELECT has_function_privilege('anon', 'rag_chunks_lexical_tsv()', 'EXECUTE') AS anon,
                has_function_privilege('authenticated', 'rag_chunks_lexical_tsv()', 'EXECUTE') AS auth`,
      );
      assert.equal(priv[0]?.anon, false);
      assert.equal(priv[0]?.auth, false);
    });
  });
}

describe('relex batch functions (0402, multi-tenant)', () => {
  let fixture: TwoTenantDatabase;
  const A = { key: `u:${TWO_TENANT_IDS.userA}`, userId: TWO_TENANT_IDS.userA };
  const B = { key: `u:${TWO_TENANT_IDS.userB}`, userId: TWO_TENANT_IDS.userB };

  before(async () => {
    fixture = await createTwoTenantDatabase();
  });

  after(async () => {
    await fixture.db.close();
  });

  async function query<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await fixture.db.query<T>(sql, params)).rows;
  }

  async function writeChunk(tenant: { key: string; userId: string }, label: string, lexicalVersion: number | null, lexicalText: string | null): Promise<string> {
    const docId = crypto.randomUUID();
    const chunkId = crypto.randomUUID();
    const sourceKey = `relex-${++sequence}.md`;
    await fixture.db.query(
      'INSERT INTO documents (id, filename, content, user_id, source_key, lineage_id, is_current, status) VALUES ($1, $2, $3, $4, $5, $1, true, $6)',
      [docId, sourceKey, `${label} content`, tenant.userId, sourceKey, 'ready'],
    );
    await fixture.db.query(
      `INSERT INTO document_chunks (id, document_id, content, embedding, lexical_text, lexical_version, metadata, language, is_current, status, chunk_index)
       VALUES ($1, $2, $3, $4::vector, $5, $6, $7::jsonb, NULL, true, 'ready', 0)`,
      [
        chunkId,
        docId,
        `${label} content`,
        vector(),
        lexicalText,
        lexicalVersion,
        lexicalVersion === null ? '{}' : JSON.stringify({ lexical_version: lexicalVersion }),
      ],
    );
    return chunkId;
  }

  test('rag_relex_candidates pages stale chunks in id order with optional tenant filter', async () => {
    const staleA = await writeChunk(A, 'stale-a', 1, 'one');
    const staleB = await writeChunk(B, 'stale-b', null, null);
    const fresh = await writeChunk(A, 'fresh', 2, 'two');
    const page = await query<{ id: string; document_filename: string }>(
      `SELECT id, document_filename FROM rag_relex_candidates(NULL, 2, 100, NULL) ORDER BY id`,
    );
    const ids = page.map((row) => String(row.id));
    assert.ok(ids.includes(staleA));
    assert.ok(ids.includes(staleB));
    assert.ok(!ids.includes(fresh));
    assert.ok(page.every((row) => typeof row.document_filename === 'string' && row.document_filename.length > 0));
    const tenantOnly = await query<{ id: string }>(`SELECT id FROM rag_relex_candidates(NULL, 2, 100, $1)`, [A.key]);
    const tenantIds = tenantOnly.map((row) => String(row.id));
    assert.ok(tenantIds.includes(staleA));
    assert.ok(!tenantIds.includes(staleB));
    const after = await query<{ id: string }>(`SELECT id FROM rag_relex_candidates($1, 2, 100, NULL)`, [staleA]);
    assert.ok(after.every((row) => String(row.id) > staleA));
  });

  test('rag_relex_batch rewrites lexical fields, fills language when null, and is idempotent', async () => {
    const chunkId = await writeChunk(A, 'batch', 1, 'old text');
    const batch = [{ id: chunkId, lexical_text: 'relex alpha beta', language: 'it' }];
    const first = await query<{ rag_relex_batch: number }>(`SELECT rag_relex_batch($1::jsonb, 2) AS rag_relex_batch`, [JSON.stringify(batch)]);
    assert.equal(Number(first[0]?.rag_relex_batch), 1);
    const row = await query<{ lexical_version: number; language: string | null; tsv: string | null }>(
      `SELECT lexical_version, language, lexical_tsv::text AS tsv FROM document_chunks WHERE id = $1`,
      [chunkId],
    );
    assert.equal(row[0]?.lexical_version, 2);
    assert.equal(row[0]?.language, 'it');
    assert.ok(row[0]?.tsv?.includes('relex'));
    const second = await query<{ rag_relex_batch: number }>(`SELECT rag_relex_batch($1::jsonb, 2) AS rag_relex_batch`, [JSON.stringify(batch)]);
    assert.equal(Number(second[0]?.rag_relex_batch), 1);
    const unknown = await query<{ rag_relex_batch: number }>(
      `SELECT rag_relex_batch($1::jsonb, 2) AS rag_relex_batch`,
      [JSON.stringify([{ id: crypto.randomUUID(), lexical_text: 'ghost' }])],
    );
    assert.equal(Number(unknown[0]?.rag_relex_batch), 0);
  });

  test('rag_relex functions are service_role only', async () => {
    const fns = await query<{ signature: string; anon: boolean; auth: boolean; service: boolean }>(
      `SELECT p.oid::regprocedure::text AS signature,
              has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
              has_function_privilege('service_role', p.oid, 'EXECUTE') AS service
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname IN ('rag_relex_candidates', 'rag_relex_batch')`,
    );
    assert.equal(fns.length, 2);
    for (const row of fns) {
      assert.equal(row.anon, false);
      assert.equal(row.auth, false);
      assert.equal(row.service, true);
    }
    await expectDenied(fixture.db, 'anon', 'SELECT rag_relex_candidates(NULL, 2, 10, NULL)');
    await expectDenied(fixture.db, 'authenticated', 'SELECT rag_relex_batch($1::jsonb, 2)', ['[]']);
  });

  test('applying 0402 twice leaves the same catalog', async () => {
    const sql = fs.readFileSync(path.join(REPO_ROOT, M0402), 'utf8');
    const empty = await createEmptyFixtureDatabase({ deploymentMode: 'multi-tenant', migrations: false });
    try {
      const pre = migrationFiles('multi-tenant').filter((file) => !file.includes('0402_'));
      await applyMigrationFiles(empty.db, pre);
      await empty.db.exec(sql);
      const once = await lexicalCatalogSignature(empty.db);
      await empty.db.exec(sql);
      const twice = await lexicalCatalogSignature(empty.db);
      assert.deepEqual(twice, once);
    } finally {
      await empty.db.close();
    }
  });
});