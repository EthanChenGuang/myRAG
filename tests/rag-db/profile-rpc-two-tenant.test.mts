import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { PGlite } from '@electric-sql/pglite';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

const LEGACY = 'openai-3-small-1536';
const TEST_PROFILE = 'test-1536';
const SMALL_PROFILE = 'test-8';
const RPC_SIGNATURE = 'match_chunks_by_profile(text,text,integer,halfvec,integer,double precision,boolean)';

function literal(values: number[]): string {
  return `[${values.join(',')}]`;
}

function chunkId(n: number): string {
  return `00000000-0000-4000-8000-${String(900000 + n).padStart(12, '0')}`;
}

async function tryQuery(db: PGlite, sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await db.query(sql, params);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function requireRpc(db: PGlite): Promise<void> {
  const found = await db.query<{ found: boolean }>("SELECT to_regprocedure($1) IS NOT NULL AS found", [RPC_SIGNATURE]);
  assert.equal(found.rows[0]?.found, true, 'match_chunks_by_profile is missing');
}

interface Tenant {
  key: string;
  orgId: string | null;
  userId: string;
}

describe('match_chunks_by_profile on the two-tenant fixture', () => {
  let fixture: TwoTenantDatabase;
  let db: PGlite;
  let tenants: Tenant[];

  before(async () => {
    fixture = await createTwoTenantDatabase();
    db = fixture.db;
    tenants = [
      { key: `u:${TWO_TENANT_IDS.userA}`, orgId: null, userId: TWO_TENANT_IDS.userA },
      { key: `u:${TWO_TENANT_IDS.userB}`, orgId: null, userId: TWO_TENANT_IDS.userB },
      { key: `o:${TWO_TENANT_IDS.orgO}`, orgId: TWO_TENANT_IDS.orgO, userId: TWO_TENANT_IDS.userA },
      { key: `u:${fixture.fixtureUserId}`, orgId: null, userId: fixture.fixtureUserId },
    ];
    await db.query("UPDATE embedding_profiles SET status = 'available' WHERE id = $1", [LEGACY]);
    await db.query(
      `INSERT INTO embedding_profiles (id, provider, model, dims, storage, status)
       VALUES ($1, 'openai', 'test-model', 1536, 'halfvec', 'active')`,
      [TEST_PROFILE],
    );
    await db.query(
      `INSERT INTO chunk_embeddings (chunk_id, profile_id, tenant_key, embedding, embedding_model, dims)
       SELECT id, $1, tenant_key, embedding::halfvec(1536), 'test-model', 1536 FROM document_chunks WHERE embedding IS NOT NULL`,
      [TEST_PROFILE],
    );
  });

  after(async () => {
    await db.close();
  });

  async function legacyDocuments(tenant: Tenant, query: number[], count: number): Promise<string[]> {
    const result = await db.query<{ document_id: string }>(
      'SELECT document_id FROM match_documents_by_workspace($1::vector, $2, -1, $3::uuid, $4::uuid)',
      [literal(query), count, tenant.orgId, tenant.userId],
    );
    return result.rows.map((row) => row.document_id);
  }

  async function profileDocuments(tenantKey: string, query: number[], count: number, profile = TEST_PROFILE): Promise<string[]> {
    const result = await db.query<{ document_id: string }>(
      'SELECT document_id FROM match_chunks_by_profile($1, $2, 1536, $3::halfvec, $4, -1::float8)',
      [tenantKey, profile, literal(query), count],
    );
    return result.rows.map((row) => row.document_id);
  }

  test('returns, per tenant key, the same documents match_documents_by_workspace returns for the matching scope', async () => {
    await requireRpc(db);
    const queries = [
      embedText('Two tenant isolation canary phrase: alpha personal notes'),
      embedText('Two tenant isolation canary phrase: bravo personal notes'),
      embedText('Two tenant isolation canary phrase: organization shared handbook'),
      embedText('quarterly revenue and refund policy'),
    ];
    for (const tenant of tenants) {
      for (const query of queries) {
        const expected = await legacyDocuments(tenant, query, 1000);
        const actual = await profileDocuments(tenant.key, query, 1000);
        assert.deepEqual([...new Set(actual)].sort(), [...new Set(expected)].sort(), `tenant ${tenant.key}`);
        assert.equal(actual.length, expected.length, `tenant ${tenant.key} chunk count`);
      }
    }
    const own = async (tenant: Tenant): Promise<string[]> =>
      [...new Set(await profileDocuments(tenant.key, queries[0] as number[], 1000))].sort();
    assert.deepEqual(await own(tenants[0] as Tenant), [TWO_TENANT_IDS.docA]);
    assert.deepEqual(await own(tenants[1] as Tenant), [TWO_TENANT_IDS.docB]);
    assert.deepEqual(await own(tenants[2] as Tenant), [TWO_TENANT_IDS.docO]);
    assert.ok((await own(tenants[3] as Tenant)).length > 3, 'the corpus tenant should hold the corpus documents');
  });

  test('does not return non-current or quarantined chunks, nor a vector stored under another tenant key', async () => {
    await requireRpc(db);
    const query = embedText('Two tenant isolation canary phrase: alpha personal notes');
    const quarantined = chunkId(1);
    const superseded = chunkId(2);
    for (const [id, status, current, index] of [
      [quarantined, 'quarantined', true, 11],
      [superseded, 'ready', false, 12],
    ] as const) {
      await db.query(
        'INSERT INTO document_chunks (id, document_id, content, chunk_index, metadata, status, is_current) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)',
        [id, TWO_TENANT_IDS.docA, `hidden chunk ${index}`, index, '{}', status, current],
      );
      await db.query(
        `INSERT INTO chunk_embeddings (chunk_id, profile_id, tenant_key, embedding, embedding_model, dims)
         SELECT c.id, $2, c.tenant_key, $3::halfvec, 'test-model', 1536 FROM document_chunks c WHERE c.id = $1`,
        [id, TEST_PROFILE, literal(query)],
      );
    }
    const count = async (tenantKey: string): Promise<{ ids: string[]; docs: string[] }> => {
      const result = await db.query<{ id: string; document_id: string }>(
        'SELECT id, document_id FROM match_chunks_by_profile($1, $2, 1536, $3::halfvec, 1000, -1::float8)',
        [tenantKey, TEST_PROFILE, literal(query)],
      );
      return { ids: result.rows.map((row) => row.id), docs: result.rows.map((row) => row.document_id) };
    };
    const tenantA = `u:${TWO_TENANT_IDS.userA}`;
    const hidden = await count(tenantA);
    assert.ok(!hidden.ids.includes(quarantined), 'quarantined chunk must be hidden');
    assert.ok(!hidden.ids.includes(superseded), 'non-current chunk must be hidden');

    await db.query("UPDATE document_chunks SET status = 'ready' WHERE id = $1", [quarantined]);
    await db.query('UPDATE document_chunks SET is_current = true WHERE id = $1', [superseded]);
    const visible = await count(tenantA);
    assert.ok(visible.ids.includes(quarantined) && visible.ids.includes(superseded), 'control: both chunks appear once ready and current');

    const other = await count(`u:${TWO_TENANT_IDS.userB}`);
    assert.ok(!other.ids.includes(quarantined) && !other.ids.includes(superseded), 'another tenant must not see them');
    assert.ok(!other.docs.includes(TWO_TENANT_IDS.docA));
    const injected = await count("x' OR true --");
    assert.deepEqual(injected.ids, []);
    await db.query('DELETE FROM document_chunks WHERE id = ANY($1)', [[quarantined, superseded]]);
  });

  test('raises embedding_profile_mismatch for unknown profiles, dims mismatches and inactive profiles', async () => {
    await requireRpc(db);
    const query1536 = literal(embedText('anything'));
    const query1024 = literal(Array.from({ length: 1024 }, () => 0.1));
    const call = (profile: string, dims: number, vector: string, requireActive?: boolean): Promise<string | null> =>
      requireActive === undefined
        ? tryQuery(db, 'SELECT * FROM match_chunks_by_profile($1, $2, $3, $4::halfvec, 5, 0::float8)', ['u:x', profile, dims, vector])
        : tryQuery(db, 'SELECT * FROM match_chunks_by_profile($1, $2, $3, $4::halfvec, 5, 0::float8, $5)', ['u:x', profile, dims, vector, requireActive]);

    assert.match((await call(TEST_PROFILE, 1024, query1024)) ?? 'accepted', /embedding_profile_mismatch/);
    assert.match((await call(TEST_PROFILE, 1536, query1024)) ?? 'accepted', /embedding_profile_mismatch/);
    assert.match((await call('no-such-profile', 1536, query1536)) ?? 'accepted', /embedding_profile_mismatch/);
    assert.match((await call("x'; DROP TABLE chunk_embeddings; --", 1536, query1536)) ?? 'accepted', /embedding_profile_mismatch/);
    assert.match((await call('voyage-4-large-1024', 1024, query1024)) ?? 'accepted', /embedding_profile_mismatch/);
    assert.match((await call('voyage-4-large-1024', 1024, query1024, true)) ?? 'accepted', /embedding_profile_mismatch/);
    assert.equal(await call('voyage-4-large-1024', 1024, query1024, false), null);
    assert.equal(await call(TEST_PROFILE, 1536, query1536, true), null);
    assert.equal((await db.query("SELECT to_regclass('public.chunk_embeddings') AS t")).rows[0] !== undefined, true);
  });

  test('fills the requested count for a small tenant behind a large one (iterative scan)', async () => {
    await requireRpc(db);
    await db.query(
      `INSERT INTO embedding_profiles (id, provider, model, dims, storage, status) VALUES ($1, 'openai', 'test-model', 8, 'halfvec', 'available')`,
      [SMALL_PROFILE],
    );
    await db.query(
      `CREATE INDEX test_8_hnsw ON chunk_embeddings USING hnsw ((embedding::halfvec(8)) halfvec_cosine_ops) WHERE profile_id = '${SMALL_PROFILE}'`,
    );
    await db.query(
      `INSERT INTO document_chunks (id, document_id, content, chunk_index, metadata)
       SELECT gen_random_uuid(), CASE WHEN g <= 20 THEN $1::uuid ELSE $2::uuid END, 'bulk ' || g, 100 + g, '{}'::jsonb FROM generate_series(1, 400) g`,
      [TWO_TENANT_IDS.docA, TWO_TENANT_IDS.docB],
    );
    await db.query(
      `INSERT INTO chunk_embeddings (chunk_id, profile_id, tenant_key, embedding, embedding_model, dims)
       SELECT c.id, $1, c.tenant_key,
              (CASE WHEN c.document_id = $2::uuid
                 THEN '[' || (0.5 + (random() - 0.5) * 0.3) || ',' || (0.9 + (random() - 0.5) * 0.3) || ','
                      || array_to_string(ARRAY(SELECT ((random() - 0.5) * 0.4)::numeric(6,4) FROM generate_series(1, 6)), ',') || ']'
                 ELSE '[' || (1 + (random() - 0.5) * 0.2) || ','
                      || array_to_string(ARRAY(SELECT ((random() - 0.5) * 0.3)::numeric(6,4) FROM generate_series(1, 7)), ',') || ']' END)::halfvec,
              'test-model', 8
       FROM document_chunks c WHERE c.content LIKE 'bulk %'`,
      [SMALL_PROFILE, TWO_TENANT_IDS.docA],
    );
    await db.exec('BEGIN');
    try {
      await db.exec('DROP INDEX chunk_embeddings_profile_tenant_idx; SET LOCAL enable_seqscan = off; SET LOCAL enable_bitmapscan = off');
      const tenantA = `u:${TWO_TENANT_IDS.userA}`;
      const query = '[1,0,0,0,0,0,0,0]';
      await db.exec('SET LOCAL hnsw.iterative_scan = off');
      const control = await db.query(
        `SELECT e.chunk_id FROM chunk_embeddings e WHERE e.profile_id = $1 AND e.tenant_key = $2
         ORDER BY (e.embedding::halfvec(8)) <=> $3::halfvec(8) LIMIT 15`,
        [SMALL_PROFILE, tenantA, query],
      );
      await db.exec('RESET hnsw.iterative_scan');
      assert.ok(control.rows.length < 15, `control must under-fill without iterative scan, returned ${control.rows.length}`);

      const result = await db.query(
        'SELECT * FROM match_chunks_by_profile($1, $2, 8, $3::halfvec, 15, -1::float8, false)',
        [tenantA, SMALL_PROFILE, query],
      );
      assert.equal(result.rows.length, 15);
    } finally {
      await db.exec('ROLLBACK');
    }
  });

  test('uses dynamic SQL built from the registry and is callable by service_role only', async () => {
    await requireRpc(db);
    const privileges = await db.query<{ anon: boolean; authenticated: boolean; service: boolean }>(
      `SELECT has_function_privilege('anon', $1, 'EXECUTE') AS anon,
              has_function_privilege('authenticated', $1, 'EXECUTE') AS authenticated,
              has_function_privilege('service_role', $1, 'EXECUTE') AS service`,
      [RPC_SIGNATURE],
    );
    assert.deepEqual(privileges.rows[0], { anon: false, authenticated: false, service: true });
    const definition = await db.query<{ src: string }>('SELECT prosrc AS src FROM pg_proc WHERE oid = to_regprocedure($1)', [RPC_SIGNATURE]);
    const source = definition.rows[0]?.src ?? '';
    assert.match(source, /format\(/);
    assert.match(source, /%2\$L/);
    assert.match(source, /iterative_scan/);
    assert.match(source, /e\.tenant_key = \$2/);
    assert.match(source, /c\.is_current AND c\.status = 'ready'/);
  });
});
