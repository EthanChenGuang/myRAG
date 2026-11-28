import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createFixtureDatabase, type DeploymentMode, type FixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { assertNoClientCallableRagFunctions } from '../helpers/rag-client-grants.ts';
import { loadCorpus } from '../../eval/harness/corpus.mts';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { applyMigrationFiles, applyMigrations, migrationFiles } from '../../eval/harness/migrations.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REAL_CORPUS = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const frozenSetup = (mode: DeploymentMode): string => `tests/fixtures/sql/pre-phase3-${mode}-setup.sql`;

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
  const fixture = await createFixtureDatabase({
    deploymentMode: mode,
    corpusDir: REAL_CORPUS,
    migrations: options.migrations,
    ...(options.migrations ? {} : { setupSqlPath: frozenSetup(mode) }),
  });
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

    test('rows inserted by the fixture loader after the migrations carry the column defaults and the doc_type of their corpus document', async () => {
      await withFixture(mode, { migrations: true }, async ({ db }) => {
        await assertHasColumns(db, 'documents', DOCUMENT_COLUMNS);
        const result = await db.query<{ id: string; doc_type: string; defaults: boolean }>(
          `SELECT id, doc_type,
             (version = 1 AND is_current AND status = 'ready' AND doc_type_origin = 'fallback'
               AND source = 'config_upload' AND processing_state = '{}'::jsonb) AS defaults
           FROM documents ORDER BY id`,
        );
        const expected = loadCorpus(REAL_CORPUS)
          .documents.map((doc) => [doc.id, doc.docType, true])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
        assert.ok(expected.length > 0);
        assert.deepEqual(
          result.rows.map((row) => [row.id, row.doc_type, row.defaults]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
          expected,
        );
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

const CHUNK_COLUMNS = [
  'tenant_key',
  'version',
  'is_current',
  'status',
  'doc_type',
  'doc_date',
  'language',
  'source',
  'page_start',
  'page_end',
  'section_path',
  'content_hash',
  'chunk_kind',
  'parser_used',
  'embedding_text_version',
  'lexical_text',
  'chunk_index',
];

const vectorLiteral = (text: string): string => `[${embedText(text).join(',')}]`;

async function insertDocument(
  fixture: FixtureDatabase,
  mode: DeploymentMode,
  doc: { id: string; source?: string | null; sourceProvider?: string; extra?: Record<string, unknown> },
): Promise<void> {
  const columns = ['id', 'filename', 'content'];
  const values: unknown[] = [doc.id, `${doc.id}.md`, 'legacy content'];
  if (doc.source !== undefined) {
    columns.push('source');
    values.push(doc.source);
  }
  if (doc.sourceProvider !== undefined) {
    columns.push('source_provider');
    values.push(doc.sourceProvider);
  }
  if (mode === 'multi-tenant') {
    columns.push('user_id');
    values.push(fixture.fixtureUserId);
  }
  for (const [name, value] of Object.entries(doc.extra ?? {})) {
    columns.push(name);
    values.push(value);
  }
  await fixture.db.query(`INSERT INTO documents (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`, values);
}

async function insertLegacyChunk(db: PGlite, chunk: { id: string; documentId: string; text: string; metadata?: Record<string, unknown> }): Promise<void> {
  await db.query('INSERT INTO document_chunks (id, document_id, content, embedding, metadata) VALUES ($1, $2, $3, $4::vector, $5::jsonb)', [
    chunk.id,
    chunk.documentId,
    chunk.text,
    vectorLiteral(chunk.text),
    JSON.stringify(chunk.metadata ?? {}),
  ]);
}

for (const mode of MODES) {
  describe(`chunk columns and legacy-compat triggers (${mode})`, () => {
    test('0304 backfills existing chunks from their document and stamps the legacy embedding model', async () => {
      await withFixture(mode, { migrations: false }, async (fixture) => {
        await insertDocument(fixture, mode, { id: legacyId(31), source: 'upload' });
        await insertLegacyChunk(fixture.db, { id: legacyId(32), documentId: legacyId(31), text: 'image caption', metadata: { image_url: 'https://example.invalid/a.png' } });
        await applyMigrations(fixture.db, mode);
        await assertHasColumns(fixture.db, 'document_chunks', CHUNK_COLUMNS);
        const result = await fixture.db.query<{ total: number; expected: number; images: number }>(
          `SELECT count(*)::int AS total,
             count(*) FILTER (WHERE dc.tenant_key = d.tenant_key AND dc.version = 1 AND dc.is_current AND dc.status = 'ready' AND dc.doc_type = 'general'
               AND dc.source = d.source AND dc.parser_used = 'llamaparse' AND dc.section_path = '{}'::text[] AND dc.embedding_text_version = 0
               AND dc.lexical_text IS NULL AND dc.content_hash IS NULL
               AND dc.chunk_kind = CASE WHEN dc.metadata->'image_url' IS NOT NULL THEN 'image' ELSE 'text' END
               AND dc.metadata->>'embedding_model' = 'text-embedding-3-small' AND (dc.metadata->>'embedding_dims')::int = 1536)::int AS expected,
             count(*) FILTER (WHERE dc.chunk_kind = 'image')::int AS images
           FROM document_chunks dc JOIN documents d ON d.id = dc.document_id`,
        );
        const row = result.rows[0] as { total: number; expected: number; images: number };
        assert.ok(row.total > 1);
        assert.equal(row.expected, row.total);
        assert.ok(row.images >= 1);
      });
    });

    test('a legacy chunk insert gets tenant_key, version, doc_type and source from its document', async () => {
      await withFixture(mode, { migrations: true }, async (fixture) => {
        await assertHasColumns(fixture.db, 'document_chunks', CHUNK_COLUMNS);
        await insertDocument(fixture, mode, { id: legacyId(41), source: 'nango', extra: { doc_type: 'contract_legal' } });
        await insertLegacyChunk(fixture.db, { id: legacyId(42), documentId: legacyId(41), text: 'legacy chunk without denormalised columns' });
        await insertLegacyChunk(fixture.db, { id: legacyId(43), documentId: legacyId(41), text: 'legacy image caption', metadata: { image_url: 'https://example.invalid/b.png' } });
        const result = await fixture.db.query<{ tenant_key: string; parent_key: string; version: number; doc_type: string; source: string; chunk_kind: string; is_current: boolean; status: string }>(
          `SELECT dc.tenant_key, d.tenant_key AS parent_key, dc.version, dc.doc_type, dc.source, dc.chunk_kind, dc.is_current, dc.status
           FROM document_chunks dc JOIN documents d ON d.id = dc.document_id WHERE dc.id = ANY($1::uuid[]) ORDER BY dc.id`,
          [[legacyId(42), legacyId(43)]],
        );
        assert.equal(result.rows.length, 2);
        for (const row of result.rows) {
          assert.equal(row.tenant_key, row.parent_key);
          assert.equal(row.version, 1);
          assert.equal(row.doc_type, 'contract_legal');
          assert.equal(row.source, 'nango');
          assert.equal(row.is_current, true);
          assert.equal(row.status, 'ready');
        }
        assert.deepEqual(
          result.rows.map((row) => row.chunk_kind),
          ['text', 'image'],
        );
      });
    });

    test('every legacy documents insert shape succeeds and comes out current, ready, own lineage, with a widened source', async () => {
      await withFixture(mode, { migrations: true }, async (fixture) => {
        const shapes: [number, string | null | undefined, string | undefined, string, string | null, string | null][] = [
          [51, 'upload', undefined, 'config_upload', null, 'upload'],
          [52, 'nango', undefined, 'nango', null, null],
          [53, 'scrape', undefined, 'scraper', null, 'scrape'],
          [54, 'google-drive', undefined, 'nango', 'google-drive', 'google-drive'],
          [55, undefined, undefined, 'config_upload', null, null],
          [56, 'bogus', undefined, 'config_upload', null, 'bogus'],
        ];
        const rejected: string[] = [];
        for (const [n, source, provider] of shapes) {
          try {
            await insertDocument(fixture, mode, { id: legacyId(n), source, ...(provider === undefined ? {} : { sourceProvider: provider }) });
          } catch (error) {
            rejected.push(`${String(source)}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        assert.deepEqual(rejected, [], 'legacy insert shapes are accepted');
        const nullability = await fixture.db.query<{ column_name: string; is_nullable: string }>(
          "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'documents' AND column_name IN ('lineage_id', 'source_key') ORDER BY column_name",
        );
        assert.deepEqual(
          nullability.rows.map((row) => [row.column_name, row.is_nullable]),
          [
            ['lineage_id', 'NO'],
            ['source_key', 'NO'],
          ],
        );
        const result = await fixture.db.query<{
          id: string;
          source: string;
          source_provider: string | null;
          legacy_source: string | null;
          is_current: boolean;
          status: string;
          own_lineage: boolean;
          source_key: string;
          parser_used: string;
          parser_version: string;
        }>(
          `SELECT id, source, source_provider, metadata->>'legacy_source' AS legacy_source, is_current, status, lineage_id = id AS own_lineage, source_key, parser_used, parser_version
           FROM documents WHERE id = ANY($1::uuid[]) ORDER BY id`,
          [shapes.map(([n]) => legacyId(n))],
        );
        assert.deepEqual(
          result.rows.map((row) => [row.source, row.source_provider, row.legacy_source]),
          shapes.map(([, , , source, provider, legacy]) => [source, provider, legacy]),
        );
        for (const row of result.rows) {
          assert.equal(row.is_current, true);
          assert.equal(row.status, 'ready');
          assert.equal(row.own_lineage, true);
          assert.equal(row.source_key, `legacy:${row.id}`);
          assert.equal(row.parser_used, 'llamaparse');
          assert.equal(row.parser_version, 'legacy');
        }
      });
    });

    test("a chunk's tenant_key always follows its document, and the trigger functions are not callable by anon or authenticated", async () => {
      await withFixture(mode, { migrations: true }, async (fixture) => {
        await insertDocument(fixture, mode, { id: legacyId(91) });
        await fixture.db.query('INSERT INTO document_chunks (id, document_id, content, embedding, tenant_key) VALUES ($1, $2, $3, $4::vector, $5)', [
          legacyId(92),
          legacyId(91),
          'chunk that claims another tenant',
          vectorLiteral('chunk that claims another tenant'),
          'o:00000000-0000-4000-8000-000000000999',
        ]);
        const result = await fixture.db.query<{ tenant_key: string; parent_key: string }>(
          'SELECT dc.tenant_key, d.tenant_key AS parent_key FROM document_chunks dc JOIN documents d ON d.id = dc.document_id WHERE dc.id = $1',
          [legacyId(92)],
        );
        assert.equal(result.rows[0]?.tenant_key, result.rows[0]?.parent_key);
        assert.notEqual(result.rows[0]?.tenant_key, 'o:00000000-0000-4000-8000-000000000999');
        await assertNoClientCallableRagFunctions(fixture.db);
        const defined = await fixture.db.query<{ proname: string }>("SELECT proname FROM pg_proc WHERE proname LIKE 'rag\_%' ORDER BY proname");
        const definedNames = defined.rows.map((row) => row.proname);
        for (const name of ['rag_chunks_legacy_defaults', 'rag_documents_legacy_defaults']) {
          assert.ok(definedNames.includes(name), `${name} is defined`);
        }
      });
    });

    test('a writer that supplies identity, parser and state keeps its values', async () => {
      await withFixture(mode, { migrations: true }, async (fixture) => {
        await insertDocument(fixture, mode, {
          id: legacyId(61),
          source: 'scraper',
          extra: { lineage_id: legacyId(60), source_key: 'https://example.invalid/page', version: 2, is_current: false, status: 'processing', parser_used: 'docling', parser_version: '2.0' },
        });
        const result = await fixture.db.query<{ lineage_id: string; source_key: string; version: number; is_current: boolean; status: string; parser_used: string; source: string }>(
          'SELECT lineage_id, source_key, version, is_current, status, parser_used, source FROM documents WHERE id = $1',
          [legacyId(61)],
        );
        assert.deepEqual(result.rows, [
          { lineage_id: legacyId(60), source_key: 'https://example.invalid/page', version: 2, is_current: false, status: 'processing', parser_used: 'docling', source: 'scraper' },
        ]);
      });
    });
  });
}

describe('legacy search functions only see current, ready chunks (D-08)', () => {
  type Search = { name: string; sql: string; params: unknown[]; idColumn: string };
  const queryVector = vectorLiteral('retrieval filter canary phrase');

  async function idsReturned(db: PGlite, search: Search, wanted: string[]): Promise<string[]> {
    const result = await db.query<Record<string, string>>(`SELECT ${search.idColumn} AS chunk FROM ${search.sql}`, search.params);
    const present = new Set(result.rows.map((row) => row.chunk));
    return wanted.filter((id) => present.has(id)).sort();
  }

  async function assertFiltered(db: PGlite, search: Search, chunkIds: [string, string, string]): Promise<void> {
    const [ready, notCurrent, quarantined] = chunkIds;
    const all = [...chunkIds].sort();
    await db.query('UPDATE document_chunks SET is_current = true, status = $2 WHERE id = ANY($1::uuid[])', [chunkIds, 'ready']);
    assert.deepEqual(await idsReturned(db, search, chunkIds), all, `${search.name} returns current ready chunks`);
    await db.query('UPDATE document_chunks SET is_current = false WHERE id = $1', [notCurrent]);
    await db.query("UPDATE document_chunks SET status = 'quarantined' WHERE id = $1", [quarantined]);
    assert.deepEqual(await idsReturned(db, search, chunkIds), [ready], `${search.name} hides non-current and quarantined chunks`);
    await db.query('UPDATE document_chunks SET is_current = true, status = $2 WHERE id = ANY($1::uuid[])', [chunkIds, 'ready']);
    assert.deepEqual(await idsReturned(db, search, chunkIds), all, `${search.name} returns the chunks again once they are current and ready`);
  }

  test('single-tenant: match_document_chunks, match_documents, match_document_chunks_optimized and search_chunks_by_keywords', async () => {
    await withFixture('single-tenant', { migrations: true }, async (fixture) => {
      await assertHasColumns(fixture.db, 'document_chunks', ['is_current', 'status']);
      await insertDocument(fixture, 'single-tenant', { id: legacyId(71) });
      const chunkIds: [string, string, string] = [legacyId(72), legacyId(73), legacyId(74)];
      for (const id of chunkIds) await insertLegacyChunk(fixture.db, { id, documentId: legacyId(71), text: 'retrieval filter canary phrase zzfiltercanaryzz' });
      const searches: Search[] = [
        { name: 'match_document_chunks', sql: 'match_document_chunks($1::vector, -2, 100000)', params: [queryVector], idColumn: 'chunk_id' },
        { name: 'match_documents', sql: 'match_documents($1::vector, 100000)', params: [queryVector], idColumn: 'id' },
        { name: 'match_document_chunks_optimized', sql: 'match_document_chunks_optimized($1::vector, -2, 100000)', params: [queryVector], idColumn: 'chunk_id' },
        { name: 'search_chunks_by_keywords', sql: "search_chunks_by_keywords('zzfiltercanaryzz', 100000)", params: [], idColumn: 'chunk_id' },
      ];
      for (const search of searches) await assertFiltered(fixture.db, search, chunkIds);
    });
  });

  test('multi-tenant: every match function that returns chunks', async () => {
    const fixture = await createTwoTenantDatabase();
    try {
      await assertHasColumns(fixture.db, 'document_chunks', ['is_current', 'status']);
      const userA = TWO_TENANT_IDS.userA;
      const orgO = TWO_TENANT_IDS.orgO;
      await fixture.db.query('INSERT INTO document_chunks (id, document_id, content, embedding, chunk_index, metadata, organization_id) VALUES ($1, $2, $3, $4::vector, 1, $5::jsonb, $6), ($7, $2, $3, $4::vector, 2, $5::jsonb, $6)', [
        legacyId(81),
        TWO_TENANT_IDS.docO,
        'retrieval filter canary phrase',
        queryVector,
        '{}',
        orgO,
        legacyId(82),
      ]);
      await fixture.db.query('INSERT INTO document_chunks (id, document_id, content, embedding, chunk_index, metadata) VALUES ($1, $2, $3, $4::vector, 1, $5::jsonb), ($6, $2, $3, $4::vector, 2, $5::jsonb)', [
        legacyId(83),
        TWO_TENANT_IDS.docA,
        'retrieval filter canary phrase',
        queryVector,
        '{}',
        legacyId(84),
      ]);
      const orgChunks: [string, string, string] = [TWO_TENANT_IDS.chunkO, legacyId(81), legacyId(82)];
      const personalChunks: [string, string, string] = [TWO_TENANT_IDS.chunkA, legacyId(83), legacyId(84)];
      const orgSearches: Search[] = [
        { name: 'match_documents_by_organization', sql: 'match_documents_by_organization($1::vector, -2, 100000, $2::uuid)', params: [queryVector, orgO], idColumn: 'id' },
        { name: 'match_documents_by_workspace (organization)', sql: 'match_documents_by_workspace($1::vector, 100000, -2, $2::uuid, $3::uuid)', params: [queryVector, orgO, userA], idColumn: 'id' },
        { name: 'match_document_chunks_by_org', sql: 'match_document_chunks_by_org($1::uuid, $2::vector, 100000, -2)', params: [orgO, queryVector], idColumn: 'chunk_id' },
      ];
      for (const search of orgSearches) await assertFiltered(fixture.db, search, orgChunks);
      await fixture.db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [userA]);
      const personalSearches: Search[] = [
        { name: 'match_documents_by_workspace (personal)', sql: 'match_documents_by_workspace($1::vector, 100000, -2, NULL::uuid, $2::uuid)', params: [queryVector, userA], idColumn: 'id' },
        { name: 'match_document_chunks', sql: 'match_document_chunks($1::vector, 100000, -2)', params: [queryVector], idColumn: 'chunk_id' },
      ];
      for (const search of personalSearches) await assertFiltered(fixture.db, search, personalChunks);
    } finally {
      await fixture.db.close();
    }
  });

  test('each replaced definition equals the setup definition plus exactly one is_current/status predicate', async () => {
    const fs = await import('node:fs');
    const extract = (sql: string, name: string): string => {
      const start = sql.search(new RegExp(`CREATE OR REPLACE FUNCTION (public\\.)?${name}\\(`));
      assert.ok(start >= 0, `${name} is defined`);
      const end = sql.indexOf('\n$$;', start);
      return sql.slice(start, end + 4);
    };
    const strip = (definition: string): string =>
      definition
        .split('\n')
        .filter((line) => !/\bis_current\b/i.test(line) && !/dc\.status\s*=\s*'ready'/i.test(line))
        .join('\n');
    const expectations: [DeploymentMode, string[]][] = [
      ['single-tenant', ['match_document_chunks', 'match_documents', 'match_document_chunks_optimized', 'search_chunks_by_keywords']],
      ['multi-tenant', ['match_documents_by_organization', 'match_documents_by_workspace', 'match_document_chunks', 'match_document_chunks_by_org']],
    ];
    for (const [mode, names] of expectations) {
      const setup = fs.readFileSync(path.join(REPO_ROOT, `supabase/${mode}-setup.sql`), 'utf8');
      const migrationPath = path.join(REPO_ROOT, `supabase/migrations/0306_retrieval_filters.${mode}.sql`);
      assert.ok(fs.existsSync(migrationPath), `${migrationPath} exists`);
      const migration = fs.readFileSync(migrationPath, 'utf8');
      for (const name of names) {
        const before = extract(setup, name);
        const after = extract(migration, name);
        assert.match(after, /dc\.is_current/i);
        assert.match(after, /dc\.status = 'ready'/i);
        assert.equal(strip(after), strip(before), `${name} differs from the setup definition beyond the added predicate`);
      }
    }
  });
});
