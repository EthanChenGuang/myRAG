import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { applyMigrations } from '../../eval/harness/migrations.mts';
import { FIXTURE_USER_ID, createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';

const ANON_KEY = 'fixture-anon-key-placeholder';
const SERVICE_KEY = 'fixture-service-role-key-placeholder';
const USER_B = '00000000-0000-4000-8000-0000000014b1';
const MODES: DeploymentMode[] = ['multi-tenant', 'single-tenant'];

const SIGNATURES = [
  'public.rag_identifier_patterns_list(text)',
  'public.rag_identifier_pattern_create(text, text, text, text, boolean, uuid)',
  'public.rag_identifier_pattern_update(text, uuid, text, text, text, boolean)',
  'public.rag_identifier_pattern_delete(text, uuid)',
  'public.rag_identifier_resolve(text, text[])',
  'public.rag_identifier_candidates(text, text, integer)',
];

interface PatternRow {
  id: string;
  name: string;
  pattern: string;
  flags: string;
  enabled: boolean;
  updated_at: string;
}

interface Failure {
  code: string;
  message: string;
}

type Role = 'anon' | 'authenticated' | 'service_role';

async function asRole<T>(db: PGlite, role: Role, run: () => Promise<T>): Promise<T> {
  await db.exec(`SET ROLE ${role}`);
  try {
    return await run();
  } finally {
    await db.exec('RESET ROLE');
  }
}

async function service<T>(db: PGlite, sql: string, params: unknown[] = []): Promise<T[]> {
  return asRole(db, 'service_role', async () => (await db.query<T>(sql, params)).rows);
}

async function serviceFailure(db: PGlite, sql: string, params: unknown[] = []): Promise<Failure | null> {
  try {
    await service(db, sql, params);
    return null;
  } catch (error) {
    const e = error as { code?: unknown; message?: unknown };
    return { code: typeof e.code === 'string' ? e.code : '', message: typeof e.message === 'string' ? e.message : String(error) };
  }
}

async function withReplica<T>(db: PGlite, run: () => Promise<T>): Promise<T> {
  await db.exec("SET session_replication_role = 'replica'");
  try {
    return await run();
  } finally {
    await db.exec("SET session_replication_role = 'origin'");
  }
}

const list = (db: PGlite, tenant: string) =>
  service<PatternRow>(db, 'SELECT id::text AS id, name, pattern, flags, enabled, updated_at::text AS updated_at FROM public.rag_identifier_patterns_list($1)', [tenant]);

const create = (db: PGlite, tenant: string, name: string, pattern = '[A-Z]{2}[0-9]{4}', flags = 'u', enabled = true) =>
  service<PatternRow>(
    db,
    'SELECT id::text AS id, name, pattern, flags, enabled, updated_at::text AS updated_at FROM public.rag_identifier_pattern_create($1, $2, $3, $4, $5, NULL)',
    [tenant, name, pattern, flags, enabled],
  ).then((rows) => rows[0] as PatternRow);

const CREATE_SQL = 'SELECT * FROM public.rag_identifier_pattern_create($1, $2, $3, $4, $5, NULL)';
const UPDATE_SQL =
  'SELECT id::text AS id, name, pattern, flags, enabled, updated_at::text AS updated_at FROM public.rag_identifier_pattern_update($1, $2::uuid, $3, $4, $5, $6)';
const DELETE_SQL = 'SELECT public.rag_identifier_pattern_delete($1, $2::uuid) AS id';
const RESOLVE_SQL = 'SELECT norm, raw FROM public.rag_identifier_resolve($1, $2::text[]) ORDER BY norm';
const CANDIDATES_SQL = 'SELECT raw, norm FROM public.rag_identifier_candidates($1, $2, $3) ORDER BY norm';

/** Public schema objects of the identifier functions; equal before and after a second application of every migration. */
async function functionDump(db: PGlite): Promise<string[]> {
  const result = await db.query<{ sig: string; def: string; acl: string | null }>(
    `SELECT p.oid::regprocedure::text AS sig, pg_get_functiondef(p.oid) AS def, p.proacl::text AS acl FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'rag\\_identifier\\_%'`,
  );
  return result.rows.map((row) => JSON.stringify(row)).sort();
}

for (const mode of MODES) {
  const multi = mode === 'multi-tenant';
  const tenantA = multi ? `u:${FIXTURE_USER_ID}` : 's:default';
  const tenantB = `u:${USER_B}`;
  const wrongModeKey = multi ? 's:default' : `u:${FIXTURE_USER_ID}`;

  describe(`identifier pattern and lookup functions, 0858 (${mode})`, () => {
    let db: PGlite;
    let edge: FakeEdge;

    async function insertDocument(owner: 'A' | 'B', status = 'ready', isCurrent = true): Promise<string> {
      const id = crypto.randomUUID();
      if (multi) {
        await db.query(
          "INSERT INTO documents (id, filename, content, user_id, status, is_current) VALUES ($1, 'ids.md', 'neutral body', $2, $3, $4)",
          [id, owner === 'A' ? FIXTURE_USER_ID : USER_B, status, isCurrent],
        );
      } else {
        await db.query("INSERT INTO documents (id, filename, content, status, is_current) VALUES ($1, 'ids.md', 'neutral body', $2, $3)", [
          id,
          status,
          isCurrent,
        ]);
      }
      return id;
    }

    /** Seeds identifier columns directly (the indexer comes in a later plan). In single-tenant mode tenant B's chunk is planted with triggers off. */
    async function seedChunk(owner: 'A' | 'B', raw: string[], norm: string[], options: { status?: string; isCurrent?: boolean; docStatus?: string } = {}) {
      const documentId = await insertDocument(owner, options.docStatus ?? 'ready');
      const id = crypto.randomUUID();
      const insert = () =>
        db.query(
          `INSERT INTO document_chunks (id, document_id, content, metadata, status, is_current, identifiers_raw, identifiers_norm${!multi && owner === 'B' ? ', tenant_key' : ''})
           VALUES ($1, $2, 'neutral chunk text', '{}'::jsonb, $3, $4, $5::text[], $6::text[]${!multi && owner === 'B' ? ', $7' : ''})`,
          [id, documentId, options.status ?? 'ready', options.isCurrent ?? true, raw, norm, ...(!multi && owner === 'B' ? [tenantB] : [])],
        );
      if (!multi && owner === 'B') await withReplica(db, insert);
      else await insert();
      return id;
    }

    /** Tenant B's pattern: through the function in multi-tenant mode, planted with triggers off in single-tenant mode. */
    async function createForB(name: string): Promise<PatternRow> {
      if (multi) return create(db, tenantB, name);
      return withReplica(db, async () => {
        const result = await db.query<PatternRow>(
          "INSERT INTO rag_identifier_patterns (tenant_key, name, pattern, flags) VALUES ($1, $2, '[0-9]{6}', 'u') RETURNING id::text AS id, name, pattern, flags, enabled, updated_at::text AS updated_at",
          [tenantB, name],
        );
        return result.rows[0] as PatternRow;
      });
    }

    async function clearPatterns(): Promise<void> {
      await db.query('DELETE FROM rag_identifier_patterns');
    }

    before(async () => {
      ({ db } = await createEmptyFixtureDatabase({ deploymentMode: mode }));
      if (multi) await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [USER_B, 'fixture-user-b@example.invalid']);
      edge = await startFakeEdge({ db, serviceKeys: [SERVICE_KEY], anonKey: ANON_KEY });
    });

    after(async () => {
      await edge?.close();
      await db?.close();
    });

    test('create returns the stored row; list returns it in creation order; update changes only the given fields and bumps updated_at; delete removes it', async () => {
      await clearPatterns();
      const first = await create(db, tenantA, 'shape one', '[A-Z]{3}-[0-9]{3}', 'u');
      assert.equal(first.name, 'shape one');
      assert.equal(first.pattern, '[A-Z]{3}-[0-9]{3}');
      assert.equal(first.flags, 'u');
      assert.equal(first.enabled, true);
      assert.match(first.id, /^[0-9a-f-]{36}$/);
      const second = await create(db, tenantA, 'shape two', '[0-9]{2}/[0-9]{4}', 'iu', false);
      const third = await create(db, tenantA, 'shape three');
      assert.deepEqual(
        (await list(db, tenantA)).map((row) => row.id),
        [first.id, second.id, third.id],
      );

      const updated = (await service<PatternRow>(db, UPDATE_SQL, [tenantA, second.id, null, null, null, true]))[0] as PatternRow;
      assert.equal(updated.enabled, true);
      assert.equal(updated.name, 'shape two');
      assert.equal(updated.pattern, '[0-9]{2}/[0-9]{4}');
      assert.equal(updated.flags, 'iu');
      assert.ok(Date.parse(updated.updated_at) > Date.parse(second.updated_at), 'updated_at moves forward');

      const renamed = (await service<PatternRow>(db, UPDATE_SQL, [tenantA, first.id, 'shape renamed', '[A-Z]{4}', 'iu', null]))[0] as PatternRow;
      assert.deepEqual([renamed.name, renamed.pattern, renamed.flags, renamed.enabled], ['shape renamed', '[A-Z]{4}', 'iu', true]);

      const deleted = await service<{ id: string }>(db, DELETE_SQL, [tenantA, third.id]);
      assert.equal(deleted[0]?.id, third.id);
      assert.deepEqual(
        (await list(db, tenantA)).map((row) => row.id),
        [first.id, second.id],
      );
    });

    test('the 21st pattern raises limit_reached; a duplicate name raises name_exists; the same name in the other tenant is allowed', async () => {
      await clearPatterns();
      for (let i = 0; i < 20; i += 1) await create(db, tenantA, `shape ${i}`);
      const limit = await serviceFailure(db, CREATE_SQL, [tenantA, 'shape 20', '[0-9]{5}', 'u', true]);
      assert.ok(limit && limit.message.startsWith('limit_reached'), `got ${JSON.stringify(limit)}`);
      assert.equal((await list(db, tenantA)).length, 20);

      await db.query('DELETE FROM rag_identifier_patterns WHERE tenant_key = $1 AND name = $2', [tenantA, 'shape 19']);
      const duplicate = await serviceFailure(db, CREATE_SQL, [tenantA, 'shape 0', '[0-9]{5}', 'u', true]);
      assert.ok(duplicate && duplicate.message.startsWith('name_exists'), `got ${JSON.stringify(duplicate)}`);
      const renameClash = await serviceFailure(db, UPDATE_SQL, [tenantA, (await list(db, tenantA))[1]?.id, 'shape 0', null, null, null]);
      assert.ok(renameClash && renameClash.message.startsWith('name_exists'), `got ${JSON.stringify(renameClash)}`);

      const other = await createForB('shape 0');
      assert.equal(other.name, 'shape 0');
      assert.equal((await list(db, tenantA)).length, 19);
    });

    test("a tenant never sees, changes or deletes another tenant's pattern; an unknown id raises pattern_not_found", async () => {
      await clearPatterns();
      const own = await create(db, tenantA, 'own shape');
      const foreign = await createForB('foreign shape');
      assert.deepEqual(
        (await list(db, tenantA)).map((row) => row.id),
        [own.id],
      );
      if (multi) {
        assert.deepEqual(
          (await list(db, tenantB)).map((row) => row.id),
          [foreign.id],
        );
      }
      for (const [sql, params] of [
        [UPDATE_SQL, [tenantA, foreign.id, 'taken over', null, null, false]],
        [DELETE_SQL, [tenantA, foreign.id]],
        [UPDATE_SQL, [tenantA, crypto.randomUUID(), 'nothing', null, null, null]],
        [DELETE_SQL, [tenantA, crypto.randomUUID()]],
      ] as const) {
        const result = await serviceFailure(db, sql, [...params]);
        assert.ok(result && result.message.startsWith('pattern_not_found'), `got ${JSON.stringify(result)}`);
      }
      const stored = await db.query<{ name: string; enabled: boolean }>('SELECT name, enabled FROM rag_identifier_patterns WHERE id = $1', [foreign.id]);
      assert.deepEqual(stored.rows, [{ name: 'foreign shape', enabled: true }], 'the foreign row is unchanged');
    });

    test('malformed names, patterns and flags raise with ERRCODE 22023', async () => {
      await clearPatterns();
      const cases: unknown[][] = [
        [tenantA, 'x'.repeat(81), '[0-9]{4}', 'u', true],
        [tenantA, '   ', '[0-9]{4}', 'u', true],
        [tenantA, 'long pattern', `[0-9]${'x'.repeat(200)}`, 'u', true],
        [tenantA, 'empty pattern', '', 'u', true],
        [tenantA, 'bad flags', '[0-9]{4}', 'gu', true],
        [tenantA, 'bad flags', '[0-9]{4}', 'i', true],
        [tenantA, 'no flags', '[0-9]{4}', null, true],
      ];
      for (const params of cases) {
        const result = await serviceFailure(db, CREATE_SQL, params);
        assert.equal(result?.code, '22023', `create ${JSON.stringify(params.slice(1, 4))}: ${JSON.stringify(result)}`);
      }
      const own = await create(db, tenantA, 'valid');
      for (const params of [
        [tenantA, own.id, 'y'.repeat(81), null, null, null],
        [tenantA, own.id, null, 'z'.repeat(201), null, null],
        [tenantA, own.id, null, null, 'ui', null],
      ]) {
        const result = await serviceFailure(db, UPDATE_SQL, params);
        assert.equal(result?.code, '22023', `update ${JSON.stringify(params.slice(2))}: ${JSON.stringify(result)}`);
      }
      assert.deepEqual((await list(db, tenantA)).map((row) => row.name), ['valid']);
    });

    test("rag_identifier_resolve returns the caller's existing identifiers with a stored spelling, never another tenant's or a non-current or non-ready one", async () => {
      await seedChunk('A', ['Ab-1234', 'QX 77'], ['ab1234', 'qx77']);
      await seedChunk('A', ['AB.1234'], ['ab1234']);
      await seedChunk('B', ['ZZ-9001'], ['zz9001']);
      await seedChunk('A', ['OLD-1'], ['old1'], { isCurrent: false });
      await seedChunk('A', ['PEND-2'], ['pend2'], { status: 'processing' });
      await seedChunk('A', ['QUAR-3'], ['quar3'], { docStatus: 'quarantined' });

      const rows = await service<{ norm: string; raw: string }>(db, RESOLVE_SQL, [tenantA, ['ab1234', 'qx77', 'zz9001', 'old1', 'pend2', 'quar3', 'missing1']]);
      assert.deepEqual(
        rows.map((row) => row.norm),
        ['ab1234', 'qx77'],
      );
      assert.ok(['Ab-1234', 'AB.1234'].includes(rows[0]?.raw ?? ''), `stored spelling, got ${rows[0]?.raw}`);
      assert.equal(rows[1]?.raw, 'QX 77');
      if (multi) {
        const forB = await service<{ norm: string }>(db, RESOLVE_SQL, [tenantB, ['ab1234', 'zz9001']]);
        assert.deepEqual(
          forB.map((row) => row.norm),
          ['zz9001'],
        );
      }
      assert.deepEqual(await service(db, RESOLVE_SQL, [tenantA, []]), []);
      const tooMany = await serviceFailure(db, RESOLVE_SQL, [tenantA, Array.from({ length: 17 }, (_, i) => `id${i}`)]);
      assert.equal(tooMany?.code, '22023');
      assert.equal((await service(db, RESOLVE_SQL, [tenantA, Array.from({ length: 16 }, (_, i) => `id${i}`)])).length, 0);
    });

    test("rag_identifier_candidates returns the caller's identifiers of similar length sharing a prefix or suffix, capped, never the input or another tenant's", async () => {
      await seedChunk('A', ['CD-5500', 'CD-5501', 'XY-5500', 'CD-550012345', 'MN-0001', 'C'], ['cd5500', 'cd5501', 'xy5500', 'cd550012345', 'mn0001', 'c']);
      await seedChunk('A', ['cd 5502'], ['cd5502']);
      await seedChunk('B', ['CD-5503'], ['cd5503']);
      await seedChunk('A', ['CD-5504'], ['cd5504'], { isCurrent: false });

      const rows = await service<{ raw: string; norm: string }>(db, CANDIDATES_SQL, [tenantA, 'cd5500', 10]);
      assert.deepEqual(
        rows.map((row) => row.norm),
        ['cd5501', 'cd5502', 'xy5500'],
      );
      assert.equal(rows.find((row) => row.norm === 'cd5502')?.raw, 'cd 5502');
      const capped = await service(db, CANDIDATES_SQL, [tenantA, 'cd5500', 2]);
      assert.equal(capped.length, 2);
      const big = await service(db, CANDIDATES_SQL, [tenantA, 'cd5500', 5000]);
      assert.equal(big.length, 3, 'the limit is capped, not refused');
      if (multi) {
        const forB = await service<{ norm: string }>(db, CANDIDATES_SQL, [tenantB, 'cd5500', 10]);
        assert.deepEqual(
          forB.map((row) => row.norm),
          ['cd5503'],
        );
      }
      assert.deepEqual(await service(db, CANDIDATES_SQL, [tenantA, '', 10]), []);
    });

    test('anon and authenticated cannot execute any of the functions; service_role can; a key of the other mode is rejected', async () => {
      for (const signature of SIGNATURES) {
        const privileges = await db.query<{ role: string; allowed: boolean }>(
          `SELECT r.role, has_function_privilege(r.role, $1, 'EXECUTE') AS allowed FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r(role)`,
          [signature],
        );
        assert.deepEqual(
          Object.fromEntries(privileges.rows.map((row) => [row.role, row.allowed])),
          { anon: false, authenticated: false, service_role: true },
          signature,
        );
        const definer = await db.query<{ secdef: boolean; config: string[] | null }>('SELECT prosecdef AS secdef, proconfig AS config FROM pg_proc WHERE oid = $1::regprocedure', [
          signature,
        ]);
        assert.equal(definer.rows[0]?.secdef, false, `${signature} is SECURITY INVOKER`);
        assert.ok((definer.rows[0]?.config ?? []).includes('search_path=""'), `${signature} has an empty search_path`);
      }
      for (const role of ['anon', 'authenticated'] as const) {
        await assert.rejects(
          () => asRole(db, role, () => db.query('SELECT * FROM public.rag_identifier_patterns_list($1)', [tenantA])),
          (error: unknown) => (error as { code?: string }).code === '42501',
        );
      }
      const res = await fetch(`${edge.url}/rest/v1/rpc/rag_identifier_resolve`, {
        method: 'POST',
        headers: { apikey: ANON_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ p_tenant_key: tenantA, p_norm: ['ab1234'] }),
      });
      assert.equal(res.status, 403);
      assert.equal(((await res.json()) as { code?: string }).code, '42501');
      const ok = await fetch(`${edge.url}/rest/v1/rpc/rag_identifier_patterns_list`, {
        method: 'POST',
        headers: { apikey: SERVICE_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ p_tenant_key: tenantA }),
      });
      assert.equal(ok.status, 200);

      for (const [sql, params] of [
        ['SELECT * FROM public.rag_identifier_patterns_list($1)', [wrongModeKey]],
        [CREATE_SQL, [wrongModeKey, 'wrong mode', '[0-9]{4}', 'u', true]],
        [UPDATE_SQL, [wrongModeKey, crypto.randomUUID(), 'x', null, null, null]],
        [DELETE_SQL, [wrongModeKey, crypto.randomUUID()]],
        [RESOLVE_SQL, [wrongModeKey, ['ab1234']]],
        [CANDIDATES_SQL, [wrongModeKey, 'ab1234', 5]],
        [RESOLVE_SQL, ['not-a-tenant', ['ab1234']]],
      ] as const) {
        const result = await serviceFailure(db, sql, [...params]);
        assert.equal(result?.code, '22023', `${sql} with ${String(params[0])}: ${JSON.stringify(result)}`);
      }
    });

    test('applying every migration a second time leaves the identifier functions unchanged', async () => {
      const first = await functionDump(db);
      assert.equal(first.length, SIGNATURES.length);
      await applyMigrations(db, mode);
      assert.deepEqual(await functionDump(db), first);
    });
  });
}
