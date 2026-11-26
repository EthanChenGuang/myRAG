import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATION = 'supabase/migrations/0471_terminology_schema.sql';
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const TABLES = ['rag_term_layers', 'rag_term_entries', 'rag_term_audit'] as const;
const SIGNATURE = 'public.rag_term_effective(text)';
const ANON_KEY = 'fixture-anon-key-placeholder';
const SERVICE_KEY = 'fixture-service-role-key-placeholder';

const TENANT_A = 'u:00000000-0000-4000-8000-00000000a001';
const TENANT_B = 'o:00000000-0000-4000-8000-00000000b002';
const ACTOR = '00000000-0000-4000-8000-0000000000c3';

// Two codes from the registry (D-35): the test names no language code of its own.
const REGISTRY = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'config/rag/language-packs.json'), 'utf8')) as { packs: { code: string }[] };
const [LANG_1, LANG_2] = REGISTRY.packs.map((pack) => pack.code) as [string, string];

function readMigration(): string {
  const file = path.join(REPO_ROOT, MIGRATION);
  assert.ok(fs.existsSync(file), `${MIGRATION} exists`);
  return fs.readFileSync(file, 'utf8');
}

type Role = 'anon' | 'authenticated' | 'service_role';

interface EntryInput {
  layer_key?: string;
  canonical?: string;
  variants?: string[];
  normalized_variants?: string[];
  language?: string;
  kind?: string;
  mode?: string;
  enabled?: boolean;
  source_language?: string | null;
  target_language?: string | null;
  suppresses_entry_id?: string | null;
}

async function insertEntry(db: PGlite, input: EntryInput = {}): Promise<string> {
  const row = {
    layer_key: 'shared',
    canonical: 'term alpha beta',
    variants: ['termalpha'],
    normalized_variants: ['termalpha'],
    language: 'any',
    kind: 'synonym',
    mode: 'one_way',
    enabled: true,
    source_language: null,
    target_language: null,
    suppresses_entry_id: null,
    ...input,
  };
  const result = await db.query<{ id: string }>(
    `INSERT INTO public.rag_term_entries
       (layer_key, canonical, variants, normalized_variants, language, kind, mode, enabled, source_language, target_language, suppresses_entry_id, created_by, updated_by)
     VALUES ($1, $2, $3::text[], $4::text[], $5, $6, $7, $8, $9, $10, $11::uuid, $12::uuid, $12::uuid)
     RETURNING id::text AS id`,
    [
      row.layer_key,
      row.canonical,
      row.variants,
      row.normalized_variants,
      row.language,
      row.kind,
      row.mode,
      row.enabled,
      row.source_language,
      row.target_language,
      row.suppresses_entry_id,
      ACTOR,
    ],
  );
  return result.rows[0]!.id;
}

function sqlState(error: unknown): string {
  return typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : '';
}

async function rejectsWith(run: () => Promise<unknown>, code: string, message?: RegExp): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.equal(sqlState(error), code, `expected SQLSTATE ${code}, got ${sqlState(error)}: ${String((error as Error)?.message)}`);
    if (message) assert.match(String((error as Error).message), message);
    return true;
  });
}

async function asRole<T>(db: PGlite, role: Role, run: () => Promise<T>): Promise<T> {
  await db.exec(`SET ROLE ${role}`);
  try {
    return await run();
  } finally {
    await db.exec('RESET ROLE');
  }
}

/** Rolls back whatever the body inserted, so each case starts from the same rows. */
async function inRollback(db: PGlite, run: () => Promise<void>): Promise<void> {
  await db.exec('BEGIN');
  try {
    await run();
  } finally {
    await db.exec('ROLLBACK');
  }
}

interface EffectiveRow {
  entry_id: string;
  layer: string;
  canonical: string;
  variants: string[];
  normalized_variants: string[];
  language: string;
  kind: string;
  mode: string;
  source_language: string | null;
  target_language: string | null;
  shared_version: number;
  tenant_version: number;
}

async function effective(db: PGlite, tenantKey: string): Promise<EffectiveRow[]> {
  const result = await asRole(db, 'service_role', () =>
    db.query<EffectiveRow>('SELECT entry_id::text AS entry_id, layer, canonical, variants, normalized_variants, language, kind, mode, source_language, target_language, shared_version::int AS shared_version, tenant_version::int AS tenant_version FROM public.rag_term_effective($1)', [tenantKey]),
  );
  return result.rows;
}

for (const mode of MODES) {
  const ownTenant = mode === 'multi-tenant' ? TENANT_A : 's:default';
  const foreignKey = mode === 'multi-tenant' ? 's:default' : TENANT_A;

  describe(`terminology schema 0471 (${mode})`, () => {
    let db: PGlite;

    before(async () => {
      db = (await createEmptyFixtureDatabase({ deploymentMode: mode })).db;
    });

    after(async () => {
      await db?.close();
    });

    test('the three tables exist with RLS on and no policies', async () => {
      for (const table of TABLES) {
        const row = await db.query<{ oid: string | null; rls: boolean | null; policies: number }>(
          `SELECT to_regclass($1)::text AS oid,
                  (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = to_regclass($1)) AS rls,
                  (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = to_regclass($1)) AS policies`,
          [`public.${table}`],
        );
        assert.equal(row.rows[0]?.oid, table, `${table} exists`);
        assert.equal(row.rows[0]?.rls, true, `${table} has RLS on`);
        assert.equal(row.rows[0]?.policies, 0, `${table} has no policy`);
      }
    });

    test('layer_key is shared or a tenant key; anything else fails the CHECK', async () => {
      for (const key of ['shared', 's:default', TENANT_B]) {
        await inRollback(db, async () => {
          await db.query('INSERT INTO public.rag_term_layers (layer_key) VALUES ($1)', [key]);
          await insertEntry(db, { layer_key: key });
        });
      }
      for (const key of ['x:1', 'u:not-a-uuid', '']) {
        await inRollback(db, () => rejectsWith(() => db.query('INSERT INTO public.rag_term_layers (layer_key) VALUES ($1)', [key]), '23514'));
        await inRollback(db, () => rejectsWith(() => insertEntry(db, { layer_key: key }), '23514'));
      }
    });

    test('a layer row starts at version 0', async () => {
      await inRollback(db, async () => {
        await db.query("INSERT INTO public.rag_term_layers (layer_key) VALUES ('shared')");
        const row = await db.query<{ version: number; sha: string | null }>("SELECT version::int AS version, entries_sha256 AS sha FROM public.rag_term_layers WHERE layer_key = 'shared'");
        assert.deepEqual(row.rows[0], { version: 0, sha: null });
      });
    });

    test('a suppression row must be on a tenant layer and carry no variants', async () => {
      await inRollback(db, async () => {
        const shared = await insertEntry(db);
        await insertEntry(db, { layer_key: TENANT_B, variants: [], normalized_variants: [], suppresses_entry_id: shared });
      });
      await inRollback(db, async () => {
        const shared = await insertEntry(db);
        await rejectsWith(() => insertEntry(db, { layer_key: 'shared', variants: [], normalized_variants: [], suppresses_entry_id: shared }), '23514');
      });
      await inRollback(db, async () => {
        const shared = await insertEntry(db);
        await rejectsWith(() => insertEntry(db, { layer_key: TENANT_B, suppresses_entry_id: shared }), '23514');
      });
    });

    test('an ordinary entry needs 1 to 16 non-empty variants', async () => {
      await inRollback(db, () => rejectsWith(() => insertEntry(db, { variants: [], normalized_variants: [] }), '23514'));
      await inRollback(db, () => rejectsWith(() => insertEntry(db, { variants: Array.from({ length: 17 }, (_, i) => `termalpha${i}`) }), '23514'));
      await inRollback(db, () => rejectsWith(() => insertEntry(db, { variants: ['termalpha', ''] }), '23514'));
    });

    test('language is any or a lower-case code; the shape is all SQL checks', async () => {
      for (const language of ['any', LANG_1, LANG_2]) {
        await inRollback(db, async () => {
          await insertEntry(db, { language });
        });
      }
      for (const language of [LANG_1.toUpperCase(), '', 'a b', `${LANG_1} `]) {
        await inRollback(db, () => rejectsWith(() => insertEntry(db, { language }), '23514'));
      }
    });

    test('the migration names no language code', () => {
      const sql = readMigration();
      for (const { code } of REGISTRY.packs) {
        assert.doesNotMatch(sql, new RegExp(`'${code}'`), `0471 names the code ${code}`);
      }
    });

    test('a well-formed translation pair is accepted', async () => {
      await inRollback(db, async () => {
        await insertEntry(db, {
          canonical: '术语甲乙丙',
          variants: ['term alpha beta'],
          normalized_variants: ['term alpha beta'],
          kind: 'translation',
          language: LANG_1,
          source_language: LANG_1,
          target_language: LANG_2,
        });
      });
    });

    test('every malformed translation pair fails a CHECK', async () => {
      const pair = { canonical: '术语甲乙丙', variants: ['term alpha beta'], kind: 'translation', language: LANG_1, source_language: LANG_1, target_language: LANG_2 };
      const broken: EntryInput[] = [
        { ...pair, target_language: null },
        { ...pair, source_language: null },
        { ...pair, target_language: LANG_1 },
        { ...pair, source_language: 'any', language: 'any' },
        { ...pair, target_language: 'any' },
        { ...pair, language: LANG_2 },
        { ...pair, language: 'any' },
        { ...pair, mode: 'equivalent' },
        { ...pair, target_language: LANG_2.toUpperCase() },
        { kind: 'synonym', source_language: LANG_1 },
        { kind: 'synonym', target_language: LANG_2 },
        { kind: 'alias', source_language: LANG_1, target_language: LANG_2 },
      ];
      for (const input of broken) {
        await inRollback(db, () => rejectsWith(() => insertEntry(db, input), '23514'));
      }
    });

    test('kind and mode are closed sets', async () => {
      await inRollback(db, () => rejectsWith(() => insertEntry(db, { kind: 'other' }), '23514'));
      await inRollback(db, () => rejectsWith(() => insertEntry(db, { mode: 'two_way' }), '23514'));
      for (const kind of ['synonym', 'abbreviation', 'alias', 'identifier', 'misspelling']) {
        await inRollback(db, async () => {
          await insertEntry(db, { kind });
        });
      }
      await inRollback(db, async () => {
        await insertEntry(db, { mode: 'equivalent' });
      });
    });

    test('one entry per layer, language, target language and canonical (case-insensitive)', async () => {
      const pair = { canonical: '术语甲乙丙', variants: ['term alpha beta'], kind: 'translation', language: LANG_1, source_language: LANG_1 };
      await inRollback(db, async () => {
        await insertEntry(db, { ...pair, target_language: LANG_2 });
        await insertEntry(db, { ...pair, target_language: 'zz' });
        await rejectsWith(() => insertEntry(db, { ...pair, target_language: LANG_2, variants: ['term gamma delta'] }), '23505');
      });
      await inRollback(db, async () => {
        await insertEntry(db, { canonical: 'term alpha beta' });
        await rejectsWith(() => insertEntry(db, { canonical: 'Term Alpha Beta', variants: ['alpha beta'] }), '23505');
        await insertEntry(db, { canonical: 'term alpha beta', language: LANG_1 });
        await insertEntry(db, { canonical: 'term alpha beta', layer_key: TENANT_B });
      });
    });

    test('one suppression per tenant layer and suppressed entry', async () => {
      await inRollback(db, async () => {
        const shared = await insertEntry(db);
        await insertEntry(db, { layer_key: TENANT_B, variants: [], normalized_variants: [], suppresses_entry_id: shared });
        await rejectsWith(() => insertEntry(db, { layer_key: TENANT_B, variants: [], normalized_variants: [], suppresses_entry_id: shared }), '23505');
        await insertEntry(db, { layer_key: TENANT_A, variants: [], normalized_variants: [], suppresses_entry_id: shared });
      });
    });

    test('normalized_variants carries a GIN index', async () => {
      const row = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_am a ON a.oid = c.relam
          WHERE i.indrelid = 'public.rag_term_entries'::regclass AND a.amname = 'gin'
            AND pg_get_indexdef(i.indexrelid) LIKE '%normalized_variants%'`,
      );
      assert.equal(row.rows[0]?.n, 1);
    });

    test('rag_term_audit is append-only: UPDATE, DELETE and TRUNCATE raise', async () => {
      await db.query(
        `INSERT INTO public.rag_term_audit (layer_key, entry_id, action, actor, before, after, layer_version)
         VALUES ('shared', gen_random_uuid(), 'create', $1::uuid, NULL, '{"canonical":"term alpha beta"}'::jsonb, 1)`,
        [ACTOR],
      );
      await rejectsWith(() => db.query("UPDATE public.rag_term_audit SET action = 'delete'"), 'P0001', /rag_term_audit is append-only/);
      await rejectsWith(() => db.query('DELETE FROM public.rag_term_audit'), 'P0001', /rag_term_audit is append-only/);
      await rejectsWith(() => db.query('TRUNCATE public.rag_term_audit'), 'P0001', /rag_term_audit is append-only/);
      const count = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.rag_term_audit');
      assert.equal(count.rows[0]?.n, 1);
    });

    test('the audit action is a closed set', async () => {
      await inRollback(db, () =>
        rejectsWith(
          () => db.query("INSERT INTO public.rag_term_audit (layer_key, action, actor, layer_version) VALUES ('shared', 'rename', $1::uuid, 1)", [ACTOR]),
          '23514',
        ),
      );
    });

    test('anon and authenticated cannot read any table; service_role reads but cannot write directly', async () => {
      for (const table of TABLES) {
        for (const role of ['anon', 'authenticated'] as const) {
          await rejectsWith(() => asRole(db, role, () => db.query(`SELECT 1 FROM public.${table} LIMIT 1`)), '42501');
        }
        await asRole(db, 'service_role', () => db.query(`SELECT 1 FROM public.${table} LIMIT 1`));
        const privileges = await db.query<{ role: string; select: boolean; insert: boolean; update: boolean; delete: boolean }>(
          `SELECT r.role, has_table_privilege(r.role, $1, 'SELECT') AS select, has_table_privilege(r.role, $1, 'INSERT') AS insert,
                  has_table_privilege(r.role, $1, 'UPDATE') AS update, has_table_privilege(r.role, $1, 'DELETE') AS delete
             FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r(role)`,
          [`public.${table}`],
        );
        assert.deepEqual(
          Object.fromEntries(privileges.rows.map((row) => [row.role, [row.select, row.insert, row.update, row.delete]])),
          { anon: [false, false, false, false], authenticated: [false, false, false, false], service_role: [true, false, false, false] },
          table,
        );
      }
      await rejectsWith(() => asRole(db, 'service_role', () => insertEntry(db)), '42501');
      await rejectsWith(
        () => asRole(db, 'service_role', () => db.query("INSERT INTO public.rag_term_layers (layer_key) VALUES ('shared')")),
        '42501',
      );
    });

    test('rag_term_effective is SECURITY INVOKER with an empty search_path, executable by service_role only', async () => {
      const fn = await db.query<{ definer: boolean; config: string | null; acl: string | null }>(
        'SELECT p.prosecdef AS definer, p.proconfig::text AS config, p.proacl::text AS acl FROM pg_proc p WHERE p.oid = $1::regprocedure',
        [SIGNATURE],
      );
      assert.equal(fn.rows[0]?.definer, false);
      assert.equal(fn.rows[0]?.config, '{"search_path=\\"\\""}');
      assert.ok(!/(^|[{,])=X/.test(fn.rows[0]?.acl ?? ''), 'no PUBLIC execute');
      const privileges = await db.query<{ role: string; allowed: boolean }>(
        `SELECT r.role, has_function_privilege(r.role, $1, 'EXECUTE') AS allowed FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r(role)`,
        [SIGNATURE],
      );
      assert.deepEqual(Object.fromEntries(privileges.rows.map((row) => [row.role, row.allowed])), { anon: false, authenticated: false, service_role: true });
      for (const role of ['anon', 'authenticated'] as const) {
        await rejectsWith(() => asRole(db, role, () => db.query('SELECT * FROM public.rag_term_effective($1)', [ownTenant])), '42501');
      }
    });

    test('a malformed key, the shared layer key and a key of the other mode are refused', async () => {
      for (const key of ['shared', 'x:1', '', foreignKey]) {
        await rejectsWith(() => effective(db, key), '22023');
      }
    });

    test('shared entries, the tenant entries and both layer versions (0 without a layer row)', async () => {
      await inRollback(db, async () => {
        const shared = await insertEntry(db, { canonical: 'term alpha beta', variants: ['termalpha', 'alpha beta'], normalized_variants: ['termalpha', 'alpha beta'] });
        const own = await insertEntry(db, { layer_key: ownTenant, canonical: 'term gamma delta', variants: ['termgamma'], normalized_variants: ['termgamma'], language: LANG_1 });
        let rows = await effective(db, ownTenant);
        assert.deepEqual(
          rows.map((row) => [row.entry_id, row.layer, row.canonical, row.shared_version, row.tenant_version]),
          [
            [shared, 'shared', 'term alpha beta', 0, 0],
            [own, 'workspace', 'term gamma delta', 0, 0],
          ],
        );
        assert.deepEqual(rows[0]?.variants, ['termalpha', 'alpha beta']);
        assert.deepEqual(rows[0]?.normalized_variants, ['termalpha', 'alpha beta']);
        assert.equal(rows[1]?.language, LANG_1);

        await db.query("INSERT INTO public.rag_term_layers (layer_key, version) VALUES ('shared', 3), ($1, 5)", [ownTenant]);
        rows = await effective(db, ownTenant);
        assert.deepEqual([...new Set(rows.map((row) => `${row.shared_version}/${row.tenant_version}`))], ['3/5']);
      });
    });

    test('disabled entries are not returned', async () => {
      await inRollback(db, async () => {
        await insertEntry(db, { enabled: false });
        await insertEntry(db, { layer_key: ownTenant, enabled: false, canonical: 'term gamma delta' });
        assert.deepEqual(await effective(db, ownTenant), []);
      });
    });

    test('a layer row without entries yields no rows', async () => {
      await inRollback(db, async () => {
        await db.query("INSERT INTO public.rag_term_layers (layer_key, version) VALUES ('shared', 2)");
        assert.deepEqual(await effective(db, ownTenant), []);
      });
    });

    test('a translation pair is returned with its languages; other rows carry null in both', async () => {
      await inRollback(db, async () => {
        await insertEntry(db, { canonical: 'term alpha beta', variants: ['termalpha'] });
        const pair = await insertEntry(db, {
          canonical: '术语甲乙丙',
          variants: ['term alpha beta'],
          normalized_variants: ['term alpha beta'],
          kind: 'translation',
          language: LANG_1,
          source_language: LANG_1,
          target_language: LANG_2,
        });
        const rows = await effective(db, ownTenant);
        const translation = rows.find((row) => row.entry_id === pair);
        assert.deepEqual(
          translation && [translation.kind, translation.language, translation.source_language, translation.target_language, translation.mode],
          ['translation', LANG_1, LANG_1, LANG_2, 'one_way'],
        );
        const others = rows.filter((row) => row.entry_id !== pair);
        assert.equal(others.length, 1);
        assert.deepEqual([others[0]?.source_language, others[0]?.target_language], [null, null]);
      });
    });

    test('through the fake edge the anon key is refused and the service key reads', async () => {
      let edge: FakeEdge | undefined;
      try {
        edge = await startFakeEdge({ db, serviceKeys: [SERVICE_KEY], anonKey: ANON_KEY });
        const call = async (apikey: string) => {
          const res = await fetch(`${edge!.url}/rest/v1/rpc/rag_term_effective`, {
            method: 'POST',
            headers: { apikey, 'content-type': 'application/json' },
            body: JSON.stringify({ p_tenant_key: ownTenant }),
          });
          return { status: res.status, body: (await res.json()) as unknown };
        };
        const anon = await call(ANON_KEY);
        assert.equal(anon.status, 403);
        assert.equal((anon.body as { code?: string }).code, '42501');
        const service = await call(SERVICE_KEY);
        assert.equal(service.status, 200);
        assert.ok(Array.isArray(service.body));
      } finally {
        await edge?.close();
      }
    });

    test('applying 0471 a second time succeeds and keeps the rows', async () => {
      await insertEntry(db, { canonical: 'term gamma delta', variants: ['termgamma'] });
      await db.exec(readMigration());
      await db.exec(readMigration());
      const count = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM public.rag_term_entries WHERE canonical = 'term gamma delta'");
      assert.equal(count.rows[0]?.n, 1);
      const audit = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.rag_term_audit');
      assert.equal(audit.rows[0]?.n, 1);
      await rejectsWith(() => db.query('DELETE FROM public.rag_term_audit'), 'P0001', /rag_term_audit is append-only/);
      const privileges = await db.query<{ anon: boolean; service: boolean }>(
        "SELECT has_function_privilege('anon', $1, 'EXECUTE') AS anon, has_function_privilege('service_role', $1, 'EXECUTE') AS service",
        [SIGNATURE],
      );
      assert.deepEqual(privileges.rows[0], { anon: false, service: true });
    });
  });
}

describe('two tenants (multi-tenant)', () => {
  let db: PGlite;

  before(async () => {
    db = (await createEmptyFixtureDatabase({ deploymentMode: 'multi-tenant' })).db;
  });

  after(async () => {
    await db?.close();
  });

  test('each tenant reads the shared layer and its own entries, never the other tenant', async () => {
    await inRollback(db, async () => {
      const shared = await insertEntry(db, { canonical: 'term alpha beta', variants: ['termalpha'] });
      const a = await insertEntry(db, { layer_key: TENANT_A, canonical: 'term gamma delta', variants: ['termgamma'] });
      const b = await insertEntry(db, { layer_key: TENANT_B, canonical: '术语丁戊己', variants: ['术语丁'] });
      await db.query("INSERT INTO public.rag_term_layers (layer_key, version) VALUES ('shared', 4), ($1, 7)", [TENANT_A]);

      const forA = await effective(db, TENANT_A);
      const forB = await effective(db, TENANT_B);
      assert.deepEqual(forA.map((row) => [row.entry_id, row.layer]), [[shared, 'shared'], [a, 'workspace']]);
      assert.deepEqual(forB.map((row) => [row.entry_id, row.layer]), [[shared, 'shared'], [b, 'workspace']]);
      assert.deepEqual([forA[0]?.shared_version, forA[0]?.tenant_version], [4, 7]);
      assert.deepEqual([forB[0]?.shared_version, forB[0]?.tenant_version], [4, 0]);
      assert.ok(!forA.some((row) => row.entry_id === b));
      assert.ok(!forB.some((row) => row.entry_id === a));
    });
  });

  test("a tenant's suppression hides the shared entry for that tenant only", async () => {
    await inRollback(db, async () => {
      const hidden = await insertEntry(db, { canonical: 'term alpha beta', variants: ['termalpha'] });
      const kept = await insertEntry(db, { canonical: 'termine alfa beta', variants: ['voce alfa'] });
      const suppression = await insertEntry(db, { layer_key: TENANT_A, variants: [], normalized_variants: [], suppresses_entry_id: hidden });

      const forA = await effective(db, TENANT_A);
      const forB = await effective(db, TENANT_B);
      assert.deepEqual(forA.map((row) => row.entry_id), [kept]);
      assert.deepEqual(forB.map((row) => row.entry_id).sort(), [hidden, kept].sort());
      assert.ok(!forA.some((row) => row.entry_id === suppression), 'a suppression row is never an entry');

      await db.query('UPDATE public.rag_term_entries SET enabled = false WHERE id = $1::uuid', [suppression]);
      assert.deepEqual((await effective(db, TENANT_A)).map((row) => row.entry_id).sort(), [hidden, kept].sort());
    });
  });

  test("a suppression row naming another tenant's entry hides nothing", async () => {
    await inRollback(db, async () => {
      const ofB = await insertEntry(db, { layer_key: TENANT_B, canonical: 'term gamma delta', variants: ['termgamma'] });
      await insertEntry(db, { layer_key: TENANT_A, variants: [], normalized_variants: [], suppresses_entry_id: ofB });
      assert.deepEqual((await effective(db, TENANT_B)).map((row) => row.entry_id), [ofB]);
      assert.deepEqual(await effective(db, TENANT_A), []);
    });
  });

  test('a shared translation pair reaches both tenants', async () => {
    await inRollback(db, async () => {
      const pair = await insertEntry(db, {
        canonical: '术语甲乙丙',
        variants: ['term alpha beta'],
        kind: 'translation',
        language: LANG_1,
        source_language: LANG_1,
        target_language: LANG_2,
      });
      for (const tenant of [TENANT_A, TENANT_B]) {
        const rows = await effective(db, tenant);
        assert.deepEqual(rows.map((row) => [row.entry_id, row.source_language, row.target_language]), [[pair, LANG_1, LANG_2]]);
      }
    });
  });
});
