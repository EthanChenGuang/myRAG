import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { loadCorpus } from '../../eval/harness/corpus.mts';
import { applyMigrations } from '../../eval/harness/migrations.mts';
import { createFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REAL_CORPUS = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const frozenSetup = (mode: DeploymentMode): string => `tests/fixtures/sql/pre-phase3-${mode}-setup.sql`;

const corpus = loadCorpus(REAL_CORPUS);
const byId = (a: [string, ...unknown[]], b: [string, ...unknown[]]): number => a[0].localeCompare(b[0]);
const corpusTypes = (): Array<[string, string]> => corpus.documents.map((doc): [string, string] => [doc.id, doc.docType]).sort(byId);

async function hasColumn(db: PGlite, table: string, column: string): Promise<boolean> {
  const result = await db.query<{ present: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2) AS present`,
    [table, column],
  );
  return result.rows[0]?.present === true;
}

async function documentTypes(db: PGlite): Promise<Array<[string, string]>> {
  const result = await db.query<{ id: string; doc_type: string }>('SELECT id, doc_type FROM documents ORDER BY id');
  return result.rows.map((row): [string, string] => [row.id, row.doc_type]).sort(byId);
}

async function chunkTypes(db: PGlite): Promise<Array<[string, string]>> {
  const result = await db.query<{ id: string; doc_type: string }>('SELECT id, doc_type FROM document_chunks ORDER BY id');
  return result.rows.map((row): [string, string] => [row.id, row.doc_type]).sort(byId);
}

function corpusChunkTypes(type?: string): Array<[string, string]> {
  return corpus.documents.flatMap((doc) => doc.chunks.map((chunk): [string, string] => [chunk.id, type ?? doc.docType])).sort(byId);
}

describe('prechunked fixture doc_type', () => {
  test('the corpus is typed: more than one doc_type, so an all-general load cannot pass for a typed one', () => {
    assert.ok(new Set(corpus.documents.map((doc) => doc.docType)).size > 1);
  });

  for (const mode of MODES) {
    for (const setup of [
      { label: 'with the migrations', migrations: true },
      { label: 'on the folded setup without the migrations', migrations: false },
    ]) {
      test(`${mode}: ${setup.label}, every document and chunk carries its corpus doc_type`, async () => {
        const fixture = await createFixtureDatabase({ deploymentMode: mode, corpusDir: REAL_CORPUS, migrations: setup.migrations });
        try {
          assert.deepEqual(await documentTypes(fixture.db), corpusTypes());
          assert.deepEqual(await chunkTypes(fixture.db), corpusChunkTypes());
        } finally {
          await fixture.db.close();
        }
      });
    }

    test(`${mode}: on the frozen pre-Phase-3 setup the corpus loads without doc_type, and the migrations make every row general`, async () => {
      const fixture = await createFixtureDatabase({ deploymentMode: mode, corpusDir: REAL_CORPUS, migrations: false, setupSqlPath: frozenSetup(mode) });
      try {
        assert.equal(await hasColumn(fixture.db, 'documents', 'doc_type'), false, 'the frozen setup predates documents.doc_type');
        assert.equal(await hasColumn(fixture.db, 'document_chunks', 'doc_type'), false, 'the frozen setup predates document_chunks.doc_type');
        const loaded = await fixture.db.query<{ id: string }>('SELECT id FROM documents ORDER BY id');
        assert.deepEqual(loaded.rows.map((row) => row.id), corpusTypes().map(([id]) => id), 'every corpus document was loaded');

        await applyMigrations(fixture.db, mode);
        assert.deepEqual(await documentTypes(fixture.db), corpusTypes().map(([id]): [string, string] => [id, 'general']));
        assert.deepEqual(await chunkTypes(fixture.db), corpusChunkTypes('general'));
      } finally {
        await fixture.db.close();
      }
    });
  }
});
