import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadCorpus, type LoadedCorpus } from '../../eval/harness/corpus.mts';
import { FIXTURE_USER_ID, type FixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { buildIngestFixtureDatabase, isPrechunkedOnlyDocument } from '../../eval/harness/ingest-mode.mts';
import { itemRequestOptions, UnmappedFilterDocumentIdError } from '../../eval/harness/run-eval.mts';
import type { GoldenItem } from '../../src/lib/rag-eval/contracts.generated.ts';

const CORPUS_DIR = path.join(process.cwd(), 'eval/fixtures/corpus');

type Row = Record<string, unknown>;

async function idRows(fixture: FixtureDatabase): Promise<{ documents: Row[]; chunks: Row[] }> {
  const documents = await fixture.db.query<Row>(
    'SELECT id, lineage_id, filename, tenant_key, version FROM documents ORDER BY filename, version, id',
  );
  const chunks = await fixture.db.query<Row>(
    `SELECT c.id, c.document_id, d.filename, c.chunk_index
     FROM document_chunks c JOIN documents d ON d.id = c.document_id ORDER BY d.filename, c.chunk_index, c.id`,
  );
  return { documents: documents.rows, chunks: chunks.rows };
}

function filterItem(id: string, documentIds: string[]): GoldenItem {
  return {
    id,
    language: 'en',
    category: 'selective_filter',
    answerable: true,
    question: 'Which section names the first example value?',
    expected_answer: 'The first section names it.',
    gold_evidence: [],
    retrieval_filters: { document_ids: documentIds, current_only: true },
    conversation: [],
    evidence_language: null,
    provenance: 'synthetic_fixture',
    review_status: 'approved',
  } as unknown as GoldenItem;
}

function documentIdMap(fixture: FixtureDatabase): ReadonlyMap<string, string> {
  return new Map(Object.entries(fixture.ingestDocumentIds ?? {}));
}

describe('ingest fixture mode is deterministic and maps filter ids', () => {
  let corpus: LoadedCorpus;
  let first: FixtureDatabase;
  let second: FixtureDatabase;
  let multi: FixtureDatabase;

  before(async () => {
    corpus = loadCorpus(CORPUS_DIR);
    first = await buildIngestFixtureDatabase({ deploymentMode: 'single-tenant', corpusDir: CORPUS_DIR });
    await first.edge?.close();
    second = await buildIngestFixtureDatabase({ deploymentMode: 'single-tenant', corpusDir: CORPUS_DIR });
    await second.edge?.close();
    multi = await buildIngestFixtureDatabase({ deploymentMode: 'multi-tenant', corpusDir: CORPUS_DIR, includeTypedFixtures: false });
    await multi.edge?.close();
  });

  after(async () => {
    await first?.db.close();
    await second?.db.close();
    await multi?.db.close();
  });

  test('two ingest builds have identical ids', async () => {
    const a = await idRows(first);
    const b = await idRows(second);
    assert.ok(a.documents.length > 0 && a.chunks.length > 0);
    assert.deepEqual(b.documents, a.documents);
    assert.deepEqual(b.chunks, a.chunks);
    assert.deepEqual(second.ingestDocumentIds, first.ingestDocumentIds);
  });

  test('filter ids map to ingested documents', async () => {
    const map = documentIdMap(first);
    assert.equal(map.size, corpus.documents.length, 'every corpus document has a mapped id');
    for (const doc of corpus.documents) {
      const mapped = map.get(doc.id);
      assert.ok(mapped, `${doc.relpath} is mapped`);
      const { rows } = await first.db.query<Row>('SELECT filename, is_current, status FROM documents WHERE id = $1', [mapped]);
      assert.equal(rows.length, 1, `${doc.relpath} maps to a written document`);
      assert.equal(rows[0]?.filename, doc.filename);
      assert.equal(rows[0]?.is_current, true);
      if (!isPrechunkedOnlyDocument(doc.relpath)) assert.notEqual(mapped, doc.id, `${doc.relpath} was written by ingest()`);
    }
    const target = corpus.documents.find((doc) => !isPrechunkedOnlyDocument(doc.relpath));
    assert.ok(target);
    const options = itemRequestOptions({ max_results: 10 }, filterItem('synthetic-filter-001', [target.id]), map);
    assert.deepEqual(options.retrieval_filters, { document_ids: [map.get(target.id)], current_only: true });
    assert.equal(options.max_results, 10);
  });

  test('unmapped filter id fails the run', () => {
    const unknown = '00000000-0000-4000-8000-00000000f00d';
    const item = filterItem('synthetic-filter-002', [unknown]);
    assert.throws(
      () => itemRequestOptions({}, item, documentIdMap(first)),
      (error: unknown) =>
        error instanceof UnmappedFilterDocumentIdError &&
        error.itemId === 'synthetic-filter-002' &&
        error.documentId === unknown &&
        error.message.includes('synthetic-filter-002'),
    );
    assert.throws(() => itemRequestOptions({}, item, new Map()), UnmappedFilterDocumentIdError);
    assert.deepEqual(item.retrieval_filters, { document_ids: [unknown], current_only: true }, 'the golden item is not edited');
  });

  test('prechunked mode unchanged', () => {
    const golden = corpus.documents[0]!.id;
    const options = itemRequestOptions({}, filterItem('synthetic-filter-003', [golden]));
    assert.deepEqual(options.retrieval_filters, { document_ids: [golden], current_only: true });
  });

  test('multi-tenant ingest keeps its scope', async () => {
    const map = documentIdMap(multi);
    const ingested = corpus.documents.filter((doc) => !isPrechunkedOnlyDocument(doc.relpath));
    for (const doc of ingested) {
      const mapped = map.get(doc.id);
      assert.ok(mapped, `${doc.relpath} is mapped`);
      const { rows } = await multi.db.query<Row>('SELECT tenant_key FROM documents WHERE id = $1', [mapped]);
      assert.equal(rows[0]?.tenant_key, `u:${FIXTURE_USER_ID}`);
      assert.notEqual(mapped, first.ingestDocumentIds?.[doc.id], `${doc.relpath} id is derived per tenant`);
    }
  });
});
