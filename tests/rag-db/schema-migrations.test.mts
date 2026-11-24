import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createFixtureDatabase, type DeploymentMode, type FixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { applyMigrationFiles, applyMigrations, migrationFiles } from '../../eval/harness/migrations.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REAL_CORPUS = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];

const DOCUMENT_COLUMNS = [
  'lineage_id',
  'source_key',
  'version',
  'is_current',
  'superseded_by',
  'status',
  'processing_status',
  'processing_state',
  'doc_type',
  'doc_type_origin',
  'doc_date',
  'language',
  'file_sha256',
  'content_hash',
  'parser_used',
  'parser_version',
  'processing_profile_id',
  'processing_profile_version',
  'original_path',
  'tenant_key',
];

async function withFixture<T>(
  mode: DeploymentMode,
  options: { migrations: boolean },
  run: (fixture: FixtureDatabase) => Promise<T>,
): Promise<T> {
  const fixture = await createFixtureDatabase({ deploymentMode: mode, corpusDir: REAL_CORPUS, migrations: options.migrations });
  try {
    return await run(fixture);
  } finally {
    await fixture.db.close();
  }
}

async function columnsOf(db: PGlite, table: string): Promise<string[]> {
  const result = await db.query<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY column_name",
    [table],
  );
  return result.rows.map((row) => row.column_name);
}

async function assertHasColumns(db: PGlite, table: string, expected: string[]): Promise<void> {
  const present = new Set(await columnsOf(db, table));
  assert.deepEqual(
    expected.filter((name) => !present.has(name)),
    [],
    `${table} is missing columns`,
  );
}

async function tryQuery(db: PGlite, sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await db.query(sql, params);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function legacyId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

interface LegacyDocument {
  id: string;
  source: string | null;
  sourceProvider?: string | null;
  sourceFileId?: string | null;
  createdAt?: string;
}

async function insertLegacyDocument(fixture: FixtureDatabase, mode: DeploymentMode, doc: LegacyDocument): Promise<void> {
  const common = [doc.id, `${doc.id}.md`, 'legacy content', doc.source, doc.sourceProvider ?? null, doc.sourceFileId ?? null, doc.createdAt ?? '2025-01-01T00:00:00.000Z'];
  if (mode === 'multi-tenant') {
    await fixture.db.query(
      'INSERT INTO documents (id, filename, content, source, source_provider, source_file_id, created_at, user_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [...common, fixture.fixtureUserId],
    );
  } else {
    await fixture.db.query(
      'INSERT INTO documents (id, filename, content, source, source_provider, source_file_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      common,
    );
  }
}

async function dropSourceCheck(db: PGlite): Promise<void> {
  const found = await db.query<{ conname: string }>(
    "SELECT conname FROM pg_constraint WHERE conrelid = 'public.documents'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%source%'",
  );
  assert.ok(found.rows.length >= 1, 'the committed setup file has a CHECK on documents.source');
  for (const row of found.rows) await db.exec(`ALTER TABLE documents DROP CONSTRAINT "${row.conname}"`);
}

function migrationOrderKey(file: string): [string, number] {
  const name = path.basename(file).replace(/\.sql$/, '');
  const match = /^(.*?)(\.(?:single|multi)-tenant)?$/.exec(name);
  return [match?.[1] ?? name, match?.[2] ? 1 : 0];
}

const throughMigration = (files: string[], last: string): string[] => files.filter((file) => migrationOrderKey(file)[0].slice(0, 4) <= last);

describe('migration loader', () => {
  test('lists the common files and the files of the mode, common first within one migration, never the other mode', () => {
    for (const mode of MODES) {
      const other = mode === 'single-tenant' ? 'multi-tenant' : 'single-tenant';
      const files = migrationFiles(mode);
      assert.deepEqual(files.slice(0, 4), [
        'supabase/migrations/0301_documents_versions.sql',
        `supabase/migrations/0301_documents_versions.${mode}.sql`,
        'supabase/migrations/0302_documents_source.sql',
        'supabase/migrations/0303_documents_identity.sql',
      ]);
      assert.ok(files.every((file) => !file.endsWith(`.${other}.sql`)));
      for (let index = 1; index < files.length; index += 1) {
        const [previousStem, previousRank] = migrationOrderKey(files[index - 1] as string);
        const [stem, rank] = migrationOrderKey(files[index] as string);
        assert.ok(previousStem < stem || (previousStem === stem && previousRank < rank), `${files[index - 1]} must sort before ${files[index]}`);
      }
    }
  });
});

for (const mode of MODES) {
  describe(`documents migrations (${mode})`, () => {
    test('existing rows become version 1, current, ready, general, own lineage, legacy parser, source_key legacy:<id>', async () => {
      await withFixture(mode, { migrations: false }, async ({ db }) => {
        await applyMigrations(db, mode);
        await assertHasColumns(db, 'documents', DOCUMENT_COLUMNS);
        const result = await db.query<{ total: number; expected: number }>(
          `SELECT count(*)::int AS total,
             count(*) FILTER (WHERE version = 1 AND is_current AND status = 'ready' AND doc_type = 'general' AND doc_type_origin = 'fallback'
               AND lineage_id = id AND parser_used = 'llamaparse' AND parser_version = 'legacy' AND source_key = 'legacy:' || id::text)::int AS expected
           FROM documents`,
        );
        const row = result.rows[0] as { total: number; expected: number };
        assert.ok(row.total > 0);
        assert.equal(row.expected, row.total);
      });
    });

    test('rows inserted by the fixture loader after the migrations carry the same defaults', async () => {
      await withFixture(mode, { migrations: true }, async ({ db }) => {
        await assertHasColumns(db, 'documents', DOCUMENT_COLUMNS);
        const result = await db.query<{ total: number; expected: number }>(
          `SELECT count(*)::int AS total,
             count(*) FILTER (WHERE version = 1 AND is_current AND status = 'ready' AND doc_type = 'general' AND doc_type_origin = 'fallback'
               AND lineage_id = id AND parser_used = 'llamaparse' AND parser_version = 'legacy')::int AS expected
           FROM documents`,
        );
        const row = result.rows[0] as { total: number; expected: number };
        assert.ok(row.total > 0);
        assert.equal(row.expected, row.total);
      });
    });

    test('0302 rewrites legacy source values and keeps the original in metadata.legacy_source', async () => {
      await withFixture(mode, { migrations: false }, async (fixture) => {
        await dropSourceCheck(fixture.db);
        await insertLegacyDocument(fixture, mode, { id: legacyId(1), source: 'upload' });
        await insertLegacyDocument(fixture, mode, { id: legacyId(2), source: 'google-drive', sourceFileId: 'drive-file-9' });
        await insertLegacyDocument(fixture, mode, { id: legacyId(3), source: 'nango', sourceProvider: 'notion' });
        await insertLegacyDocument(fixture, mode, { id: legacyId(4), source: 'scrape' });
        await insertLegacyDocument(fixture, mode, { id: legacyId(5), source: 'something-else' });
        await insertLegacyDocument(fixture, mode, { id: legacyId(6), source: null });
        await applyMigrations(fixture.db, mode);
        const result = await fixture.db.query<{ id: string; source: string; source_provider: string | null; legacy_source: string | null }>(
          "SELECT id, source, source_provider, metadata->>'legacy_source' AS legacy_source FROM documents WHERE id = ANY($1::uuid[]) ORDER BY id",
          [[1, 2, 3, 4, 5, 6].map(legacyId)],
        );
        assert.deepEqual(
          result.rows.map((row) => [row.source, row.source_provider, row.legacy_source]),
          [
            ['config_upload', null, 'upload'],
            ['nango', 'google-drive', 'google-drive'],
            ['nango', 'notion', null],
            ['scraper', null, 'scrape'],
            ['config_upload', null, 'something-else'],
            ['config_upload', null, null],
          ],
        );
      });
    });

    test('0302 leaves the widened CHECK and the config_upload default; scraper is accepted and an unknown value is rejected without the trigger', async () => {
      await withFixture(mode, { migrations: false }, async (fixture) => {
        await applyMigrationFiles(fixture.db, throughMigration(migrationFiles(mode), '0303'));
        const insert = (source: string, n: number) =>
          mode === 'multi-tenant'
            ? tryQuery(fixture.db, 'INSERT INTO documents (id, filename, content, source, user_id) VALUES ($1, $2, $3, $4, $5)', [
                legacyId(n),
                `${n}.md`,
                'x',
                source,
                fixture.fixtureUserId,
              ])
            : tryQuery(fixture.db, 'INSERT INTO documents (id, filename, content, source) VALUES ($1, $2, $3, $4)', [legacyId(n), `${n}.md`, 'x', source]);
        assert.equal(await insert('scraper', 700), null);
        assert.match((await insert('bogus', 701)) ?? '', /documents_source_check/);
        const defaults = await fixture.db.query<{ column_default: string }>(
          "SELECT column_default FROM information_schema.columns WHERE table_name = 'documents' AND column_name = 'source'",
        );
        assert.match(defaults.rows[0]?.column_default ?? '', /config_upload/);
      });
    });

    test('0303 gives the newest Nango row its file id and older duplicates and uploads legacy:<id>; the lineage index is created', async () => {
      await withFixture(mode, { migrations: false }, async (fixture) => {
        await insertLegacyDocument(fixture, mode, { id: legacyId(11), source: 'google-drive', sourceFileId: 'drive-file-1', createdAt: '2025-01-01T00:00:00.000Z' });
        await insertLegacyDocument(fixture, mode, { id: legacyId(12), source: 'google-drive', sourceFileId: 'drive-file-1', createdAt: '2025-02-01T00:00:00.000Z' });
        await insertLegacyDocument(fixture, mode, { id: legacyId(13), source: 'google-drive', sourceFileId: 'drive-file-2', createdAt: '2025-01-15T00:00:00.000Z' });
        await insertLegacyDocument(fixture, mode, { id: legacyId(14), source: 'upload' });
        await applyMigrations(fixture.db, mode);
        await assertHasColumns(fixture.db, 'documents', DOCUMENT_COLUMNS);
        const result = await fixture.db.query<{ id: string; source_key: string; is_current: boolean }>(
          'SELECT id, source_key, is_current FROM documents WHERE id = ANY($1::uuid[]) ORDER BY id',
          [[11, 12, 13, 14].map(legacyId)],
        );
        assert.deepEqual(
          result.rows.map((row) => [row.id, row.source_key, row.is_current]),
          [
            [legacyId(11), `legacy:${legacyId(11)}`, true],
            [legacyId(12), 'drive-file-1', true],
            [legacyId(13), 'drive-file-2', true],
            [legacyId(14), `legacy:${legacyId(14)}`, true],
          ],
        );
        const index = await fixture.db.query<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE tablename = 'documents' AND indexdef LIKE '%(tenant_key, source, source_key)%'");
        assert.equal(index.rows.length, 1);
        assert.match(index.rows[0]?.indexdef ?? '', /UNIQUE/);
        assert.match(index.rows[0]?.indexdef ?? '', /WHERE is_current/);
      });
    });

    test('applying all migrations a second time raises nothing and changes no row', async () => {
      await withFixture(mode, { migrations: false }, async (fixture) => {
        await dropSourceCheck(fixture.db);
        await insertLegacyDocument(fixture, mode, { id: legacyId(21), source: 'scrape', sourceFileId: 'https://example.invalid/a' });
        await insertLegacyDocument(fixture, mode, { id: legacyId(22), source: 'upload' });
        await applyMigrations(fixture.db, mode);
        await assertHasColumns(fixture.db, 'documents', DOCUMENT_COLUMNS);
        const rewritten = await fixture.db.query<{ source: string; source_key: string }>('SELECT source, source_key FROM documents WHERE id = $1', [legacyId(21)]);
        assert.deepEqual(rewritten.rows, [{ source: 'scraper', source_key: 'https://example.invalid/a' }]);
        const snapshot = async () =>
          (await fixture.db.query<{ doc: string }>('SELECT to_jsonb(d)::text AS doc FROM documents d ORDER BY id')).rows.map((row) => row.doc);
        const first = await snapshot();
        assert.ok(first.length > 2);
        assert.equal(await tryQuery(fixture.db, 'SELECT 1'), null);
        await applyMigrations(fixture.db, mode);
        assert.deepEqual(await snapshot(), first);
      });
    });
  });
}

describe('tenant_key on documents', () => {
  test('single-tenant rows are s:default', async () => {
    await withFixture('single-tenant', { migrations: true }, async ({ db }) => {
      await assertHasColumns(db, 'documents', ['tenant_key']);
      const result = await db.query<{ tenant_key: string }>('SELECT DISTINCT tenant_key FROM documents');
      assert.deepEqual(result.rows, [{ tenant_key: 's:default' }]);
    });
  });

  test('multi-tenant rows are u:<user_id> without an organization and o:<organization_id> with one', async () => {
    const fixture = await createTwoTenantDatabase();
    try {
      await assertHasColumns(fixture.db, 'documents', ['tenant_key']);
      const result = await fixture.db.query<{ id: string; tenant_key: string }>('SELECT id, tenant_key FROM documents WHERE id = ANY($1::uuid[]) ORDER BY id', [
        [TWO_TENANT_IDS.docA, TWO_TENANT_IDS.docB, TWO_TENANT_IDS.docO],
      ]);
      assert.deepEqual(
        result.rows.map((row) => [row.id, row.tenant_key]),
        [
          [TWO_TENANT_IDS.docA, `u:${TWO_TENANT_IDS.userA}`],
          [TWO_TENANT_IDS.docB, `u:${TWO_TENANT_IDS.userB}`],
          [TWO_TENANT_IDS.docO, `o:${TWO_TENANT_IDS.orgO}`],
        ],
      );
      const corpus = await fixture.db.query<{ n: number }>("SELECT count(*)::int AS n FROM documents WHERE tenant_key = $1", [`u:${fixture.fixtureUserId}`]);
      assert.ok((corpus.rows[0]?.n ?? 0) > 0);
    } finally {
      await fixture.db.close();
    }
  });
});
