import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { applyMigrations } from '../../eval/harness/migrations.mts';
import { FIXTURE_USER_ID, createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';

const USER_A = '00000000-0000-4000-8000-0000000006a2';
const USER_B = '00000000-0000-4000-8000-0000000006b2';

const KEY_HASH = 'a'.repeat(64);
const OTHER_KEY_HASH = 'b'.repeat(64);
const ANSWER = { text: 'placeholder answer', citations: [] };
const STALE = (error: unknown): boolean => /cache_sources_not_current/.test(String((error as Error).message));

type Role = 'anon' | 'authenticated' | 'service_role';

interface CheckRow {
  hit: boolean;
  entry_id: string | null;
  distance: number | null;
  answer: unknown;
  is_refusal: boolean | null;
}

interface SourceVersion {
  document_id: string;
  version: number;
}

function codeOf(error: unknown): string {
  return typeof (error as { code?: string }).code === 'string' ? (error as { code: string }).code : '';
}

async function asRole<T>(db: PGlite, role: Role, run: () => Promise<T>): Promise<T> {
  await db.exec(`SET ROLE ${role}`);
  try {
    return await run();
  } finally {
    await db.exec('RESET ROLE');
  }
}

function vec(values: number[]): string {
  return `[${values.join(',')}]`;
}

const BASE = vec([1, 0, 0, 0]);
const NEAR = vec([0.99, Math.sqrt(1 - 0.99 * 0.99), 0, 0]);
const FAR = vec([0.8, 0.6, 0, 0]);

interface DocSpec {
  userId?: string;
  status?: string;
  isCurrent?: boolean;
  version?: number;
  filename?: string;
}

async function insertDoc(db: PGlite, mode: DeploymentMode, spec: DocSpec = {}): Promise<string> {
  const id = crypto.randomUUID();
  const filename = spec.filename ?? `doc-${id}.md`;
  if (mode === 'multi-tenant') {
    await db.query(
      `INSERT INTO documents (id, filename, content, metadata, user_id, lineage_id, source_key, status, is_current, version)
       VALUES ($1, $2, 'placeholder', '{}'::jsonb, $3, $1, $4, $5, $6, $7)`,
      [id, filename, spec.userId ?? FIXTURE_USER_ID, `legacy:${id}`, spec.status ?? 'ready', spec.isCurrent ?? true, spec.version ?? 1],
    );
  } else {
    await db.query(
      `INSERT INTO documents (id, filename, content, metadata, lineage_id, source_key, status, is_current, version)
       VALUES ($1, $2, 'placeholder', '{}'::jsonb, $1, $3, $4, $5, $6)`,
      [id, filename, `legacy:${id}`, spec.status ?? 'ready', spec.isCurrent ?? true, spec.version ?? 1],
    );
  }
  return id;
}

interface StoreArgs {
  tenantKey: string | null;
  keyHash?: string;
  profile?: string;
  embedding?: string;
  answer?: unknown;
  sources?: SourceVersion[] | unknown;
  isRefusal?: boolean;
  ttl?: number;
}

async function store(db: PGlite, args: StoreArgs): Promise<string> {
  const result = await asRole(db, 'service_role', () =>
    db.query<{ id: string }>(
      'SELECT public.rag_cache_store($1, $2, $3, $4::halfvec, $5, $6::jsonb, $7::jsonb, $8, $9) AS id',
      [
        args.tenantKey,
        args.keyHash ?? KEY_HASH,
        args.profile ?? 'p1',
        args.embedding ?? BASE,
        'masked query placeholder',
        JSON.stringify(args.answer ?? ANSWER),
        JSON.stringify(args.sources ?? []),
        args.isRefusal ?? false,
        args.ttl ?? 3600,
      ],
    ),
  );
  return result.rows[0]!.id;
}

interface CheckArgs {
  tenantKey: string | null;
  keyHash?: string;
  profile?: string;
  embedding?: string;
  maxDistance?: number;
}

async function check(db: PGlite, args: CheckArgs): Promise<CheckRow> {
  const result = await asRole(db, 'service_role', () =>
    db.query<CheckRow>('SELECT * FROM public.rag_cache_check($1, $2, $3, $4::halfvec, $5)', [
      args.tenantKey,
      args.keyHash ?? KEY_HASH,
      args.profile ?? 'p1',
      args.embedding ?? BASE,
      args.maxDistance ?? 0.05,
    ]),
  );
  assert.equal(result.rows.length, 1);
  const row = result.rows[0]!;
  return { ...row, distance: row.distance === null ? null : Number(row.distance) };
}

async function insertRaw(
  db: PGlite,
  tenantKey: string,
  options: { embedding?: string; profile?: string; expiresAt?: string; keyHash?: string; sources?: SourceVersion[] },
): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO public.rag_semantic_cache (tenant_key, key_hash, embedding_profile_id, embedding, query_text_masked, answer, source_versions, is_refusal, expires_at)
     VALUES ($1, $2, $3, $4::halfvec, 'masked query placeholder', $5::jsonb, $6::jsonb, false, $7::timestamptz) RETURNING id`,
    [
      tenantKey,
      options.keyHash ?? KEY_HASH,
      options.profile ?? 'p1',
      options.embedding ?? BASE,
      JSON.stringify(ANSWER),
      JSON.stringify(options.sources ?? []),
      options.expiresAt ?? new Date(Date.now() + 3_600_000).toISOString(),
    ],
  );
  return result.rows[0]!.id;
}

async function countRows(db: PGlite, where = 'true', params: unknown[] = []): Promise<number> {
  const result = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.rag_semantic_cache WHERE ${where}`, params);
  return result.rows[0]!.n;
}

interface FunctionCase {
  name: string;
  signature: string;
  call: (tenantKey: string | null) => [string, unknown[]];
}

const FUNCTIONS: FunctionCase[] = [
  {
    name: 'rag_cache_check',
    signature: 'public.rag_cache_check(text, text, text, public.halfvec, double precision)',
    call: (key) => ['SELECT * FROM public.rag_cache_check($1, $2, $3, $4::halfvec, $5)', [key, KEY_HASH, 'p1', BASE, 0.05]],
  },
  {
    name: 'rag_cache_store',
    signature: 'public.rag_cache_store(text, text, text, public.halfvec, text, jsonb, jsonb, boolean, integer)',
    call: (key) => [
      'SELECT public.rag_cache_store($1, $2, $3, $4::halfvec, $5, $6::jsonb, $7::jsonb, $8, $9)',
      [key, KEY_HASH, 'p1', BASE, 'masked', JSON.stringify(ANSWER), '[]', false, 60],
    ],
  },
  {
    name: 'rag_cache_invalidate',
    signature: 'public.rag_cache_invalidate(text, uuid[])',
    call: (key) => ['SELECT public.rag_cache_invalidate($1, $2::uuid[])', [key, null]],
  },
  {
    name: 'rag_cache_sources_current',
    signature: 'public.rag_cache_sources_current(text, jsonb)',
    call: (key) => ['SELECT public.rag_cache_sources_current($1, $2::jsonb)', [key, '[]']],
  },
  {
    name: 'rag_cache_resolve_sources',
    signature: 'public.rag_cache_resolve_sources(text, uuid[])',
    call: (key) => ['SELECT * FROM public.rag_cache_resolve_sources($1, $2::uuid[])', [key, [crypto.randomUUID()]]],
  },
];

async function invalidate(db: PGlite, tenantKey: string, documentIds: string[] | null = null): Promise<number> {
  const result = await asRole(db, 'service_role', () =>
    db.query<{ n: number }>('SELECT public.rag_cache_invalidate($1, $2::uuid[]) AS n', [tenantKey, documentIds]),
  );
  return result.rows[0]!.n;
}

async function sourcesCurrent(db: PGlite, tenantKey: string, sources: SourceVersion[]): Promise<boolean> {
  const result = await asRole(db, 'service_role', () =>
    db.query<{ ok: boolean }>('SELECT public.rag_cache_sources_current($1, $2::jsonb) AS ok', [tenantKey, JSON.stringify(sources)]),
  );
  return result.rows[0]!.ok;
}

async function resolveSources(db: PGlite, tenantKey: string, ids: string[]): Promise<{ document_id: string; name: string; version: number }[]> {
  const result = await asRole(db, 'service_role', () =>
    db.query<{ document_id: string; name: string; version: number }>(
      'SELECT document_id, name, version FROM public.rag_cache_resolve_sources($1, $2::uuid[]) ORDER BY document_id',
      [tenantKey, ids],
    ),
  );
  return result.rows;
}

/** Changes documents without firing triggers, so a test sees the function's own re-validation rather than trigger invalidation. */
async function updateWithoutTriggers(db: PGlite, sql: string, params: unknown[]): Promise<void> {
  await db.exec('SET session_replication_role = replica');
  try {
    await db.query(sql, params);
  } finally {
    await db.exec('SET session_replication_role = DEFAULT');
  }
}

for (const mode of ['multi-tenant', 'single-tenant'] as DeploymentMode[]) {
  const tenant = mode === 'multi-tenant' ? `u:${FIXTURE_USER_ID}` : 's:default';
  const wrongModeKey = mode === 'multi-tenant' ? 's:default' : `u:${FIXTURE_USER_ID}`;

  describe(`semantic cache check and store (${mode})`, () => {
    let db: PGlite;

    before(async () => {
      ({ db } = await createEmptyFixtureDatabase({ deploymentMode: mode }));
    });

    after(async () => {
      await db?.close();
    });

    test('store then check at distance ~0.01 is a hit with the stored answer', async () => {
      await db.query('DELETE FROM public.rag_semantic_cache');
      const docId = await insertDoc(db, mode);
      const id = await store(db, { tenantKey: tenant, sources: [{ document_id: docId, version: 1 }] });
      const row = await check(db, { tenantKey: tenant, embedding: NEAR, maxDistance: 0.05 });
      assert.equal(row.hit, true);
      assert.equal(row.entry_id, id);
      assert.deepEqual(row.answer, ANSWER);
      assert.equal(row.is_refusal, false);
      assert.ok(row.distance !== null && Math.abs(row.distance - 0.01) < 0.003, `distance ${row.distance}`);
    });

    test('a vector at distance ~0.2 with p_max_distance 0.05 is a miss that still reports the distance', async () => {
      const row = await check(db, { tenantKey: tenant, embedding: FAR, maxDistance: 0.05 });
      assert.equal(row.hit, false);
      assert.equal(row.answer, null);
      assert.equal(row.entry_id, null);
      assert.ok(row.distance !== null && Math.abs(row.distance - 0.2) < 0.005, `distance ${row.distance}`);
    });

    test('a different key hash or profile never hits', async () => {
      assert.equal((await check(db, { tenantKey: tenant, keyHash: OTHER_KEY_HASH })).hit, false);
      assert.equal((await check(db, { tenantKey: tenant, profile: 'p9' })).hit, false);
      assert.equal((await check(db, { tenantKey: tenant, profile: 'p9' })).distance, null);
    });

    test('rows of profiles with different dimensions in one tenant never raise a dimension error', async () => {
      await db.query('DELETE FROM public.rag_semantic_cache');
      await store(db, { tenantKey: tenant, profile: 'p1', embedding: vec([1, 0, 0, 0]) });
      await store(db, { tenantKey: tenant, profile: 'p2', embedding: vec([0, 1, 0]) });
      const p1 = await check(db, { tenantKey: tenant, profile: 'p1', embedding: vec([1, 0, 0, 0]) });
      const p2 = await check(db, { tenantKey: tenant, profile: 'p2', embedding: vec([0, 1, 0]) });
      assert.equal(p1.hit, true);
      assert.equal(p2.hit, true);
    });

    test('an expired row is never a hit', async () => {
      await db.query('DELETE FROM public.rag_semantic_cache');
      await insertRaw(db, tenant, { expiresAt: new Date(Date.now() - 1000).toISOString() });
      const row = await check(db, { tenantKey: tenant });
      assert.equal(row.hit, false);
      assert.equal(row.distance, null);
    });

    for (const ttl of [0, 86401, -5]) {
      test(`store with a TTL of ${ttl} seconds raises 22023`, async () => {
        await assert.rejects(() => store(db, { tenantKey: tenant, ttl }), (error: unknown) => codeOf(error) === '22023');
      });
    }

    test('store sets expires_at from the TTL and accepts the bounds 1 and 86400', async () => {
      await db.query('DELETE FROM public.rag_semantic_cache');
      const short = await store(db, { tenantKey: tenant, ttl: 1 });
      const long = await store(db, { tenantKey: tenant, ttl: 86400 });
      const result = await db.query<{ id: string; secs: number }>(
        'SELECT id, extract(epoch FROM expires_at - created_at)::int AS secs FROM public.rag_semantic_cache WHERE id = ANY($1::uuid[])',
        [[short, long]],
      );
      const secs = Object.fromEntries(result.rows.map((row) => [row.id, row.secs]));
      assert.equal(secs[short], 1);
      assert.equal(secs[long], 86400);
    });

    for (const [label, spec] of [
      ['not current', { isCurrent: false }],
      ['processing', { status: 'processing' }],
      ['quarantined', { status: 'quarantined' }],
    ] as const) {
      test(`store with a source document that is ${label} raises`, async () => {
        const docId = await insertDoc(db, mode, spec);
        await assert.rejects(() => store(db, { tenantKey: tenant, sources: [{ document_id: docId, version: 1 }] }), STALE);
      });
    }

    test('store with a source whose version is not the current version raises', async () => {
      const docId = await insertDoc(db, mode, { version: 2 });
      await assert.rejects(() => store(db, { tenantKey: tenant, sources: [{ document_id: docId, version: 1 }] }), STALE);
    });

    test('store with an unknown source document id raises', async () => {
      await assert.rejects(() => store(db, { tenantKey: tenant, sources: [{ document_id: crypto.randomUUID(), version: 1 }] }), STALE);
    });

    for (const [label, args] of [
      ['a short key hash', { keyHash: 'a'.repeat(63) }],
      ['an upper-case key hash', { keyHash: 'A'.repeat(64) }],
      ['an empty profile', { profile: '' }],
      ['a non-object answer', { answer: 'text' }],
      ['non-array sources', { sources: { document_id: 'x' } }],
    ] as const) {
      test(`store with ${label} raises 22023`, async () => {
        await assert.rejects(() => store(db, { tenantKey: tenant, ...args }), (error: unknown) => codeOf(error) === '22023');
      });
    }

    test('check with a malformed key hash raises 22023', async () => {
      await assert.rejects(() => check(db, { tenantKey: tenant, keyHash: 'zz' }), (error: unknown) => codeOf(error) === '22023');
    });

    test('store deletes at most 100 expired rows of the same tenant per call', async () => {
      await db.query('DELETE FROM public.rag_semantic_cache');
      const past = new Date(Date.now() - 60_000).toISOString();
      await db.query(
        `INSERT INTO public.rag_semantic_cache (tenant_key, key_hash, embedding_profile_id, embedding, query_text_masked, answer, source_versions, is_refusal, expires_at)
         SELECT $1, $2, 'p1', '[1,0,0,0]'::halfvec, 'masked', '{}'::jsonb, '[]'::jsonb, false, $3::timestamptz FROM generate_series(1, 150)`,
        [tenant, KEY_HASH, past],
      );
      await store(db, { tenantKey: tenant });
      assert.equal(await countRows(db, 'tenant_key = $1 AND expires_at <= now()', [tenant]), 50);
      await store(db, { tenantKey: tenant });
      assert.equal(await countRows(db, 'tenant_key = $1 AND expires_at <= now()', [tenant]), 0);
    });

    for (const [label, change] of [
      ['no longer current', 'UPDATE documents SET is_current = false WHERE id = $1'],
      ['soft-deleted', "UPDATE documents SET is_current = false, status = 'deleted' WHERE id = $1"],
      ['bumped to a new version', 'UPDATE documents SET version = version + 1 WHERE id = $1'],
      ['quarantined', "UPDATE documents SET status = 'quarantined' WHERE id = $1"],
    ] as const) {
      test(`a hit whose source document is ${label} becomes a miss and the row is deleted`, async () => {
        await db.query('DELETE FROM public.rag_semantic_cache');
        const docId = await insertDoc(db, mode);
        const id = await store(db, { tenantKey: tenant, sources: [{ document_id: docId, version: 1 }] });
        assert.equal((await check(db, { tenantKey: tenant })).hit, true);
        await updateWithoutTriggers(db, change, [docId]);
        const row = await check(db, { tenantKey: tenant });
        assert.equal(row.hit, false);
        assert.equal(row.answer, null);
        assert.ok(row.distance !== null && row.distance < 0.001);
        assert.equal(await countRows(db, 'id = $1', [id]), 0);
      });
    }

    test('a refusal with no sources is a hit while unexpired', async () => {
      await db.query('DELETE FROM public.rag_semantic_cache');
      await store(db, { tenantKey: tenant, isRefusal: true, ttl: 600 });
      const row = await check(db, { tenantKey: tenant });
      assert.equal(row.hit, true);
      assert.equal(row.is_refusal, true);
    });

    test('rag_cache_invalidate with NULL ids deletes every row of the tenant and returns the count', async () => {
      await db.query('DELETE FROM public.rag_semantic_cache');
      await store(db, { tenantKey: tenant });
      await store(db, { tenantKey: tenant, profile: 'p2', embedding: vec([0, 1, 0]) });
      await insertRaw(db, tenant, { expiresAt: new Date(Date.now() - 1000).toISOString() });
      assert.equal(await invalidate(db, tenant), 3);
      assert.equal(await countRows(db), 0);
      assert.equal(await invalidate(db, tenant), 0);
    });

    test('rag_cache_invalidate with ids deletes only rows whose sources reference one of them', async () => {
      await db.query('DELETE FROM public.rag_semantic_cache');
      const doc1 = await insertDoc(db, mode);
      const doc2 = await insertDoc(db, mode);
      const doc3 = await insertDoc(db, mode);
      const e1 = await store(db, { tenantKey: tenant, sources: [{ document_id: doc1, version: 1 }] });
      const e12 = await store(db, { tenantKey: tenant, sources: [{ document_id: doc1, version: 1 }, { document_id: doc2, version: 1 }] });
      const e3 = await store(db, { tenantKey: tenant, sources: [{ document_id: doc3, version: 1 }] });
      const refusal = await store(db, { tenantKey: tenant, isRefusal: true });
      assert.equal(await invalidate(db, tenant, [doc2, crypto.randomUUID()]), 1);
      assert.equal(await countRows(db, 'id = $1', [e12]), 0);
      assert.equal(await invalidate(db, tenant, [doc1]), 1);
      assert.equal(await countRows(db, 'id = ANY($1::uuid[])', [[e1, e3, refusal]]), 2);
      assert.equal(await invalidate(db, tenant, []), 0);
    });

    test('rag_cache_sources_current is true for current ready sources and false otherwise', async () => {
      const ok1 = await insertDoc(db, mode);
      const ok2 = await insertDoc(db, mode, { version: 3 });
      const old = await insertDoc(db, mode, { isCurrent: false });
      const processing = await insertDoc(db, mode, { status: 'processing' });
      assert.equal(await sourcesCurrent(db, tenant, []), true);
      assert.equal(await sourcesCurrent(db, tenant, [{ document_id: ok1, version: 1 }, { document_id: ok2, version: 3 }]), true);
      assert.equal(await sourcesCurrent(db, tenant, [{ document_id: ok2, version: 2 }]), false);
      assert.equal(await sourcesCurrent(db, tenant, [{ document_id: ok1, version: 1 }, { document_id: old, version: 1 }]), false);
      assert.equal(await sourcesCurrent(db, tenant, [{ document_id: processing, version: 1 }]), false);
      assert.equal(await sourcesCurrent(db, tenant, [{ document_id: crypto.randomUUID(), version: 1 }]), false);
    });

    test('rag_cache_sources_current with non-array sources raises 22023', async () => {
      await assert.rejects(
        () => asRole(db, 'service_role', () => db.query('SELECT public.rag_cache_sources_current($1, $2::jsonb)', [tenant, '{}'])),
        (error: unknown) => codeOf(error) === '22023',
      );
    });

    test('rag_cache_resolve_sources returns the current name and version of current ready documents only', async () => {
      const renamed = await insertDoc(db, mode, { filename: 'before.md', version: 2 });
      await db.query("UPDATE documents SET filename = 'after.md' WHERE id = $1", [renamed]);
      const softDeleted = await insertDoc(db, mode);
      await db.query("UPDATE documents SET is_current = false, status = 'deleted' WHERE id = $1", [softDeleted]);
      const replaced = await insertDoc(db, mode, { isCurrent: false });
      const processing = await insertDoc(db, mode, { status: 'processing' });
      const rows = await resolveSources(db, tenant, [renamed, softDeleted, replaced, processing, crypto.randomUUID()]);
      assert.deepEqual(rows, [{ document_id: renamed, name: 'after.md', version: 2 }]);
      assert.deepEqual(await resolveSources(db, tenant, []), []);
    });

    for (const fn of FUNCTIONS) {
      for (const [label, key] of [
        ['NULL', null],
        ["'O:ABC'", 'O:ABC'],
        ["'x:1'", 'x:1'],
        ["''", ''],
        ['an upper-case uuid', `u:${FIXTURE_USER_ID.toUpperCase()}`],
        ['the other mode key', wrongModeKey],
      ] as const) {
        test(`${fn.name} with ${label} key raises 22023`, async () => {
          const [sql, params] = fn.call(key);
          await assert.rejects(
            () => asRole(db, 'service_role', () => db.query(sql, params)),
            (error: unknown) => codeOf(error) === '22023',
          );
        });
      }

      for (const role of ['anon', 'authenticated'] as const) {
        test(`${fn.name} as ${role} gets 42501`, async () => {
          const [sql, params] = fn.call(tenant);
          await assert.rejects(() => asRole(db, role, () => db.query(sql, params)), (error: unknown) => codeOf(error) === '42501');
        });
      }

      test(`${fn.name} is SECURITY INVOKER with an empty search_path and only service_role may execute`, async () => {
        const meta = await db.query<{ prosecdef: boolean; proconfig: string[] | null }>(
          `SELECT prosecdef, proconfig FROM pg_proc WHERE oid = '${fn.signature}'::regprocedure`,
        );
        assert.equal(meta.rows[0]?.prosecdef, false);
        assert.ok((meta.rows[0]?.proconfig ?? []).some((entry) => entry === 'search_path=""' || entry === "search_path=''"));
        const acl = await db.query<{ grantee: string }>(
          `SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE r.rolname END AS grantee
           FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a LEFT JOIN pg_roles r ON r.oid = a.grantee
           WHERE p.oid = '${fn.signature}'::regprocedure AND a.privilege_type = 'EXECUTE'`,
        );
        const grantees = acl.rows.map((row) => row.grantee);
        assert.ok(!grantees.includes('PUBLIC'));
        assert.ok(!grantees.includes('anon'));
        assert.ok(!grantees.includes('authenticated'));
        assert.ok(grantees.includes('service_role'));
      });
    }

    for (const role of ['anon', 'authenticated'] as const) {
      test(`${role} gets 42501 on SELECT, INSERT and DELETE of rag_semantic_cache`, async () => {
        for (const sql of [
          'SELECT * FROM public.rag_semantic_cache',
          "INSERT INTO public.rag_semantic_cache (tenant_key, key_hash, embedding_profile_id, embedding, query_text_masked, answer, source_versions, is_refusal, expires_at) VALUES ('s:default', 'x', 'p', '[1]'::halfvec, 'm', '{}', '[]', false, now())",
          'DELETE FROM public.rag_semantic_cache',
        ]) {
          await assert.rejects(() => asRole(db, role, () => db.query(sql)), (error: unknown) => codeOf(error) === '42501', sql);
        }
      });
    }

    test('the table has RLS on, no policies, and no privileges for anon or authenticated', async () => {
      const rls = await db.query<{ relrowsecurity: boolean }>(
        "SELECT relrowsecurity FROM pg_class WHERE oid = 'public.rag_semantic_cache'::regclass",
      );
      assert.equal(rls.rows[0]?.relrowsecurity, true);
      const policies = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_policy WHERE polrelid = 'public.rag_semantic_cache'::regclass");
      assert.equal(policies.rows[0]?.n, 0);
      for (const role of ['anon', 'authenticated']) {
        for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
          const result = await db.query<{ ok: boolean }>(`SELECT has_table_privilege($1, 'public.rag_semantic_cache', $2) AS ok`, [role, privilege]);
          assert.equal(result.rows[0]?.ok, false, `${role} ${privilege}`);
        }
      }
    });

    test('applying every migration a second time keeps rows and grants', async () => {
      const before = await countRows(db);
      await applyMigrations(db, mode);
      assert.equal(await countRows(db), before);
      await assert.rejects(
        () => asRole(db, 'anon', () => db.query('SELECT * FROM public.rag_semantic_cache')),
        (error: unknown) => codeOf(error) === '42501',
      );
    });
  });
}

describe('semantic cache two-tenant isolation', () => {
  let db: PGlite;
  const tenantA = `u:${USER_A}`;
  const tenantB = `u:${USER_B}`;

  before(async () => {
    ({ db } = await createEmptyFixtureDatabase({ deploymentMode: 'multi-tenant' }));
    await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4)', [
      USER_A,
      'tenant-a@example.invalid',
      USER_B,
      'tenant-b@example.invalid',
    ]);
  });

  after(async () => {
    await db?.close();
  });

  test("tenant B's key never returns tenant A's row, even with an identical vector and key hash", async () => {
    const docA = await insertDoc(db, 'multi-tenant', { userId: USER_A });
    await store(db, { tenantKey: tenantA, sources: [{ document_id: docA, version: 1 }] });
    const rowB = await check(db, { tenantKey: tenantB });
    assert.equal(rowB.hit, false);
    assert.equal(rowB.distance, null);
    assert.equal(rowB.answer, null);
    assert.equal((await check(db, { tenantKey: tenantA })).hit, true);
  });

  test("store refuses tenant A's document as a source of a tenant B entry", async () => {
    const docA = await insertDoc(db, 'multi-tenant', { userId: USER_A });
    await assert.rejects(() => store(db, { tenantKey: tenantB, sources: [{ document_id: docA, version: 1 }] }), STALE);
  });

  test("store's expired-row cleanup never touches another tenant", async () => {
    await db.query('DELETE FROM public.rag_semantic_cache');
    const past = new Date(Date.now() - 60_000).toISOString();
    for (let i = 0; i < 5; i += 1) await insertRaw(db, tenantB, { expiresAt: past });
    await store(db, { tenantKey: tenantA });
    assert.equal(await countRows(db, 'tenant_key = $1', [tenantB]), 5);
  });

  test("rag_cache_invalidate never deletes another tenant's rows, with or without ids", async () => {
    await db.query('DELETE FROM public.rag_semantic_cache');
    const docA = await insertDoc(db, 'multi-tenant', { userId: USER_A });
    const docB = await insertDoc(db, 'multi-tenant', { userId: USER_B });
    await store(db, { tenantKey: tenantA, sources: [{ document_id: docA, version: 1 }] });
    await store(db, { tenantKey: tenantB, sources: [{ document_id: docB, version: 1 }] });
    await insertRaw(db, tenantB, { sources: [{ document_id: docA, version: 1 }] });
    assert.equal(await invalidate(db, tenantA, [docA]), 1);
    assert.equal(await countRows(db, 'tenant_key = $1', [tenantB]), 2);
    await store(db, { tenantKey: tenantA, sources: [{ document_id: docA, version: 1 }] });
    assert.equal(await invalidate(db, tenantA), 1);
    assert.equal(await countRows(db, 'tenant_key = $1', [tenantB]), 2);
  });

  test("rag_cache_sources_current is false for another tenant's current ready document", async () => {
    const docA = await insertDoc(db, 'multi-tenant', { userId: USER_A });
    assert.equal(await sourcesCurrent(db, tenantA, [{ document_id: docA, version: 1 }]), true);
    assert.equal(await sourcesCurrent(db, tenantB, [{ document_id: docA, version: 1 }]), false);
  });

  test("a hit whose sources belong to another tenant is a miss and is deleted", async () => {
    await db.query('DELETE FROM public.rag_semantic_cache');
    const docA = await insertDoc(db, 'multi-tenant', { userId: USER_A });
    const planted = await insertRaw(db, tenantB, { sources: [{ document_id: docA, version: 1 }] });
    assert.equal((await check(db, { tenantKey: tenantB })).hit, false);
    assert.equal(await countRows(db, 'id = $1', [planted]), 0);
  });

  test("rag_cache_resolve_sources with tenant B's key returns no row for tenant A's ids", async () => {
    const docA = await insertDoc(db, 'multi-tenant', { userId: USER_A });
    assert.equal((await resolveSources(db, tenantA, [docA])).length, 1);
    assert.deepEqual(await resolveSources(db, tenantB, [docA]), []);
  });
});
