import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { FIXTURE_USER_ID, createEmptyFixtureDatabase } from '../../eval/harness/pglite-supabase.mts';

/**
 * TPL-05 / TPL-08 (D-02, D-26, D-27, F-14, F-15): the tenant header template, the stored document header and stamp, the batched read,
 * the pending and stale listings and the chunk stamp trigger of migration 1006, in both deployment modes. Keys and values are synthetic.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATION = 'supabase/migrations/1006_attribute_header.sql';

const ORG_A = '00000000-0000-4000-8000-000000150301';
const ORG_B = '00000000-0000-4000-8000-000000150302';
const ADMIN_A = '00000000-0000-4000-8000-000000150311';
const ADMIN_B = '00000000-0000-4000-8000-000000150312';
const MEMBER_A = '00000000-0000-4000-8000-000000150313';
const KEY_A = `o:${ORG_A}`;
const KEY_B = `o:${ORG_B}`;
const SOURCE = 'config_upload';
const LEGACY_EMBED_PROFILE = 'openai-3-small-1536';

const FUNCTIONS = [
  'rag_attribute_header_template_get(uuid, text)',
  'rag_attribute_header_template_for(text)',
  'rag_attribute_header_template_set(uuid, text, text)',
  'rag_set_document_attribute_headers(text, jsonb)',
  'rag_attribute_headers(text, uuid[], uuid[])',
  'rag_attribute_header_pending(text, uuid, integer)',
  'rag_attribute_header_stale(text, text, uuid, integer)',
  'rag_chunk_attribute_header_stamp()',
];

const GET_SQL = 'SELECT * FROM rag_attribute_header_template_get(p_actor => $1, p_tenant_key => $2)';
const FOR_SQL = 'SELECT * FROM rag_attribute_header_template_for(p_tenant_key => $1)';
const SET_SQL = 'SELECT * FROM rag_attribute_header_template_set(p_actor => $1, p_tenant_key => $2, p_template => $3)';
const WRITE_SQL = 'SELECT * FROM rag_set_document_attribute_headers(p_tenant_key => $1, p_rows => $2::jsonb)';
const DOC_READ_SQL = 'SELECT * FROM rag_attribute_headers(p_tenant_key => $1, p_document_ids => $2::uuid[])';
const CHUNK_READ_SQL = 'SELECT * FROM rag_attribute_headers(p_tenant_key => $1, p_chunk_ids => $2::uuid[])';
const BOTH_READ_SQL = 'SELECT * FROM rag_attribute_headers(p_tenant_key => $1, p_document_ids => $2::uuid[], p_chunk_ids => $3::uuid[])';
const NONE_READ_SQL = 'SELECT * FROM rag_attribute_headers(p_tenant_key => $1)';
const PENDING_SQL = 'SELECT * FROM rag_attribute_header_pending(p_tenant_key => $1, p_after => $2::uuid, p_limit => $3)';
const STALE_SQL = 'SELECT * FROM rag_attribute_header_stale(p_tenant_key => $1, p_profile_id => $2, p_after => $3::uuid, p_limit => $4)';

type Row = Record<string, unknown>;

interface Tenant {
  key: string;
  userId: string | null;
  orgId: string | null;
  admin: string;
}

let sequence = 0;
const next = (label: string): string => `${label}-${++sequence}`;
const hex12 = (seed: string): string => crypto.createHash('sha256').update(seed).digest('hex').slice(0, 12);
const stampOf = (version: number, seed: string): string => `t${version}.${hex12(seed)}`;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function rows(db: PGlite, sql: string, params: unknown[] = []): Promise<Row[]> {
  try {
    return (await db.query<Row>(sql, params)).rows;
  } catch (error) {
    return assert.fail(`${sql.slice(0, 80).replace(/\s+/g, ' ')} failed: ${messageOf(error)}`);
  }
}

async function failure(db: PGlite, sql: string, params: unknown[] = []): Promise<{ message: string; code: string | null } | null> {
  try {
    await db.query(sql, params);
    return null;
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return { message: messageOf(error), code: typeof code === 'string' ? code : null };
  }
}

async function refusal(db: PGlite, sql: string, params: unknown[], word: string): Promise<void> {
  const failed = await failure(db, sql, params);
  assert.ok(failed !== null, `expected ${word}`);
  assert.match(failed.message, new RegExp(`^${word}`), `expected ${word}, got a different refusal`);
}

async function malformed(db: PGlite, sql: string, params: unknown[]): Promise<void> {
  const failed = await failure(db, sql, params);
  assert.ok(failed !== null, 'expected a refusal');
  assert.equal(failed.code, '22023');
}

async function asRole<T>(db: PGlite, role: 'anon' | 'authenticated', run: () => Promise<T>): Promise<T> {
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [FIXTURE_USER_ID]);
  await db.exec(`SET ROLE ${role}`);
  try {
    return await run();
  } finally {
    await db.exec('RESET ROLE');
  }
}

async function defineKeys(db: PGlite, tenantKey: string, extra: string | null = null): Promise<void> {
  await rows(
    db,
    `INSERT INTO public.rag_attribute_definitions (tenant_key, key, type, in_header) VALUES ($1, 'alpha_code', 'code', true),
       ($1, 'beta_list', 'text_list', true), ($1, 'gamma_text', 'text', false) ON CONFLICT (tenant_key, key) DO NOTHING`,
    [tenantKey],
  );
  if (extra) {
    await rows(db, `INSERT INTO public.rag_attribute_definitions (tenant_key, key, type, in_header) VALUES ($1, $2, 'text', true) ON CONFLICT DO NOTHING`, [
      tenantKey,
      extra,
    ]);
  }
}

async function beginVersion(db: PGlite, tenant: Tenant, sourceKey: string): Promise<string> {
  const begun = (
    await rows(
      db,
      `SELECT outcome, document_id FROM rag_begin_document_version($1, $2::uuid, $3::uuid, $4, $5, $6, $7, 'general', 'fallback', 'general-1', 1)`,
      [tenant.key, tenant.userId, tenant.orgId, SOURCE, sourceKey, `${sourceKey}.md`, crypto.createHash('sha256').update(next('sha')).digest('hex')],
    )
  )[0];
  assert.equal(begun?.outcome, 'created');
  return String(begun?.document_id);
}

async function writeChunks(db: PGlite, tenant: Tenant, id: string, metadata: Array<Record<string, unknown>>): Promise<void> {
  const chunks = metadata.map((meta, index) => {
    const content = `${next('tok')} neutral probe sentence ${index}`;
    return { chunk_index: index, content, lexical_text: content, metadata: meta };
  });
  const vector = (seed: number) => Array.from({ length: 1536 }, (_, index) => (index === seed % 1536 ? 1 : 0));
  await rows(
    db,
    'SELECT * FROM rag_write_chunks(p_document_id => $1, p_tenant_key => $2, p_chunks => $3::jsonb, p_embeddings => $4::jsonb, p_final => true, p_total => $5)',
    [id, tenant.key, JSON.stringify(chunks), JSON.stringify({ [LEGACY_EMBED_PROFILE]: chunks.map((_, index) => vector(index + 1)) }), chunks.length],
  );
}

async function publishedDocument(db: PGlite, tenant: Tenant, metadata: Array<Record<string, unknown>> = [{}, {}]): Promise<string> {
  const id = await beginVersion(db, tenant, next('doc'));
  await writeChunks(db, tenant, id, metadata);
  await rows(db, 'SELECT * FROM rag_publish_document_version(p_document_id => $1, p_tenant_key => $2)', [id, tenant.key]);
  return id;
}

async function chunkIds(db: PGlite, documentId: string): Promise<string[]> {
  return (await rows(db, 'SELECT id FROM document_chunks WHERE document_id = $1 ORDER BY chunk_index', [documentId])).map((row) => String(row.id));
}

async function chunkStamps(db: PGlite, documentId: string): Promise<unknown[]> {
  return (await rows(db, 'SELECT attribute_header_stamp AS s FROM document_chunks WHERE document_id = $1 ORDER BY chunk_index', [documentId])).map((row) => row.s);
}

async function documentHeader(db: PGlite, id: string): Promise<{ header: unknown; stamp: unknown }> {
  const row = (await rows(db, 'SELECT attribute_header AS header, attribute_header_stamp AS stamp FROM documents WHERE id = $1', [id]))[0];
  return { header: row?.header ?? null, stamp: row?.stamp ?? null };
}

async function writeHeaders(db: PGlite, tenantKey: string, items: Array<{ document_id: string; header: string | null; stamp: string | null }>): Promise<Row> {
  return (await rows(db, WRITE_SQL, [tenantKey, JSON.stringify(items)]))[0] as Row;
}

async function templateRows(db: PGlite): Promise<number> {
  return Number((await rows(db, 'SELECT count(*)::int AS n FROM public.rag_attribute_header_templates'))[0]?.n);
}

async function nonNullHeaderColumns(db: PGlite): Promise<number> {
  const found = await rows(
    db,
    `SELECT (SELECT count(*) FROM documents WHERE attribute_header IS NOT NULL OR attribute_header_stamp IS NOT NULL)
          + (SELECT count(*) FROM document_chunks WHERE attribute_header_stamp IS NOT NULL) AS n`,
  );
  return Number(found[0]?.n);
}

async function setupDatabase(mode: 'multi-tenant' | 'single-tenant'): Promise<{ db: PGlite; a: Tenant; b: Tenant | null }> {
  const db = (await createEmptyFixtureDatabase({ deploymentMode: mode })).db;
  if (mode === 'single-tenant') {
    await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4)', [ADMIN_A, 'admin@example.invalid', MEMBER_A, 'user@example.invalid']);
    await db.query('INSERT INTO admin_users (id) VALUES ($1)', [ADMIN_A]);
    await defineKeys(db, 's:default');
    return { db, a: { key: 's:default', userId: null, orgId: null, admin: ADMIN_A }, b: null };
  }
  await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4), ($5, $6)', [
    ADMIN_A,
    'header-a@example.invalid',
    ADMIN_B,
    'header-b@example.invalid',
    MEMBER_A,
    'header-m@example.invalid',
  ]);
  await db.query('INSERT INTO organizations (id, name, slug, owner_id, is_personal) VALUES ($1, $2, $3, $4, false), ($5, $6, $7, $8, false)', [
    ORG_A,
    'Tenant A',
    'tenant-a-1006',
    ADMIN_A,
    ORG_B,
    'Tenant B',
    'tenant-b-1006',
    ADMIN_B,
  ]);
  await db.query(
    "INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'owner'), ($3, $4, 'owner'), ($1, $5, 'member') ON CONFLICT DO NOTHING",
    [ORG_A, ADMIN_A, ORG_B, ADMIN_B, MEMBER_A],
  );
  await defineKeys(db, KEY_A);
  await defineKeys(db, KEY_B, 'delta_only');
  return {
    db,
    a: { key: KEY_A, userId: ADMIN_A, orgId: ORG_A, admin: ADMIN_A },
    b: { key: KEY_B, userId: ADMIN_B, orgId: ORG_B, admin: ADMIN_B },
  };
}

const TEMPLATE = 'A {alpha_code} | B {beta_list}';

for (const mode of ['multi-tenant', 'single-tenant'] as const) {
  describe(`attribute header (${mode})`, () => {
    let db: PGlite;
    let a: Tenant;
    let b: Tenant | null;

    before(async () => {
      ({ db, a, b } = await setupDatabase(mode));
    });

    after(async () => {
      await db?.close();
    });

    test('off state: no template row and every header and stamp column NULL before any call', async () => {
      await publishedDocument(db, a);
      assert.equal(await templateRows(db), 0);
      assert.equal(await nonNullHeaderColumns(db), 0);
      assert.deepEqual(await rows(db, FOR_SQL, [a.key]), []);
      assert.deepEqual(await rows(db, GET_SQL, [a.admin, a.key]), []);
    });

    test('save, change, keep, remove and save again: versions never reuse a stamped version', async () => {
      const first = await rows(db, SET_SQL, [a.admin, a.key, TEMPLATE]);
      assert.deepEqual(first.map((row) => [row.template, row.version]), [[TEMPLATE, 1]]);
      assert.deepEqual((await rows(db, GET_SQL, [a.admin, a.key])).map((row) => [row.template, row.version]), [[TEMPLATE, 1]]);
      assert.deepEqual((await rows(db, FOR_SQL, [a.key])).map((row) => [row.template, row.version]), [[TEMPLATE, 1]]);
      assert.deepEqual(await rows(db, GET_SQL, [MEMBER_A, a.key]), []);
      const changed = await rows(db, SET_SQL, [a.admin, a.key, '{alpha_code}']);
      assert.equal(changed[0]?.version, 2);
      const same = await rows(db, SET_SQL, [a.admin, a.key, '{alpha_code}']);
      assert.equal(same[0]?.version, 2);
      const doc = await publishedDocument(db, a);
      await writeHeaders(db, a.key, [{ document_id: doc, header: 'A x', stamp: stampOf(5, 'old') }]);
      assert.deepEqual(await rows(db, SET_SQL, [a.admin, a.key, null]), []);
      assert.deepEqual(await rows(db, FOR_SQL, [a.key]), []);
      const again = await rows(db, SET_SQL, [a.admin, a.key, TEMPLATE]);
      assert.equal(again[0]?.version, 6, 'one above the highest version found in a stamp');
      if (b) assert.deepEqual(await rows(db, FOR_SQL, [b.key]), [], 'the other tenant has no template');
    });

    test('limits, unknown placeholders and the actor check refuse and store nothing', async () => {
      const before = await rows(db, FOR_SQL, [a.key]);
      await malformed(db, SET_SQL, [a.admin, a.key, 'x'.repeat(201)]);
      await malformed(db, SET_SQL, [a.admin, a.key, '']);
      await refusal(db, SET_SQL, [a.admin, a.key, '{gamma_text}'], 'unknown_placeholder');
      await refusal(db, SET_SQL, [a.admin, a.key, '{missing_key}'], 'unknown_placeholder');
      await refusal(db, SET_SQL, [a.admin, a.key, '{Bad Name}'], 'unknown_placeholder');
      await refusal(db, SET_SQL, [a.admin, a.key, '{}'], 'unknown_placeholder');
      if (b) await refusal(db, SET_SQL, [a.admin, a.key, '{delta_only}'], 'unknown_placeholder');
      await refusal(db, SET_SQL, [MEMBER_A, a.key, '{alpha_code}'], 'not_admin');
      if (b) await refusal(db, SET_SQL, [b.admin, a.key, '{alpha_code}'], 'not_admin');
      assert.deepEqual(await rows(db, FOR_SQL, [a.key]), before);
      if (b) {
        const own = await rows(db, SET_SQL, [b.admin, b.key, '{delta_only}']);
        assert.equal(own[0]?.version, 1);
        assert.deepEqual(await rows(db, GET_SQL, [a.admin, b.key]), [], "an admin of A reads nothing of B's template");
      }
    });

    test('stored header write: own tenant only, equal values unchanged, limits, no cache removal', async () => {
      const doc = await publishedDocument(db, a);
      const stamp = stampOf(6, 'w1');
      const first = await writeHeaders(db, a.key, [{ document_id: doc, header: 'A one', stamp }]);
      assert.deepEqual([first.updated, first.unchanged], [1, 0]);
      const second = await writeHeaders(db, a.key, [{ document_id: doc, header: 'A one', stamp }]);
      assert.deepEqual([second.updated, second.unchanged], [0, 1]);
      assert.deepEqual(await documentHeader(db, doc), { header: 'A one', stamp });
      const cacheKey = crypto.createHash('sha256').update(next('cache')).digest('hex');
      await rows(
        db,
        `INSERT INTO public.rag_semantic_cache (tenant_key, key_hash, embedding_profile_id, embedding, query_text_masked, answer, source_versions, is_refusal, expires_at)
         VALUES ($1, $2, 'p1', '[1,0,0,0]'::halfvec, 'masked placeholder', '{}'::jsonb, $3::jsonb, false, now() + interval '1 hour')`,
        [a.key, cacheKey, JSON.stringify([{ document_id: doc, version: 1 }])],
      );
      await writeHeaders(db, a.key, [{ document_id: doc, header: 'A two', stamp: stampOf(6, 'w2') }]);
      assert.equal(Number((await rows(db, 'SELECT count(*)::int AS n FROM rag_semantic_cache WHERE key_hash = $1', [cacheKey]))[0]?.n), 1);
      if (b) {
        const foreign = await writeHeaders(db, b.key, [{ document_id: doc, header: 'B forged', stamp: stampOf(1, 'f') }]);
        assert.equal(foreign.updated, 0);
        assert.equal((await documentHeader(db, doc)).header, 'A two');
      }
      const many = Array.from({ length: 501 }, () => ({ document_id: doc, header: 'x', stamp }));
      await malformed(db, WRITE_SQL, [a.key, JSON.stringify(many)]);
      await malformed(db, WRITE_SQL, [a.key, JSON.stringify([{ document_id: doc, header: 'x'.repeat(1001), stamp }])]);
      await malformed(db, WRITE_SQL, [a.key, JSON.stringify([{ document_id: doc, header: 'x', stamp: 'not-a-stamp' }])]);
      await malformed(db, WRITE_SQL, [a.key, JSON.stringify([{ document_id: doc, header: 'x', stamp: null }])]);
      const cleared = await writeHeaders(db, a.key, [{ document_id: doc, header: null, stamp: null }]);
      assert.equal(cleared.updated, 1);
      assert.deepEqual(await documentHeader(db, doc), { header: null, stamp: null });
    });

    test('batched read: one id list required; document mode returns stamped documents, chunk mode only chunks whose stamp matches', async () => {
      const current = stampOf(7, 'r1');
      const doc = await publishedDocument(db, a, [{ attribute_header_stamp: current }, { attribute_header_stamp: stampOf(6, 'r0') }, {}]);
      const unstamped = await publishedDocument(db, a);
      await writeHeaders(db, a.key, [{ document_id: doc, header: 'A read', stamp: current }]);
      const docs = await rows(db, DOC_READ_SQL, [a.key, [doc, unstamped]]);
      assert.deepEqual(docs.map((row) => [row.document_id, row.header, row.stamp]), [[doc, 'A read', current]]);
      const ids = await chunkIds(db, doc);
      const chunks = await rows(db, CHUNK_READ_SQL, [a.key, ids]);
      assert.deepEqual(chunks.map((row) => [row.chunk_id, row.header]), [[ids[0], 'A read']]);
      if (b) {
        assert.deepEqual(await rows(db, DOC_READ_SQL, [b.key, [doc]]), [], 'foreign document id');
        assert.deepEqual(await rows(db, CHUNK_READ_SQL, [b.key, ids]), [], 'foreign chunk ids');
      }
      await malformed(db, NONE_READ_SQL, [a.key]);
      await malformed(db, BOTH_READ_SQL, [a.key, [doc], ids]);
      const tooMany = Array.from({ length: 1001 }, () => crypto.randomUUID());
      await malformed(db, DOC_READ_SQL, [a.key, tooMany]);
      await malformed(db, CHUNK_READ_SQL, [a.key, tooMany]);
    });

    test("pending listing: the tenant's documents not stamped with the current version, in id order, with attributes", async () => {
      const version = Number((await rows(db, FOR_SQL, [a.key]))[0]?.version);
      assert.ok(version >= 1);
      const all = await rows(db, PENDING_SQL, [a.key, null, 500]);
      const ids = all.map((row) => String(row.document_id));
      assert.deepEqual(ids, [...ids].sort());
      const docCount = Number((await rows(db, "SELECT count(*)::int AS n FROM documents WHERE tenant_key = $1 AND status <> 'deleted'", [a.key]))[0]?.n);
      assert.equal(ids.length, docCount, 'nothing is stamped with the current version yet');
      assert.ok(all.every((row) => 'attributes' in row));
      const first = ids[0] as string;
      await writeHeaders(db, a.key, [{ document_id: first, header: 'A p', stamp: stampOf(version, 'p') }]);
      const rest = await rows(db, PENDING_SQL, [a.key, null, 500]);
      assert.ok(!rest.some((row) => row.document_id === first));
      const paged = await rows(db, PENDING_SQL, [a.key, rest[0]?.document_id, 1]);
      assert.equal(paged.length, 1);
      assert.equal(paged[0]?.document_id, rest[1]?.document_id);
      if (b) assert.ok(!(await rows(db, PENDING_SQL, [b.key, null, 500])).some((row) => ids.includes(String(row.document_id))));
    });

    test('stale listing names documents serving a chunk whose stamp differs from the document stamp', async () => {
      const stamp = stampOf(9, 's1');
      const fresh = await publishedDocument(db, a, [{ attribute_header_stamp: stamp }, { attribute_header_stamp: stamp }]);
      const stale = await publishedDocument(db, a, [{ attribute_header_stamp: stamp }, {}]);
      await writeHeaders(db, a.key, [
        { document_id: fresh, header: 'A s', stamp },
        { document_id: stale, header: 'A s', stamp },
      ]);
      const listed = await rows(db, STALE_SQL, [a.key, null, null, 500]);
      const byId = new Map(listed.map((row) => [String(row.document_id), row]));
      assert.ok(!byId.has(fresh));
      assert.deepEqual([byId.get(stale)?.doc_type, byId.get(stale)?.stamp, byId.get(stale)?.stale_chunks], ['general', stamp, 1]);
      const named = await rows(db, STALE_SQL, [a.key, 'legacy', null, 500]);
      assert.ok(named.some((row) => row.document_id === stale));
      assert.deepEqual(await rows(db, STALE_SQL, [a.key, 'no-such-profile', null, 500]), []);
      if (b) assert.ok(!(await rows(db, STALE_SQL, [b.key, null, null, 500])).some((row) => row.document_id === stale));
    });

    test('chunk stamp trigger: well-formed key sets, none clears, absent key keeps, malformed ignored; authenticated cannot set it', async () => {
      const doc = await publishedDocument(db, a, [{ attribute_header_stamp: stampOf(3, 'c') }, { attribute_header_stamp: 'garbage' }]);
      assert.deepEqual(await chunkStamps(db, doc), [stampOf(3, 'c'), null]);
      const [first] = await chunkIds(db, doc);
      await rows(db, `UPDATE document_chunks SET metadata = metadata || '{"other_key": 1}'::jsonb WHERE id = $1`, [first]);
      assert.equal((await chunkStamps(db, doc))[0], stampOf(3, 'c'));
      await rows(db, `UPDATE document_chunks SET metadata = metadata || '{"attribute_header_stamp": "t3.zz"}'::jsonb WHERE id = $1`, [first]);
      assert.equal((await chunkStamps(db, doc))[0], stampOf(3, 'c'));
      await rows(db, `UPDATE document_chunks SET metadata = metadata || '{"attribute_header_stamp": 5}'::jsonb WHERE id = $1`, [first]);
      assert.equal((await chunkStamps(db, doc))[0], stampOf(3, 'c'));
      await rows(db, `UPDATE document_chunks SET metadata = metadata || jsonb_build_object('attribute_header_stamp', $2::text) WHERE id = $1`, [
        first,
        stampOf(4, 'c'),
      ]);
      assert.equal((await chunkStamps(db, doc))[0], stampOf(4, 'c'));
      await rows(db, `UPDATE document_chunks SET metadata = metadata || '{"attribute_header_stamp": "none"}'::jsonb WHERE id = $1`, [first]);
      assert.equal((await chunkStamps(db, doc))[0], null);
      await rows(db, 'UPDATE document_chunks SET attribute_header_stamp = $2 WHERE id = $1', [first, stampOf(8, 'c')]);
      const forged = stampOf(2, 'forged');
      const attempt = await asRole(db, 'authenticated', () =>
        failure(db, `UPDATE document_chunks SET metadata = metadata || jsonb_build_object('attribute_header_stamp', $2::text) WHERE id = $1`, [first, forged]),
      );
      assert.ok(attempt === null || attempt.code === '42501', `refused or no row changed: ${attempt?.code}`);
      assert.equal((await chunkStamps(db, doc))[0], stampOf(8, 'c'));
    });

    test('anon and authenticated cannot execute any 1006 function', async () => {
      for (const role of ['anon', 'authenticated'] as const) {
        await asRole(db, role, async () => {
          assert.ok((await failure(db, FOR_SQL, [a.key])) !== null, `${role} for`);
          assert.ok((await failure(db, GET_SQL, [a.admin, a.key])) !== null, `${role} get`);
          assert.ok((await failure(db, SET_SQL, [a.admin, a.key, '{alpha_code}'])) !== null, `${role} set`);
          assert.ok((await failure(db, WRITE_SQL, [a.key, '[]'])) !== null, `${role} write`);
          assert.ok((await failure(db, DOC_READ_SQL, [a.key, [crypto.randomUUID()]])) !== null, `${role} read`);
          assert.ok((await failure(db, PENDING_SQL, [a.key, null, 10])) !== null, `${role} pending`);
          assert.ok((await failure(db, STALE_SQL, [a.key, null, null, 10])) !== null, `${role} stale`);
        });
      }
    });

    test('a tenant key of the other deployment mode raises', async () => {
      const bad = mode === 'single-tenant' ? [`u:${MEMBER_A}`, `o:${ORG_A}`] : ['s:default'];
      for (const key of bad) {
        assert.ok((await failure(db, FOR_SQL, [key])) !== null, `for ${key}`);
        assert.ok((await failure(db, SET_SQL, [a.admin, key, '{alpha_code}'])) !== null, `set ${key}`);
        assert.ok((await failure(db, WRITE_SQL, [key, '[]'])) !== null, `write ${key}`);
        assert.ok((await failure(db, DOC_READ_SQL, [key, [crypto.randomUUID()]])) !== null, `read ${key}`);
        assert.ok((await failure(db, PENDING_SQL, [key, null, 10])) !== null, `pending ${key}`);
        assert.ok((await failure(db, STALE_SQL, [key, null, null, 10])) !== null, `stale ${key}`);
      }
    });
  });
}

describe('migration 1006 catalog and idempotence', () => {
  for (const mode of ['multi-tenant', 'single-tenant'] as const) {
    test(`${mode}: INVOKER, empty search_path, service_role only, trigger order, and applying 1006 again leaves the schema unchanged`, async () => {
      const db = (await createEmptyFixtureDatabase({ deploymentMode: mode })).db;
      try {
        for (const signature of FUNCTIONS) {
          const found = (
            await rows(
              db,
              `SELECT p.prosecdef AS definer, p.proconfig AS config,
                      has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
                      has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
                      has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role,
                      EXISTS (SELECT 1 FROM aclexplode(p.proacl) x WHERE x.grantee = 0 AND x.privilege_type = 'EXECUTE') AS public
               FROM pg_proc p WHERE p.oid = to_regprocedure($1)`,
              [`public.${signature}`],
            )
          )[0];
          assert.ok(found, `${signature} exists`);
          assert.equal(found.definer, false, `${signature} is INVOKER`);
          assert.ok((found.config as string[]).some((entry) => /^search_path=("")?$/.test(entry)), `${signature} search_path`);
          assert.deepEqual([found.anon, found.authenticated, found.public, found.service_role], [false, false, false, true], signature);
        }
        const triggers = await rows(
          db,
          `SELECT t.tgname FROM pg_trigger t WHERE t.tgrelid = 'public.document_chunks'::regclass
             AND t.tgname IN ('rag_chunk_attribute_header_stamp', 'rag_guard_phase33_columns') ORDER BY t.tgname COLLATE "C"`,
        );
        assert.deepEqual(triggers.map((row) => row.tgname), ['rag_chunk_attribute_header_stamp', 'rag_guard_phase33_columns']);
        const dump = async () =>
          JSON.stringify(
            await rows(
              db,
              `SELECT p.oid::regprocedure::text AS sig, pg_get_functiondef(p.oid) AS def, p.proacl::text AS acl FROM pg_proc p
               WHERE p.pronamespace = 'public'::regnamespace AND (p.proname LIKE 'rag_%attribute_header%') ORDER BY 1`,
            ),
          );
        const first = await dump();
        assert.notEqual(first, '[]');
        await db.exec(fs.readFileSync(path.join(REPO_ROOT, MIGRATION), 'utf8'));
        assert.equal(await dump(), first);
        assert.equal(await templateRows(db), 0);
      } finally {
        await db.close();
      }
    });
  }
});
