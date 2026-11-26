import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';

/**
 * 0472 terminology writers (D-03, D-05, D-06, D-23): every write is authorized per layer, bumps the layer version once, recomputes
 * entries_sha256 and writes its audit rows in the same transaction; imports are all-or-nothing; everything is service_role only.
 * Terms are the D-37 placeholders; language codes come from the registry (D-35).
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATION = 'supabase/migrations/0472_terminology_writers.sql';
const ANON_KEY = 'fixture-anon-key-placeholder';
const SERVICE_KEY = 'fixture-service-role-key-placeholder';

const ADMIN_A = '00000000-0000-4000-8000-00000000a0a1';
const ADMIN_B = '00000000-0000-4000-8000-00000000b0b1';
const NON_ADMIN = '00000000-0000-4000-8000-00000000c0c1';
const ORG_B = '00000000-0000-4000-8000-00000000b0b2';
const LAYER_A = `u:${ADMIN_A}`;
const LAYER_B = `o:${ORG_B}`;

const REGISTRY = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'config/rag/language-packs.json'), 'utf8')) as { packs: { code: string }[] };
const CODES = REGISTRY.packs.map((pack) => pack.code);
assert.ok(CODES.length >= 3, 'the registry lists at least three languages');
const [LANG_1, LANG_2, LANG_3] = CODES as [string, string, string];

const PUBLIC_FUNCTIONS = [
  'public.rag_term_upsert_entry(uuid, text, jsonb, bigint)',
  'public.rag_term_delete_entry(uuid, text, uuid, bigint)',
  'public.rag_term_set_suppression(uuid, text, uuid, boolean, bigint)',
  'public.rag_term_apply_import(uuid, text, jsonb, text, bigint)',
  'public.rag_term_list_entries(uuid, text, integer, integer, text)',
  'public.rag_term_list_audit(uuid, text, integer, integer)',
];

type Json = Record<string, unknown>;

function entry(overrides: Json = {}): Json {
  return {
    canonical: 'term alpha beta',
    variants: ['termalpha'],
    normalized_variants: ['termalpha'],
    language: 'any',
    kind: 'synonym',
    mode: 'one_way',
    ...overrides,
  };
}

function translationPair(overrides: Json = {}): Json {
  return entry({
    canonical: 'term alpha beta',
    variants: ['术语甲乙丙'],
    normalized_variants: ['术语甲乙丙'],
    language: LANG_1,
    kind: 'translation',
    source_language: LANG_1,
    target_language: LANG_2,
    ...overrides,
  });
}

interface WriteResult {
  entry_id: string;
  layer_version: number;
  entries_sha256: string;
  action: string;
}

async function upsert(db: PGlite, actor: string, layer: string, body: Json | unknown, expected: number): Promise<WriteResult> {
  const result = await db.query<WriteResult>(
    'SELECT entry_id::text AS entry_id, layer_version::int AS layer_version, entries_sha256, action FROM public.rag_term_upsert_entry(p_actor => $1, p_layer_key => $2, p_entry => $3::jsonb, p_expected_version => $4)',
    [actor, layer, JSON.stringify(body), expected],
  );
  return result.rows[0]!;
}

async function remove(db: PGlite, actor: string, layer: string, id: string, expected: number): Promise<{ layer_version: number; entries_sha256: string }> {
  const result = await db.query<{ layer_version: number; entries_sha256: string }>(
    'SELECT layer_version::int AS layer_version, entries_sha256 FROM public.rag_term_delete_entry(p_actor => $1, p_layer_key => $2, p_entry_id => $3, p_expected_version => $4)',
    [actor, layer, id, expected],
  );
  return result.rows[0]!;
}

async function suppress(db: PGlite, actor: string, layer: string, sharedId: string, on: boolean, expected: number): Promise<{ layer_version: number; suppressed: boolean }> {
  const result = await db.query<{ layer_version: number; suppressed: boolean }>(
    'SELECT layer_version::int AS layer_version, suppressed FROM public.rag_term_set_suppression(p_actor => $1, p_layer_key => $2, p_shared_entry_id => $3, p_suppressed => $4, p_expected_version => $5)',
    [actor, layer, sharedId, on, expected],
  );
  return result.rows[0]!;
}

interface ImportResult {
  layer_version: number;
  entries_sha256: string;
  created: number;
  updated: number;
  unchanged: number;
  deleted: number;
}

async function importRows(db: PGlite, actor: string, layer: string, rows: unknown, mode: string, expected: number): Promise<ImportResult> {
  const result = await db.query<ImportResult>(
    'SELECT layer_version::int AS layer_version, entries_sha256, created::int AS created, updated::int AS updated, unchanged::int AS unchanged, deleted::int AS deleted FROM public.rag_term_apply_import(p_actor => $1, p_layer_key => $2, p_rows => $3::jsonb, p_mode => $4, p_expected_version => $5)',
    [actor, layer, JSON.stringify(rows), mode, expected],
  );
  return result.rows[0]!;
}

async function layerRow(db: PGlite, layer: string): Promise<{ version: number; entries_sha256: string | null; updated_by: string | null } | undefined> {
  const result = await db.query<{ version: number; entries_sha256: string | null; updated_by: string | null }>(
    'SELECT version::int AS version, entries_sha256, updated_by::text AS updated_by FROM public.rag_term_layers WHERE layer_key = $1',
    [layer],
  );
  return result.rows[0];
}

async function versionOf(db: PGlite, layer: string): Promise<number> {
  return (await layerRow(db, layer))?.version ?? 0;
}

interface AuditRow {
  entry_id: string | null;
  action: string;
  actor: string;
  before: Json | null;
  after: Json | null;
  layer_version: number;
}

async function auditOf(db: PGlite, layer: string): Promise<AuditRow[]> {
  const result = await db.query<AuditRow>(
    'SELECT entry_id::text AS entry_id, action, actor::text AS actor, before, after, layer_version::int AS layer_version FROM public.rag_term_audit WHERE layer_key = $1 ORDER BY layer_version, created_at, id',
    [layer],
  );
  return result.rows;
}

async function entryCount(db: PGlite, layer: string): Promise<number> {
  const result = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.rag_term_entries WHERE layer_key = $1', [layer]);
  return result.rows[0]?.n ?? 0;
}

async function effectiveIds(db: PGlite, tenantKey: string): Promise<string[]> {
  const result = await db.query<{ entry_id: string }>('SELECT entry_id::text AS entry_id FROM public.rag_term_effective($1)', [tenantKey]);
  return result.rows.map((row) => row.entry_id);
}

function sqlState(error: unknown): string {
  return typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : '';
}

/** An expected failure inside the open transaction: P0001 with the code as the whole message; the savepoint keeps the transaction usable. */
async function rejectsCode(db: PGlite, run: () => Promise<unknown>, code: string): Promise<void> {
  await db.exec('SAVEPOINT expected_failure');
  await assert.rejects(run, (error: unknown) => {
    assert.equal(sqlState(error), 'P0001', `expected P0001, got ${sqlState(error)}: ${String((error as Error)?.message)}`);
    assert.equal((error as Error).message, code);
    return true;
  });
  await db.exec('ROLLBACK TO SAVEPOINT expected_failure');
}

/** Each case runs as service_role (the role the route layer uses) and rolls back, so every case starts from an empty dictionary. */
async function asService(db: PGlite, run: () => Promise<void>): Promise<void> {
  await db.exec('BEGIN');
  try {
    await db.exec('SET LOCAL ROLE service_role');
    await run();
  } finally {
    await db.exec('ROLLBACK');
  }
}

async function seedActors(db: PGlite, mode: DeploymentMode): Promise<void> {
  await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4), ($5, $6) ON CONFLICT DO NOTHING', [
    ADMIN_A,
    'admin-a@example.invalid',
    ADMIN_B,
    'admin-b@example.invalid',
    NON_ADMIN,
    'member@example.invalid',
  ]);
  await db.query('INSERT INTO admin_users (id) VALUES ($1), ($2)', [ADMIN_A, ADMIN_B]);
  if (mode === 'multi-tenant') {
    await db.query('INSERT INTO organizations (id, name, slug, owner_id, is_personal) VALUES ($1, $2, $3, $4, false)', [ORG_B, 'Tenant B', 'tenant-b', ADMIN_B]);
    await db.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING", [ORG_B, ADMIN_B]);
  }
}

describe('terminology writers 0472 (multi-tenant): versions, audit and actor checks', () => {
  let db: PGlite;

  before(async () => {
    db = (await createEmptyFixtureDatabase({ deploymentMode: 'multi-tenant' })).db;
    await seedActors(db, 'multi-tenant');
  });

  after(async () => {
    await db?.close();
  });

  test('create, update and delete on the shared layer bump the version once each and audit before and after', async () => {
    await asService(db, async () => {
      const created = await upsert(db, ADMIN_A, 'shared', entry(), 0);
      assert.equal(created.layer_version, 1);
      assert.equal(created.action, 'create');
      const row = await layerRow(db, 'shared');
      assert.equal(row?.version, 1);
      assert.equal(row?.updated_by, ADMIN_A);
      assert.match(row?.entries_sha256 ?? '', /^[0-9a-f]{64}$/);

      const updated = await upsert(db, ADMIN_A, 'shared', entry({ id: created.entry_id, variants: ['termalpha', 'alpha beta'], normalized_variants: ['termalpha', 'alpha beta'] }), 1);
      assert.equal(updated.layer_version, 2);
      assert.equal(updated.action, 'update');
      assert.equal(updated.entry_id, created.entry_id);

      const deleted = await remove(db, ADMIN_A, 'shared', created.entry_id, 2);
      assert.equal(deleted.layer_version, 3);
      assert.equal(await entryCount(db, 'shared'), 0);

      const audit = await auditOf(db, 'shared');
      assert.deepEqual(audit.map((a) => [a.action, a.layer_version, a.entry_id, a.actor]), [
        ['create', 1, created.entry_id, ADMIN_A],
        ['update', 2, created.entry_id, ADMIN_A],
        ['delete', 3, created.entry_id, ADMIN_A],
      ]);
      assert.equal(audit[0]?.before, null);
      assert.deepEqual(audit[0]?.after?.variants, ['termalpha']);
      assert.deepEqual(audit[1]?.before?.variants, ['termalpha']);
      assert.deepEqual(audit[1]?.after?.variants, ['termalpha', 'alpha beta']);
      assert.deepEqual(audit[2]?.before?.variants, ['termalpha', 'alpha beta']);
      assert.equal(audit[2]?.after, null);
    });
  });

  test('an admin writes only the layers they administer; another tenant entry id answers not_found; a non-admin is refused', async () => {
    await asService(db, async () => {
      const own = await upsert(db, ADMIN_A, LAYER_A, entry(), 0);
      assert.equal(own.layer_version, 1);
      const foreign = await upsert(db, ADMIN_B, LAYER_B, entry({ canonical: 'term gamma delta', variants: ['termgamma'], normalized_variants: ['termgamma'] }), 0);

      await rejectsCode(db, () => upsert(db, ADMIN_A, LAYER_B, entry(), 1), 'not_admin_of_layer');
      await rejectsCode(db, () => remove(db, ADMIN_A, LAYER_B, foreign.entry_id, 1), 'not_admin_of_layer');
      await rejectsCode(db, () => upsert(db, ADMIN_A, LAYER_A, entry({ id: foreign.entry_id }), 1), 'not_found');
      await rejectsCode(db, () => remove(db, ADMIN_A, LAYER_A, foreign.entry_id, 1), 'not_found');
      await rejectsCode(db, () => remove(db, ADMIN_A, 'shared', foreign.entry_id, 0), 'not_found');
      await rejectsCode(db, () => upsert(db, ADMIN_A, 's:default', entry(), 0), 'not_admin_of_layer');
      await rejectsCode(db, () => upsert(db, NON_ADMIN, 'shared', entry(), 0), 'not_admin');
      await rejectsCode(db, () => upsert(db, NON_ADMIN, `u:${NON_ADMIN}`, entry(), 0), 'not_admin');

      assert.equal(await versionOf(db, LAYER_B), 1);
      assert.equal(await versionOf(db, 'shared'), 0);
      assert.equal((await auditOf(db, LAYER_B)).length, 1);
      const bEntries = await db.query<{ canonical: string }>('SELECT canonical FROM public.rag_term_entries WHERE layer_key = $1', [LAYER_B]);
      assert.deepEqual(bEntries.rows.map((r) => r.canonical), ['term gamma delta']);
    });
  });

  test('a suppression hides a shared entry for that tenant only; unsuppress restores it; both are audited on the tenant layer', async () => {
    await asService(db, async () => {
      const shared = await upsert(db, ADMIN_A, 'shared', entry(), 0);
      assert.ok((await effectiveIds(db, LAYER_A)).includes(shared.entry_id));

      const on = await suppress(db, ADMIN_A, LAYER_A, shared.entry_id, true, 0);
      assert.deepEqual([on.layer_version, on.suppressed], [1, true]);
      assert.ok(!(await effectiveIds(db, LAYER_A)).includes(shared.entry_id));
      assert.ok((await effectiveIds(db, LAYER_B)).includes(shared.entry_id));
      assert.equal(await versionOf(db, 'shared'), 1);

      const off = await suppress(db, ADMIN_A, LAYER_A, shared.entry_id, false, 1);
      assert.deepEqual([off.layer_version, off.suppressed], [2, false]);
      assert.ok((await effectiveIds(db, LAYER_A)).includes(shared.entry_id));

      const audit = await auditOf(db, LAYER_A);
      assert.deepEqual(audit.map((a) => [a.action, a.layer_version, a.entry_id]), [
        ['suppress', 1, shared.entry_id],
        ['unsuppress', 2, shared.entry_id],
      ]);
      assert.equal(audit[0]?.after?.suppresses_entry_id, shared.entry_id);
      assert.equal(audit[1]?.after, null);

      await rejectsCode(db, () => suppress(db, ADMIN_A, LAYER_B, shared.entry_id, true, 0), 'not_admin_of_layer');
      const tenantEntry = await upsert(db, ADMIN_B, LAYER_B, entry(), 0);
      await rejectsCode(db, () => suppress(db, ADMIN_A, LAYER_A, tenantEntry.entry_id, true, 2), 'not_found');
      await rejectsCode(db, () => suppress(db, ADMIN_A, 'shared', shared.entry_id, true, 1), 'invalid_entry');
    });
  });

  test('deleting a suppressed shared entry audits the tenant suppression it removes and bumps that tenant layer', async () => {
    await asService(db, async () => {
      const shared = await upsert(db, ADMIN_A, 'shared', entry(), 0);
      await suppress(db, ADMIN_B, LAYER_B, shared.entry_id, true, 0);
      assert.equal(await versionOf(db, LAYER_B), 1);
      const shaBefore = (await layerRow(db, LAYER_B))?.entries_sha256;

      await remove(db, ADMIN_A, 'shared', shared.entry_id, 1);
      assert.equal(await entryCount(db, LAYER_B), 0);
      assert.equal(await versionOf(db, LAYER_B), 2);
      assert.notEqual((await layerRow(db, LAYER_B))?.entries_sha256, shaBefore);
      const audit = await auditOf(db, LAYER_B);
      assert.deepEqual(audit.map((a) => [a.action, a.layer_version, a.entry_id, a.actor]), [
        ['suppress', 1, shared.entry_id, ADMIN_B],
        ['unsuppress', 2, shared.entry_id, ADMIN_A],
      ]);
    });
  });

  test('a stale expected version raises version_conflict and writes nothing', async () => {
    await asService(db, async () => {
      const created = await upsert(db, ADMIN_A, 'shared', entry(), 0);
      await rejectsCode(db, () => upsert(db, ADMIN_A, 'shared', entry({ canonical: 'term gamma delta' }), 0), 'version_conflict');
      await rejectsCode(db, () => upsert(db, ADMIN_A, 'shared', entry({ id: created.entry_id, note: 'n' }), 2), 'version_conflict');
      await rejectsCode(db, () => remove(db, ADMIN_A, 'shared', created.entry_id, 0), 'version_conflict');
      await rejectsCode(db, () => suppress(db, ADMIN_A, LAYER_A, created.entry_id, true, 3), 'version_conflict');
      await rejectsCode(db, () => importRows(db, ADMIN_A, 'shared', [entry({ canonical: 'term gamma delta' })], 'merge', 5), 'version_conflict');
      assert.equal(await versionOf(db, 'shared'), 1);
      assert.equal(await layerRow(db, LAYER_A), undefined);
      assert.equal((await auditOf(db, 'shared')).length, 1);
      assert.equal(await entryCount(db, 'shared'), 1);
    });
  });

  test('version_conflict carries the current version in its detail', async () => {
    await asService(db, async () => {
      await upsert(db, ADMIN_A, 'shared', entry(), 0);
      await db.exec('SAVEPOINT detail');
      await assert.rejects(
        () => upsert(db, ADMIN_A, 'shared', entry({ canonical: 'term gamma delta' }), 0),
        (error: unknown) => {
          assert.equal((error as Error).message, 'version_conflict');
          assert.deepEqual(JSON.parse(String((error as { detail?: string }).detail)), { current_version: 1 });
          return true;
        },
      );
      await db.exec('ROLLBACK TO SAVEPOINT detail');
    });
  });

  test('entries_sha256 changes on every content change and is equal for equal content', async () => {
    await asService(db, async () => {
      const created = await upsert(db, ADMIN_A, 'shared', entry(), 0);
      const first = created.entries_sha256;
      assert.equal(first, (await layerRow(db, 'shared'))?.entries_sha256);
      const changed = await upsert(db, ADMIN_A, 'shared', entry({ id: created.entry_id, note: 'note one' }), 1);
      assert.notEqual(changed.entries_sha256, first);
      const reverted = await upsert(db, ADMIN_A, 'shared', entry({ id: created.entry_id }), 2);
      assert.equal(reverted.entries_sha256, first);

      const deleted = await remove(db, ADMIN_A, 'shared', created.entry_id, 3);
      assert.notEqual(deleted.entries_sha256, first);
      const recreated = await upsert(db, ADMIN_A, 'shared', entry(), 4);
      assert.equal(recreated.entries_sha256, first);

      const tenantCopy = await upsert(db, ADMIN_A, LAYER_A, entry(), 0);
      assert.notEqual(tenantCopy.entries_sha256, first, 'the layer key is part of the hashed content');
    });
  });

  test('a translation pair is created, updated and deleted with the same versions and audit, its languages in the audit JSON', async () => {
    await asService(db, async () => {
      const created = await upsert(db, ADMIN_A, 'shared', translationPair(), 0);
      assert.equal(created.layer_version, 1);
      const stored = await db.query<{ source_language: string; target_language: string; kind: string; mode: string }>(
        'SELECT source_language, target_language, kind, mode FROM public.rag_term_entries WHERE id = $1',
        [created.entry_id],
      );
      assert.deepEqual(stored.rows[0], { source_language: LANG_1, target_language: LANG_2, kind: 'translation', mode: 'one_way' });

      const updated = await upsert(db, ADMIN_A, 'shared', translationPair({ id: created.entry_id, target_language: LANG_3 }), 1);
      assert.equal(updated.layer_version, 2);
      assert.notEqual(updated.entries_sha256, created.entries_sha256);
      await remove(db, ADMIN_A, 'shared', created.entry_id, 2);

      const audit = await auditOf(db, 'shared');
      assert.deepEqual(audit.map((a) => a.action), ['create', 'update', 'delete']);
      assert.deepEqual([audit[0]?.after?.source_language, audit[0]?.after?.target_language], [LANG_1, LANG_2]);
      assert.deepEqual([audit[1]?.before?.target_language, audit[1]?.after?.target_language], [LANG_2, LANG_3]);
      assert.deepEqual([audit[2]?.before?.source_language, audit[2]?.before?.target_language], [LANG_1, LANG_3]);
    });
  });

  test('an entry the table CHECKs or the writer rules reject raises invalid_entry and writes nothing', async () => {
    await asService(db, async () => {
      await upsert(db, ADMIN_A, 'shared', entry({ canonical: 'term gamma delta', variants: ['termgamma'], normalized_variants: ['termgamma'] }), 0);
      const bad: unknown[] = [
        entry({ target_language: LANG_2 }),
        translationPair({ target_language: LANG_1 }),
        translationPair({ mode: 'equivalent' }),
        entry({ kind: 'unknown_kind' }),
        entry({ language: 'Not A Code' }),
        entry({ normalized_variants: ['termalpha', 'alpha beta'] }),
        entry({ variants: ['x'.repeat(65)], normalized_variants: ['x'.repeat(65)] }),
        entry({ variants: [], normalized_variants: [] }),
        entry({ variants: [1], normalized_variants: ['1'] }),
        entry({ canonical: '' }),
        entry({ enabled: 'yes' }),
        entry({ canonical: 'term gamma delta' }),
        ['not', 'an', 'object'],
      ];
      for (const body of bad) {
        await rejectsCode(db, () => upsert(db, ADMIN_A, 'shared', body, 1), 'invalid_entry');
      }
      assert.equal(await versionOf(db, 'shared'), 1);
      assert.equal(await entryCount(db, 'shared'), 1);
      assert.equal((await auditOf(db, 'shared')).length, 1);
    });
  });

  test('normalized_variants are stored exactly as sent', async () => {
    await asService(db, async () => {
      const created = await upsert(db, ADMIN_A, 'shared', entry({ variants: ['TermAlpha', 'Alpha  Beta'], normalized_variants: ['termalpha', 'alpha  beta'] }), 0);
      const stored = await db.query<{ variants: string[]; normalized_variants: string[] }>('SELECT variants, normalized_variants FROM public.rag_term_entries WHERE id = $1', [created.entry_id]);
      assert.deepEqual(stored.rows[0], { variants: ['TermAlpha', 'Alpha  Beta'], normalized_variants: ['termalpha', 'alpha  beta'] });
    });
  });
});

describe('terminology import and admin reads 0472 (multi-tenant)', () => {
  let db: PGlite;

  before(async () => {
    db = (await createEmptyFixtureDatabase({ deploymentMode: 'multi-tenant' })).db;
    await seedActors(db, 'multi-tenant');
  });

  after(async () => {
    await db?.close();
  });

  const three = (): Json[] => [
    entry(),
    entry({ canonical: 'term gamma delta', variants: ['termgamma'], normalized_variants: ['termgamma'] }),
    translationPair({ canonical: 'termine alfa beta', variants: ['术语丁戊己'], normalized_variants: ['术语丁戊己'] }),
  ];

  test('merge on an empty layer creates every row in one version with one import audit row each', async () => {
    await asService(db, async () => {
      const result = await importRows(db, ADMIN_A, LAYER_A, three(), 'merge', 0);
      assert.deepEqual([result.layer_version, result.created, result.updated, result.unchanged, result.deleted], [1, 3, 0, 0, 0]);
      const audit = await auditOf(db, LAYER_A);
      assert.equal(audit.length, 3);
      assert.ok(audit.every((a) => a.action === 'import' && a.layer_version === 1 && a.before === null && a.after !== null));
      assert.equal(await entryCount(db, LAYER_A), 3);
      assert.equal(result.entries_sha256, (await layerRow(db, LAYER_A))?.entries_sha256);
    });
  });

  test('one invalid row rejects the whole import and leaves the layer unchanged', async () => {
    await asService(db, async () => {
      await importRows(db, ADMIN_A, LAYER_A, three(), 'merge', 0);
      const rows = [...three().slice(0, 1), entry({ canonical: 'term new', variants: ['termnew', 'alpha'], normalized_variants: ['termnew'] })];
      await rejectsCode(db, () => importRows(db, ADMIN_A, LAYER_A, rows, 'merge', 1), 'invalid_entry');
      await rejectsCode(db, () => importRows(db, ADMIN_A, LAYER_A, [entry({ canonical: 'term new' }), entry({ target_language: LANG_2 })], 'replace', 1), 'invalid_entry');
      await rejectsCode(db, () => importRows(db, ADMIN_A, LAYER_A, [entry(), entry()], 'merge', 1), 'invalid_entry');
      await db.exec('SAVEPOINT row_detail');
      await assert.rejects(
        () => importRows(db, ADMIN_A, LAYER_A, [entry({ canonical: 'term new' }), entry({ canonical: 'term other', target_language: LANG_2 })], 'merge', 1),
        (error: unknown) => {
          assert.equal((error as Error).message, 'invalid_entry');
          assert.deepEqual(JSON.parse(String((error as { detail?: string }).detail)), { row: 2 });
          return true;
        },
      );
      await db.exec('ROLLBACK TO SAVEPOINT row_detail');
      await rejectsCode(db, () => importRows(db, ADMIN_A, LAYER_A, three(), 'append', 1), 'invalid_entry');
      await rejectsCode(db, () => importRows(db, ADMIN_A, LAYER_A, { rows: [] }, 'merge', 1), 'invalid_entry');
      assert.equal(await versionOf(db, LAYER_A), 1);
      assert.equal(await entryCount(db, LAYER_A), 3);
      assert.equal((await auditOf(db, LAYER_A)).length, 3);
    });
  });

  test('replace deletes entries absent from the file and audits each delete; unchanged rows write no audit row', async () => {
    await asService(db, async () => {
      await importRows(db, ADMIN_A, LAYER_A, three(), 'merge', 0);
      const result = await importRows(db, ADMIN_A, LAYER_A, three().slice(0, 1), 'replace', 1);
      assert.deepEqual([result.layer_version, result.created, result.updated, result.unchanged, result.deleted], [2, 0, 0, 1, 2]);
      assert.equal(await entryCount(db, LAYER_A), 1);
      const audit = (await auditOf(db, LAYER_A)).filter((a) => a.layer_version === 2);
      assert.equal(audit.length, 2);
      assert.ok(audit.every((a) => a.action === 'import' && a.before !== null && a.after === null));
      assert.deepEqual(audit.map((a) => a.before?.canonical).sort(), ['term gamma delta', 'termine alfa beta']);
    });
  });

  test('replace on a tenant layer keeps its suppressions; replace on the shared layer audits the suppressions its deletes remove', async () => {
    await asService(db, async () => {
      const shared = await upsert(db, ADMIN_A, 'shared', entry({ canonical: 'term gamma delta', variants: ['termgamma'], normalized_variants: ['termgamma'] }), 0);
      await suppress(db, ADMIN_A, LAYER_A, shared.entry_id, true, 0);
      await importRows(db, ADMIN_A, LAYER_A, [entry()], 'replace', 1);
      assert.equal(await entryCount(db, LAYER_A), 2, 'the imported entry and the suppression');

      const result = await importRows(db, ADMIN_A, 'shared', [entry()], 'replace', 1);
      assert.deepEqual([result.created, result.deleted], [1, 1]);
      assert.equal(await entryCount(db, LAYER_A), 1);
      assert.equal(await versionOf(db, LAYER_A), 3);
      const last = (await auditOf(db, LAYER_A)).at(-1);
      assert.deepEqual([last?.action, last?.entry_id, last?.layer_version], ['unsuppress', shared.entry_id, 3]);
    });
  });

  test('the merge key is language, target language and lower(canonical)', async () => {
    await asService(db, async () => {
      const pairs = [translationPair({ target_language: LANG_2 }), translationPair({ target_language: LANG_3 })];
      const first = await importRows(db, ADMIN_A, 'shared', pairs, 'merge', 0);
      assert.equal(first.created, 2);
      assert.equal(await entryCount(db, 'shared'), 2);

      const again = await importRows(
        db,
        ADMIN_A,
        'shared',
        [translationPair({ canonical: 'TERM Alpha Beta', target_language: LANG_2, note: 'changed' }), translationPair({ target_language: LANG_3 })],
        'merge',
        1,
      );
      assert.deepEqual([again.created, again.updated, again.unchanged, again.deleted], [0, 1, 1, 0]);
      assert.equal(await entryCount(db, 'shared'), 2);
      const audit = (await auditOf(db, 'shared')).filter((a) => a.layer_version === 2);
      assert.equal(audit.length, 1);
      assert.equal(audit[0]?.before?.canonical, 'term alpha beta');
      assert.equal(audit[0]?.after?.canonical, 'TERM Alpha Beta');
      assert.equal(audit[0]?.after?.target_language, LANG_2);
    });
  });

  test('more than 5,000 rows, or a layer that would pass 20,000 entries, is refused with limit', async () => {
    await asService(db, async () => {
      const many = Array.from({ length: 5001 }, (_, i) => entry({ canonical: `term ${i}`, variants: [`termalpha${i}`], normalized_variants: [`termalpha${i}`] }));
      await rejectsCode(db, () => importRows(db, ADMIN_A, LAYER_A, many, 'merge', 0), 'limit');

      await db.exec('RESET ROLE');
      await db.exec(`
        INSERT INTO public.rag_term_layers (layer_key, version) VALUES ('${LAYER_A}', 1);
        INSERT INTO public.rag_term_entries (layer_key, canonical, variants, normalized_variants, language, kind)
        SELECT '${LAYER_A}', 'term ' || i, ARRAY['termalpha' || i], ARRAY['termalpha' || i], 'any', 'synonym' FROM generate_series(1, 19999) AS i;
      `);
      await db.exec('SET LOCAL ROLE service_role');
      const two = [entry({ canonical: 'term new one' }), entry({ canonical: 'term new two' })];
      await rejectsCode(db, () => importRows(db, ADMIN_A, LAYER_A, two, 'merge', 1), 'limit');
      const one = await upsert(db, ADMIN_A, LAYER_A, entry({ canonical: 'term new three' }), 1);
      assert.equal(one.layer_version, 2);
      await rejectsCode(db, () => upsert(db, ADMIN_A, LAYER_A, entry({ canonical: 'term new four' }), 2), 'limit');
      assert.equal(await entryCount(db, LAYER_A), 20000);
    });
  });

  test('rag_term_list_entries paginates, searches canonical and variants case-insensitively and returns total_count', async () => {
    await asService(db, async () => {
      await importRows(db, ADMIN_A, LAYER_A, three(), 'merge', 0);
      const list = async (limit: number, offset: number, search: string | null) =>
        (
          await db.query<{ canonical: string; total_count: number; layer_version: number; source_language: string | null }>(
            'SELECT canonical, total_count::int AS total_count, layer_version::int AS layer_version, source_language FROM public.rag_term_list_entries(p_actor => $1, p_layer_key => $2, p_limit => $3, p_offset => $4, p_search => $5)',
            [ADMIN_A, LAYER_A, limit, offset, search],
          )
        ).rows;
      const page1 = await list(2, 0, null);
      const page2 = await list(2, 2, null);
      assert.equal(page1.length, 2);
      assert.equal(page2.length, 1);
      assert.ok([...page1, ...page2].every((r) => r.total_count === 3 && r.layer_version === 1));
      assert.equal(new Set([...page1, ...page2].map((r) => r.canonical)).size, 3);

      assert.deepEqual((await list(50, 0, 'GAMMA')).map((r) => r.canonical), ['term gamma delta']);
      assert.deepEqual((await list(50, 0, 'TermGam')).map((r) => r.canonical), ['term gamma delta']);
      assert.deepEqual((await list(50, 0, '丁戊')).map((r) => [r.canonical, r.source_language]), [['termine alfa beta', LANG_1]]);
      assert.deepEqual(await list(50, 0, '%'), []);

      await rejectsCode(db, () => db.query('SELECT * FROM public.rag_term_list_entries($1, $2, 50, 0, NULL)', [ADMIN_A, LAYER_B]), 'not_admin_of_layer');
      await rejectsCode(db, () => db.query('SELECT * FROM public.rag_term_list_entries($1, $2, 50, 0, NULL)', [NON_ADMIN, 'shared']), 'not_admin');
    });
  });

  test('rag_term_list_audit returns newest first with actor ids only', async () => {
    await asService(db, async () => {
      const created = await upsert(db, ADMIN_A, LAYER_A, entry(), 0);
      await upsert(db, ADMIN_A, LAYER_A, entry({ id: created.entry_id, note: 'n' }), 1);
      await remove(db, ADMIN_A, LAYER_A, created.entry_id, 2);
      const result = await db.query<Json>('SELECT * FROM public.rag_term_list_audit(p_actor => $1, p_layer_key => $2, p_limit => $3, p_offset => $4)', [ADMIN_A, LAYER_A, 2, 0]);
      assert.deepEqual(result.rows.map((r) => [r.action, Number(r.layer_version), Number(r.total_count)]), [
        ['delete', 3, 3],
        ['update', 2, 3],
      ]);
      const columns = result.fields.map((f) => f.name);
      assert.ok(columns.includes('actor'));
      assert.ok(!columns.some((c) => /email/i.test(c)));
      assert.ok(!JSON.stringify(result.rows).includes('@example.invalid'));
      await rejectsCode(db, () => db.query('SELECT * FROM public.rag_term_list_audit($1, $2, 50, 0)', [ADMIN_B, LAYER_A]), 'not_admin_of_layer');
    });
  });

  test('anon and authenticated cannot execute any 0472 function; the internal helpers are invokers with no grant at all', async () => {
    const helpers = await db.query<{ sig: string }>(
      "SELECT p.oid::regprocedure::text AS sig FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname LIKE 'rag\\_term\\_\\_%'",
    );
    assert.ok(helpers.rows.length >= 2, 'the internal helpers exist');
    for (const signature of PUBLIC_FUNCTIONS) {
      const privileges = await db.query<{ anon: boolean; authenticated: boolean; service: boolean; definer: boolean; config: string[] | null }>(
        `SELECT has_function_privilege('anon', $1, 'EXECUTE') AS anon, has_function_privilege('authenticated', $1, 'EXECUTE') AS authenticated,
                has_function_privilege('service_role', $1, 'EXECUTE') AS service, p.prosecdef AS definer, p.proconfig AS config
           FROM pg_catalog.pg_proc p WHERE p.oid = $1::regprocedure`,
        [signature],
      );
      assert.deepEqual(privileges.rows[0], { anon: false, authenticated: false, service: true, definer: true, config: ['search_path=""'] }, signature);
    }
    for (const { sig } of helpers.rows) {
      const privileges = await db.query<{ anon: boolean; authenticated: boolean; service: boolean; definer: boolean }>(
        "SELECT has_function_privilege('anon', $1, 'EXECUTE') AS anon, has_function_privilege('authenticated', $1, 'EXECUTE') AS authenticated, has_function_privilege('service_role', $1, 'EXECUTE') AS service, p.prosecdef AS definer FROM pg_catalog.pg_proc p WHERE p.oid = $1::regprocedure",
        [`public.${sig.replace(/^public\./, '')}`],
      );
      assert.deepEqual(privileges.rows[0], { anon: false, authenticated: false, service: false, definer: false }, sig);
    }

    let edge: FakeEdge | undefined;
    try {
      edge = await startFakeEdge({ db, serviceKeys: [SERVICE_KEY], anonKey: ANON_KEY });
      const calls: [string, Json][] = [
        ['rag_term_upsert_entry', { p_actor: ADMIN_A, p_layer_key: 'shared', p_entry: entry(), p_expected_version: 0 }],
        ['rag_term_delete_entry', { p_actor: ADMIN_A, p_layer_key: 'shared', p_entry_id: ADMIN_A, p_expected_version: 0 }],
        ['rag_term_set_suppression', { p_actor: ADMIN_A, p_layer_key: LAYER_A, p_shared_entry_id: ADMIN_A, p_suppressed: true, p_expected_version: 0 }],
        ['rag_term_apply_import', { p_actor: ADMIN_A, p_layer_key: 'shared', p_rows: [entry()], p_mode: 'merge', p_expected_version: 0 }],
        ['rag_term_list_entries', { p_actor: ADMIN_A, p_layer_key: 'shared', p_limit: 10, p_offset: 0, p_search: null }],
        ['rag_term_list_audit', { p_actor: ADMIN_A, p_layer_key: 'shared', p_limit: 10, p_offset: 0 }],
      ];
      for (const [name, body] of calls) {
        const res = await fetch(`${edge.url}/rest/v1/rpc/${name}`, {
          method: 'POST',
          headers: { apikey: ANON_KEY, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        assert.equal(res.status, 403, name);
        assert.equal(((await res.json()) as { code?: string }).code, '42501', name);
      }
      const listed = await fetch(`${edge.url}/rest/v1/rpc/rag_term_list_entries`, {
        method: 'POST',
        headers: { apikey: SERVICE_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ p_actor: ADMIN_A, p_layer_key: 'shared', p_limit: 10, p_offset: 0, p_search: null }),
      });
      assert.equal(listed.status, 200);
      assert.equal(await versionOf(db, 'shared'), 0);
    } finally {
      await edge?.close();
    }
  });

  test('applying 0472 a second time succeeds and keeps the grants', async () => {
    const sql = fs.readFileSync(path.join(REPO_ROOT, MIGRATION), 'utf8');
    await db.exec(sql);
    await db.exec(sql);
    const privileges = await db.query<{ anon: boolean; service: boolean }>(
      "SELECT has_function_privilege('anon', 'public.rag_term_upsert_entry(uuid, text, jsonb, bigint)', 'EXECUTE') AS anon, has_function_privilege('service_role', 'public.rag_term_upsert_entry(uuid, text, jsonb, bigint)', 'EXECUTE') AS service",
    );
    assert.deepEqual(privileges.rows[0], { anon: false, service: true });
  });
});

describe('terminology writers 0472 (single-tenant): the shared layer only', () => {
  let db: PGlite;

  before(async () => {
    db = (await createEmptyFixtureDatabase({ deploymentMode: 'single-tenant' })).db;
    await seedActors(db, 'single-tenant');
  });

  after(async () => {
    await db?.close();
  });

  test('every writer and read refuses the workspace layer with workspace_layer_unavailable', async () => {
    await asService(db, async () => {
      const shared = await upsert(db, ADMIN_A, 'shared', entry(), 0);
      assert.equal(shared.layer_version, 1);
      await rejectsCode(db, () => upsert(db, ADMIN_A, 's:default', entry(), 0), 'workspace_layer_unavailable');
      await rejectsCode(db, () => remove(db, ADMIN_A, 's:default', shared.entry_id, 0), 'workspace_layer_unavailable');
      await rejectsCode(db, () => suppress(db, ADMIN_A, 's:default', shared.entry_id, true, 0), 'workspace_layer_unavailable');
      await rejectsCode(db, () => importRows(db, ADMIN_A, 's:default', [entry()], 'merge', 0), 'workspace_layer_unavailable');
      await rejectsCode(db, () => db.query('SELECT * FROM public.rag_term_list_entries($1, $2, 50, 0, NULL)', [ADMIN_A, 's:default']), 'workspace_layer_unavailable');
      await rejectsCode(db, () => db.query('SELECT * FROM public.rag_term_list_audit($1, $2, 50, 0)', [ADMIN_A, 's:default']), 'workspace_layer_unavailable');
      await rejectsCode(db, () => upsert(db, NON_ADMIN, 'shared', entry(), 1), 'not_admin');
      assert.equal(await layerRow(db, 's:default'), undefined);
      assert.equal(await entryCount(db, 's:default'), 0);
    });
  });

  test('the shared layer works end to end: write, import, translation pair, list, audit', async () => {
    await asService(db, async () => {
      const pair = await upsert(db, ADMIN_B, 'shared', translationPair(), 0);
      const imported = await importRows(db, ADMIN_A, 'shared', [entry(), translationPair()], 'merge', 1);
      assert.deepEqual([imported.layer_version, imported.created, imported.unchanged], [2, 1, 1]);
      await remove(db, ADMIN_A, 'shared', pair.entry_id, 2);
      const listed = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.rag_term_list_entries($1, $2, 50, 0, NULL)', [ADMIN_A, 'shared']);
      assert.equal(listed.rows[0]?.n, 1);
      const audit = await db.query<{ action: string }>('SELECT action FROM public.rag_term_list_audit($1, $2, 50, 0)', [ADMIN_B, 'shared']);
      assert.deepEqual(audit.rows.map((r) => r.action), ['delete', 'import', 'create']);
      assert.deepEqual(await effectiveIds(db, 's:default'), (await db.query<{ id: string }>("SELECT id::text AS id FROM public.rag_term_entries WHERE layer_key = 'shared'")).rows.map((r) => r.id));
    });
  });
});
