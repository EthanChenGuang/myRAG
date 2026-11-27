import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';

/**
 * W-1, W-5 (04.1.1 verification): re-running 0472 (or a setup file) after 0980 leaves rag_term_list_entries with the 5-argument 0472
 * signature next to the 8-argument 0980 one. PostgREST then answers PGRST203 for a 5-named-argument call. The admin module must still
 * load a layer and list entries in that state, and on a schema without 0980. Both deployment modes; placeholder terms only (D-37).
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REGISTRY = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'config/rag/language-packs.json'), 'utf8')) as {
  packs: { code: string; script: string }[];
};
const HAN = REGISTRY.packs.find((pack) => pack.script === 'Hani')!.code;
const LATIN = REGISTRY.packs.find((pack) => pack.script === 'Latn')!.code;
const MIGRATION_0472 = fs.readFileSync(path.join(REPO_ROOT, 'supabase/migrations/0472_terminology_writers.sql'), 'utf8');
const MIGRATION_0980 = fs.readFileSync(path.join(REPO_ROOT, 'supabase/migrations/0980_term_translation_target.sql'), 'utf8');
const FIVE = 'public.rag_term_list_entries(uuid, text, integer, integer, text)';
const EIGHT = 'public.rag_term_list_entries(uuid, text, integer, integer, text, text, text, text)';
const ADMIN = '00000000-0000-4000-8000-00000000a0c1';

const singleDb: PGlite = (await createEmptyFixtureDatabase({ deploymentMode: 'single-tenant' })).db;
const multiDb: PGlite = (await createEmptyFixtureDatabase({ deploymentMode: 'multi-tenant' })).db;
const edge: FakeEdge = await startFakeEdge({ db: singleDb });
Object.assign(process.env, fixtureProcessEnv(edge.url));
process.env.RAG_SUPPORTED_LANGUAGES = [HAN, LATIN].join(',');
process.env.RAG_PRIMARY_LANGUAGE = LATIN;

const admin = await import('@/lib/rag/terminology/admin');
const { resetLanguageSettingsForTests } = await import('@/lib/rag/lang/settings');

const signal = new AbortController().signal;

async function signatures(db: PGlite): Promise<{ five: boolean; eight: boolean }> {
  const { rows } = await db.query<{ five: string | null; eight: string | null }>('SELECT to_regprocedure($1)::text AS five, to_regprocedure($2)::text AS eight', [FIVE, EIGHT]);
  return { five: rows[0]!.five !== null, eight: rows[0]!.eight !== null };
}

async function seedAdmin(db: PGlite): Promise<void> {
  await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING', [ADMIN, 'admin-overload@example.invalid']);
  await db.query('INSERT INTO admin_users (id) VALUES ($1) ON CONFLICT DO NOTHING', [ADMIN]);
}

async function assertListsAndLoads(label: string): Promise<void> {
  const loaded = await admin.loadLayer(ADMIN, 'shared', signal);
  assert.equal(loaded.ok, true, `${label}: loadLayer ${JSON.stringify(loaded)}`);
  if (loaded.ok) assert.equal(loaded.layer.entries.length, 1, `${label}: loadLayer entries`);
  const listed = await admin.listEntries({ actorUserId: ADMIN, layerKey: 'shared', signal });
  assert.equal(listed.ok, true, `${label}: listEntries ${JSON.stringify(listed)}`);
  if (listed.ok) assert.equal(listed.total, 1, `${label}: listEntries total`);
  const versions = await admin.getVersions({ actorUserId: ADMIN, workspaceLayerKey: null, signal });
  assert.equal(versions.ok, true, `${label}: getVersions ${JSON.stringify(versions)}`);
}

for (const [mode, db] of [
  ['single-tenant', singleDb],
  ['multi-tenant', multiDb],
] as const) {
  describe(`rag_term_list_entries after re-running 0472 on top of 0980 (${mode})`, () => {
    before(async () => {
      process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = mode;
      process.env.MYRAG_DEPLOYMENT_MODE = mode;
      resetLanguageSettingsForTests();
      edge.useDatabase(db);
      await seedAdmin(db);
      assert.deepEqual(await signatures(db), { five: false, eight: true }, 'the fixture applies every migration, 0980 included');
      const created = await admin.createEntry({
        actorUserId: ADMIN,
        layerKey: 'shared',
        expectedVersion: 0,
        entry: { canonical: 'placeholder canonical term', variants: ['placeholder variant'], language: LATIN, kind: 'synonym' },
        signal,
      });
      assert.equal(created.ok, true, JSON.stringify(created));
    });

    test('0980 alone: loadLayer, listEntries and getVersions work', async () => {
      await assertListsAndLoads('0980 only');
    });

    test('0472 re-run after 0980: both signatures exist and every call still works', async () => {
      await db.exec(MIGRATION_0472);
      edge.useDatabase(db);
      assert.deepEqual(await signatures(db), { five: true, eight: true });
      await assertListsAndLoads('both signatures');
      const filtered = await admin.listEntries({ actorUserId: ADMIN, layerKey: 'shared', kind: 'synonym', signal });
      assert.equal(filtered.ok, true, JSON.stringify(filtered));
      if (filtered.ok) assert.equal(filtered.total, 1);
    });

    test('a schema without 0980: unfiltered calls work and a Glossary filter answers schema_outdated', async () => {
      await db.exec(`DROP FUNCTION ${EIGHT}`);
      edge.useDatabase(db);
      assert.deepEqual(await signatures(db), { five: true, eight: false });
      await assertListsAndLoads('0472 only');
      const filtered = await admin.listEntries({ actorUserId: ADMIN, layerKey: 'shared', kind: 'translation', signal });
      assert.deepEqual(filtered, { ok: false, reason: 'schema_outdated' });
    });

    test('re-running 0980 restores the single 8-argument signature', async () => {
      await db.exec(MIGRATION_0980);
      edge.useDatabase(db);
      assert.deepEqual(await signatures(db), { five: false, eight: true });
      await assertListsAndLoads('0980 re-run');
    });
  });
}

after(async () => {
  await edge.close();
  await singleDb.close();
  await multiDb.close();
});
