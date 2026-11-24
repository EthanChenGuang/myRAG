import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

type Row = Record<string, unknown>;

const MARKDOWN = [
  '# Warehouse Handbook',
  '',
  'Forklift batteries rotate every shift under the zebra quartz seventeen policy.',
  '',
  '## Receiving Dock',
  '',
  'Pallets arriving at the receiving dock are scanned by the night crew and staged beside bay four.',
  '',
  '## Shipping Cage',
  '',
  'Outbound pallets leave through the shipping cage after the supervisor signs the manifest.',
  '',
].join('\n');

const SECTION_QUERY = 'Pallets arriving at the receiving dock are scanned by the night crew and staged beside bay four.';
const OPTIONS = { maxResults: 25, fallbackToLowerThreshold: true };

describe('ingest tracer: one Markdown upload from ingest() to retrieval', () => {
  let fixture: TwoTenantDatabase;
  let edge: FakeEdge;
  let rag: typeof import('@/lib/rag');
  let ingestModule: typeof import('@/lib/rag/ingest');
  let runnerModule: typeof import('@/lib/rag/ingest/runner');
  let resolver: typeof import('@/lib/rag/tenant/resolve-chat');
  let supabaseModule: typeof import('@/lib/supabase');

  before(async () => {
    fixture = await createTwoTenantDatabase();
    edge = await startFakeEdge({ db: fixture.db });
    Object.assign(process.env, fixtureProcessEnv(edge.url));
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    process.env.MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    rag = await import('@/lib/rag');
    ingestModule = await import('@/lib/rag/ingest');
    runnerModule = await import('@/lib/rag/ingest/runner');
    resolver = await import('@/lib/rag/tenant/resolve-chat');
    supabaseModule = await import('@/lib/supabase');
  });

  after(async () => {
    await edge?.close();
    await fixture?.db.close();
  });

  const scopeOf = async (userId: string) => {
    const resolved = await resolver.resolveTenantScope({
      requestedOrganizationId: null,
      deploymentMode: 'multi-tenant',
      getUser: async () => ({ id: userId }),
      admin: supabaseModule.getSupabaseAdmin(),
      signal: new AbortController().signal,
    });
    assert.ok(resolved.ok && resolved.scope, 'scope must resolve');
    return resolved.scope;
  };

  const upload = async (userId: string, text: string, filename: string) =>
    ingestModule.ingest({
      scope: await scopeOf(userId),
      source: 'config_upload',
      sourceKey: `root/${filename}`,
      text,
      filename,
      mimeType: 'text/markdown',
      signal: new AbortController().signal,
    });

  const rows = async (sql: string, params: unknown[]): Promise<Row[]> => (await fixture.db.query<Row>(sql, params)).rows;

  let first: Awaited<ReturnType<typeof upload>>;

  test('a Markdown upload becomes a ready version-1 document with section-path chunks', async () => {
    first = await upload(TWO_TENANT_IDS.userA, MARKDOWN, 'warehouse-handbook.md');
    assert.equal(first.status, 'ready');
    assert.equal(first.version, 1);
    assert.equal(first.parserUsed, 'text');
    assert.ok(first.documentId);

    const documents = await rows('SELECT * FROM documents WHERE id = $1', [first.documentId]);
    assert.equal(documents.length, 1);
    const document = documents[0] as Row;
    assert.equal(document.is_current, true);
    assert.equal(document.status, 'ready');
    assert.equal(document.doc_type, 'general');
    assert.equal(document.tenant_key, `u:${TWO_TENANT_IDS.userA}`);
    assert.ok(document.file_sha256);
    assert.ok(document.content_hash);

    const chunks = await rows(
      'SELECT content, chunk_index, section_path, embedding_text_version, metadata, embedding IS NOT NULL AS embedded, is_current, status FROM document_chunks WHERE document_id = $1 ORDER BY chunk_index',
      [first.documentId],
    );
    assert.equal(chunks.length, first.chunkCount);
    assert.deepEqual(
      chunks.map((chunk) => chunk.section_path),
      [['Warehouse Handbook'], ['Warehouse Handbook', 'Receiving Dock'], ['Warehouse Handbook', 'Shipping Cage']],
    );
    for (const [index, chunk] of chunks.entries()) {
      const content = String(chunk.content);
      assert.ok(!content.startsWith('Document:'), 'content carries no document prefix');
      assert.ok(!/Chunk \d+ of \d+/.test(content), 'content carries no chunk counter');
      assert.ok(!content.includes('Warehouse Handbook'), 'content carries no path prefix');
      assert.equal(chunk.embedding_text_version, 1);
      assert.equal(chunk.embedded, true);
      assert.equal(chunk.is_current, true);
      assert.equal(chunk.status, 'ready');
      const metadata = chunk.metadata as Row;
      assert.equal(metadata.document_title, 'warehouse-handbook.md');
      assert.equal(metadata.chunk_index, index);
      assert.equal(metadata.chunk_position, index + 1);
      assert.equal(metadata.total_chunks, chunks.length);
    }
    assert.ok(String(chunks[1]?.content).includes('receiving dock'));
  });

  test('retrieval returns the ingested chunk for its tenant and never for the other tenant', async () => {
    assert.ok(first?.documentId, 'the first test ingested the document');
    const retrieve = async (userId: string) =>
      rag.runRetrieval({
        scope: await scopeOf(userId),
        query: SECTION_QUERY,
        profile: 'eval',
        options: OPTIONS,
        signal: new AbortController().signal,
      });

    const forA = await retrieve(TWO_TENANT_IDS.userA);
    const hit = forA.candidates.find((candidate) => candidate.document_id === first.documentId);
    assert.ok(hit, 'tenant A retrieves a chunk of its ingested document');
    assert.ok(hit.content.includes('receiving dock'));

    const forB = await retrieve(TWO_TENANT_IDS.userB);
    assert.equal(
      forB.candidates.some((candidate) => candidate.document_id === first.documentId),
      false,
      'tenant B never retrieves it',
    );
  });

  test('INGEST_STAGES lists the thirteen D-02 stages in order', () => {
    assert.deepEqual(
      [...runnerModule.INGEST_STAGES],
      [
        'identify',
        'file_hash_dedup',
        'store_original',
        'parse',
        'content_hash_dedup',
        'scan_injection',
        'chunk',
        'enrich',
        'extract',
        'images',
        'embed',
        'write',
        'publish',
      ],
    );
  });
});
