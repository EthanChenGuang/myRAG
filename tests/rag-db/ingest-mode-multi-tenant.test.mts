import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadCorpus } from '../../eval/harness/corpus.mts';
import { FIXTURE_USER_ID, type FixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { buildIngestFixtureDatabase } from '../../eval/harness/ingest-mode.mts';

const CORPUS_DIR = path.join(process.cwd(), 'eval/fixtures/corpus');

describe('ingest fixture mode in a multi-tenant deployment', () => {
  let fixture: FixtureDatabase;

  before(async () => {
    fixture = await buildIngestFixtureDatabase({ deploymentMode: 'multi-tenant', corpusDir: CORPUS_DIR });
  });

  after(async () => {
    await fixture?.edge?.close();
    await fixture?.db.close();
  });

  test('every corpus document and chunk belongs to the personal tenant of the fixture user', async () => {
    const corpus = loadCorpus(CORPUS_DIR);
    const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'eval/fixtures/ingest/manifest.json'), 'utf8')) as {
      fixtures: unknown[];
    };
    const expectedDocuments = corpus.documents.length + manifest.fixtures.length;
    const documents = await fixture.db.query<{ filename: string; status: string; tenant_key: string; user_id: string }>(
      'SELECT filename, status, tenant_key, user_id FROM documents ORDER BY filename',
    );
    assert.equal(documents.rows.length, expectedDocuments);
    const corpusFilenames = new Set(corpus.documents.map((doc) => doc.filename));
    for (const row of documents.rows) {
      assert.equal(row.tenant_key, `u:${FIXTURE_USER_ID}`, row.filename);
      assert.equal(row.user_id, FIXTURE_USER_ID, row.filename);
      if (corpusFilenames.has(row.filename)) {
        assert.equal(row.status, 'ready', row.filename);
      } else {
        assert.ok(row.status === 'ready' || row.status === 'quarantined', row.filename);
      }
    }
    const chunks = await fixture.db.query<{ n: number }>("SELECT count(*)::int AS n FROM document_chunks WHERE tenant_key <> $1", [`u:${FIXTURE_USER_ID}`]);
    assert.equal(chunks.rows[0]?.n, 0);
  });
});
