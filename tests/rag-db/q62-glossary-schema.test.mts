import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { applyMigrationFiles } from '../../eval/harness/migrations.mts';

/**
 * 0980 glossary schema (Phase 6.2 D-02, D-13, D-15, D-36): translation pairs are TERM entries with a target language; 0980 adds the
 * Glossary list filters to rag_term_list_entries and keeps the 0471/0472 shape, hardening and tenant isolation. Terms are neutral
 * placeholders; language codes come from the registry.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATION = 'supabase/migrations/0980_term_translation_target.sql';
const OLD_LIST = 'public.rag_term_list_entries(uuid, text, integer, integer, text)';
const NEW_LIST = 'public.rag_term_list_entries(uuid, text, integer, integer, text, text, text, text)';

const ADMIN_A = '00000000-0000-4000-8000-00000000a0a1';
const ADMIN_B = '00000000-0000-4000-8000-00000000b0b1';
const ORG_B = '00000000-0000-4000-8000-00000000b0b2';
const LAYER_A = `u:${ADMIN_A}`;
const LAYER_B = `o:${ORG_B}`;

const REGISTRY = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'config/rag/language-packs.json'), 'utf8')) as { packs: { code: string }[] };
const [LANG_1, LANG_2, LANG_3] = REGISTRY.packs.map((pack) => pack.code) as [string, string, string];
assert.ok(LANG_3, 'the registry lists at least three languages');

type Json = Record<string, unknown>;

function synonym(overrides: Json = {}): Json {
  return { canonical: 'term alpha beta', variants: ['termalpha'], normalized_variants: ['termalpha'], language: LANG_1, kind: 'synonym', mode: 'one_way', ...overrides };
}

function pair(target: string, overrides: Json = {}): Json {
  return {
    canonical: 'term gamma delta',
    variants: ['termgamma'],
    normalized_variants: ['termgamma'],
    language: LANG_1,
    kind: 'translation',
    mode: 'one_way',
    source_language: LANG_1,
    target_language: target,
    ...overrides,
  };
}

async function upsert(db: PGlite, actor: string, layer: string, body: Json, expected: number): Promise<{ entry_id: string; layer_version: number; entries_sha256: string }> {
  const result = await db.query<{ entry_id: string; layer_version: number; entries_sha256: string }>(
    'SELECT entry_id::text AS entry_id, layer_version::int AS layer_version, entries_sha256 FROM public.rag_term_upsert_entry(p_actor => $1, p_layer_key => $2, p_entry => $3::jsonb, p_expected_version => $4)',
    [actor, layer, JSON.stringify(body), expected],
  );
  return result.rows[0]!;
}

interface Listed {
  canonical: string;
  kind: string;
  language: string;
  target_language: string | null;
  total_count: number;
}

async function list(db: PGlite, actor: string, layer: string, filters: { kind?: string; source?: string; target?: string } = {}): Promise<Listed[]> {
  const result = await db.query<Listed>(
    `SELECT canonical, kind, language, target_language, total_count::int AS total_count
       FROM public.rag_term_list_entries(p_actor => $1, p_layer_key => $2, p_limit => 50, p_offset => 0, p_search => NULL,
                                         p_kind => $3, p_source_language => $4, p_target_language => $5)`,
    [actor, layer, filters.kind ?? null, filters.source ?? null, filters.target ?? null],
  );
  return result.rows;
}

function sqlState(error: unknown): string {
  return typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : '';
}

async function rejects(db: PGlite, run: () => Promise<unknown>, state: string, message?: string): Promise<void> {
  await db.exec('SAVEPOINT expected_failure');
  await assert.rejects(run, (error: unknown) => {
    assert.equal(sqlState(error), state, String((error as Error)?.message));
    if (message !== undefined) assert.equal((error as Error).message, message);
    return true;
  });
  await db.exec('ROLLBACK TO SAVEPOINT expected_failure');
}

async function asService(db: PGlite, run: () => Promise<void>): Promise<void> {
  await db.exec('BEGIN');
  try {
    await db.exec('SET LOCAL ROLE service_role');
    await run();
  } finally {
    await db.exec('ROLLBACK');
  }
}

async function seed(db: PGlite, mode: DeploymentMode): Promise<void> {
  await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4) ON CONFLICT DO NOTHING', [ADMIN_A, 'admin-a@example.invalid', ADMIN_B, 'admin-b@example.invalid']);
  await db.query('INSERT INTO admin_users (id) VALUES ($1), ($2)', [ADMIN_A, ADMIN_B]);
  if (mode === 'multi-tenant') {
    await db.query('INSERT INTO organizations (id, name, slug, owner_id, is_personal) VALUES ($1, $2, $3, $4, false)', [ORG_B, 'Tenant B', 'tenant-b', ADMIN_B]);
    await db.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING", [ORG_B, ADMIN_B]);
  }
}

function requireMigration(): void {
  assert.ok(fs.existsSync(path.join(REPO_ROOT, MIGRATION)), `${MIGRATION} exists`);
}

async function signatures(db: PGlite): Promise<string[]> {
  const result = await db.query<{ sig: string }>(
    "SELECT p.oid::regprocedure::text AS sig FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'rag_term_list_entries' ORDER BY 1",
  );
  return result.rows.map((row) => row.sig);
}

for (const mode of ['single-tenant', 'multi-tenant'] as const) {
  describe(`0980 glossary schema (${mode})`, () => {
    let db: PGlite;

    before(async () => {
      db = (await createEmptyFixtureDatabase({ deploymentMode: mode })).db;
      await seed(db, mode);
    });

    after(async () => {
      await db?.close();
    });

    test('re-applies cleanly, also after 0471 and 0472 are re-run, leaving one list signature, one column and one translation CHECK', async () => {
      requireMigration();
      await applyMigrationFiles(db, [MIGRATION]);
      await applyMigrationFiles(db, ['supabase/migrations/0471_terminology_schema.sql', 'supabase/migrations/0472_terminology_writers.sql']);
      assert.ok((await signatures(db)).includes(OLD_LIST), 're-running 0472 brings the old signature back');
      await applyMigrationFiles(db, [MIGRATION, MIGRATION]);
      assert.deepEqual(await signatures(db), [NEW_LIST]);
      const columns = await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'rag_term_entries' AND column_name = 'target_language'",
      );
      assert.equal(columns.rows[0]?.n, 1);
      const checks = await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_catalog.pg_constraint WHERE conrelid = 'public.rag_term_entries'::regclass AND conname = 'rag_term_entries_translation_check'",
      );
      assert.equal(checks.rows[0]?.n, 1);
    });

    test('the list function is a definer with an empty search_path, closed to anon and authenticated and granted to service_role', async () => {
      requireMigration();
      const result = await db.query<{ anon: boolean; authenticated: boolean; service: boolean; definer: boolean; config: string[] | null }>(
        `SELECT has_function_privilege('anon', $1, 'EXECUTE') AS anon, has_function_privilege('authenticated', $1, 'EXECUTE') AS authenticated,
                has_function_privilege('service_role', $1, 'EXECUTE') AS service, p.prosecdef AS definer, p.proconfig AS config
           FROM pg_catalog.pg_proc p WHERE p.oid = $1::regprocedure`,
        [NEW_LIST],
      );
      assert.deepEqual(result.rows[0], { anon: false, authenticated: false, service: true, definer: true, config: ['search_path=""'] });
      const effective = await db.query<{ anon: boolean; authenticated: boolean; service: boolean }>(
        "SELECT has_function_privilege('anon', 'public.rag_term_effective(text)', 'EXECUTE') AS anon, has_function_privilege('authenticated', 'public.rag_term_effective(text)', 'EXECUTE') AS authenticated, has_function_privilege('service_role', 'public.rag_term_effective(text)', 'EXECUTE') AS service",
      );
      assert.deepEqual(effective.rows[0], { anon: false, authenticated: false, service: true });
    });

    test('the writer refuses a translation without a target, with the target equal to its language, and a target on a synonym', async () => {
      await asService(db, async () => {
        await rejects(db, () => upsert(db, ADMIN_A, 'shared', pair(LANG_2, { target_language: null }), 0), 'P0001', 'invalid_entry');
        await rejects(db, () => upsert(db, ADMIN_A, 'shared', pair(LANG_1), 0), 'P0001', 'invalid_entry');
        await rejects(db, () => upsert(db, ADMIN_A, 'shared', synonym({ target_language: LANG_2 }), 0), 'P0001', 'invalid_entry');
        const ok = await upsert(db, ADMIN_A, 'shared', pair(LANG_2), 0);
        assert.equal(ok.layer_version, 1);
      });
    });

    test('a target-only edit changes the entries hash and bumps the version', async () => {
      await asService(db, async () => {
        const created = await upsert(db, ADMIN_A, 'shared', pair(LANG_2), 0);
        const edited = await upsert(db, ADMIN_A, 'shared', pair(LANG_3, { id: created.entry_id }), 1);
        assert.equal(edited.layer_version, 2);
        assert.notEqual(edited.entries_sha256, created.entries_sha256);
        const back = await upsert(db, ADMIN_A, 'shared', pair(LANG_2, { id: created.entry_id }), 2);
        assert.equal(back.entries_sha256, created.entries_sha256, 'equal content gives an equal hash');
      });
    });

    test('the Glossary filters select translation rows by source and target language; other kinds carry target_language null', async () => {
      requireMigration();
      await asService(db, async () => {
        await upsert(db, ADMIN_A, 'shared', synonym(), 0);
        await upsert(db, ADMIN_A, 'shared', pair(LANG_2), 1);
        await upsert(db, ADMIN_A, 'shared', pair(LANG_3), 2);
        await upsert(db, ADMIN_A, 'shared', pair(LANG_1, { canonical: 'term epsilon zeta', variants: ['termepsilon'], normalized_variants: ['termepsilon'], language: LANG_2, source_language: LANG_2 }), 3);

        const all = await list(db, ADMIN_A, 'shared');
        assert.equal(all.length, 4);
        assert.equal(all.find((row) => row.kind === 'synonym')?.target_language, null);

        const glossary = await list(db, ADMIN_A, 'shared', { kind: 'translation' });
        assert.deepEqual(glossary.map((row) => row.total_count), [3, 3, 3]);
        assert.ok(glossary.every((row) => row.kind === 'translation'));

        const fromFirst = await list(db, ADMIN_A, 'shared', { kind: 'translation', source: LANG_1 });
        assert.deepEqual(fromFirst.map((row) => row.target_language).sort(), [LANG_2, LANG_3].sort());

        const one = await list(db, ADMIN_A, 'shared', { kind: 'translation', source: LANG_1, target: LANG_3 });
        assert.deepEqual(one.map((row) => [row.language, row.target_language, row.total_count]), [[LANG_1, LANG_3, 1]]);

        const none = await list(db, ADMIN_A, 'shared', { kind: 'synonym', target: LANG_2 });
        assert.deepEqual(none, []);

        const positional = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.rag_term_list_entries($1, $2, 50, 0, NULL)', [ADMIN_A, 'shared']);
        assert.equal(positional.rows[0]?.n, 4, 'the five-argument call still lists the whole layer');
      });
    });

    test('rag_term_effective checks the tenant key first: a malformed or wrong-mode key raises 22023', async () => {
      await asService(db, async () => {
        await rejects(db, () => db.query('SELECT * FROM public.rag_term_effective($1)', ['not-a-key']), '22023');
        const wrongMode = mode === 'single-tenant' ? LAYER_A : 's:default';
        await rejects(db, () => db.query('SELECT * FROM public.rag_term_effective($1)', [wrongMode]), '22023');
      });
    });
  });
}

describe('0980 glossary schema: tenant isolation of translation rows (multi-tenant)', () => {
  let db: PGlite;

  before(async () => {
    db = (await createEmptyFixtureDatabase({ deploymentMode: 'multi-tenant' })).db;
    await seed(db, 'multi-tenant');
  });

  after(async () => {
    await db?.close();
  });

  test("tenant A's effective dictionary carries its own and the shared translation rows with target_language, never tenant B's", async () => {
      requireMigration();
    await asService(db, async () => {
      await upsert(db, ADMIN_A, 'shared', pair(LANG_2, { canonical: 'shared term alpha' }), 0);
      await upsert(db, ADMIN_A, LAYER_A, pair(LANG_2, { canonical: 'tenant a term' }), 0);
      await upsert(db, ADMIN_B, LAYER_B, pair(LANG_3, { canonical: 'tenant b term' }), 0);

      const effective = async (key: string) =>
        (
          await db.query<{ canonical: string; layer: string; target_language: string | null }>(
            "SELECT canonical, layer, target_language FROM public.rag_term_effective($1) WHERE kind = 'translation' ORDER BY canonical",
            [key],
          )
        ).rows;
      assert.deepEqual(await effective(LAYER_A), [
        { canonical: 'shared term alpha', layer: 'shared', target_language: LANG_2 },
        { canonical: 'tenant a term', layer: 'workspace', target_language: LANG_2 },
      ]);
      assert.deepEqual(await effective(LAYER_B), [
        { canonical: 'shared term alpha', layer: 'shared', target_language: LANG_2 },
        { canonical: 'tenant b term', layer: 'workspace', target_language: LANG_3 },
      ]);

      await rejects(db, () => list(db, ADMIN_A, LAYER_B, { kind: 'translation' }), 'P0001', 'not_admin_of_layer');
      const own = await list(db, ADMIN_B, LAYER_B, { kind: 'translation', target: LANG_2 });
      assert.deepEqual(own, [], "tenant B's list never shows another layer's rows");
    });
  });
});
