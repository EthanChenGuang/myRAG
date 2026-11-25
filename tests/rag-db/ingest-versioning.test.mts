import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

type Row = Record<string, unknown>;

const OPTIONS = { maxResults: 25, fallbackToLowerThreshold: true };

const V1_BODY = 'The teal fleet policy limits every convoy to nine trucks per crossing of the northern bridge.';
const V2_BODY = 'The amber fleet policy allows every convoy twelve trucks per crossing of the southern viaduct.';
const V3_BODY = 'The violet fleet policy sets every convoy at fifteen trucks per crossing of the eastern causeway.';

const markdown = (body: string) => `# Fleet Policy\n\n${body}\n`;
const SOURCE_KEY = 'policies/fleet-policy.md';
const FILENAME = 'fleet-policy.md';

describe('ingest versioning: atomic swap, current-only retrieval, old citations (D-11)', () => {
  let fixture: TwoTenantDatabase;
  let edge: FakeEdge;
  let rag: typeof import('@/lib/rag');
  let ingestModule: typeof import('@/lib/rag/ingest');
  let depsModule: typeof import('@/lib/rag/ingest/deps');
  let objectStoreModule: typeof import('@/lib/rag/ingest/object-store');
  let fakeStoreModule: typeof import('../helpers/fake-object-store');
  let resolver: typeof import('@/lib/rag/tenant/resolve-chat');
  let supabaseModule: typeof import('@/lib/supabase');
  let fetchRows: typeof import('@/lib/rag/context/fetch-rows');

  before(async () => {
    fixture = await createTwoTenantDatabase();
    edge = await startFakeEdge({ db: fixture.db });
    Object.assign(process.env, fixtureProcessEnv(edge.url));
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    process.env.MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    rag = await import('@/lib/rag');
    ingestModule = await import('@/lib/rag/ingest');
    depsModule = await import('@/lib/rag/ingest/deps');
    objectStoreModule = await import('@/lib/rag/ingest/object-store');
    fakeStoreModule = await import('../helpers/fake-object-store');
    resolver = await import('@/lib/rag/tenant/resolve-chat');
    supabaseModule = await import('@/lib/supabase');
    fetchRows = await import('@/lib/rag/context/fetch-rows');
  });

  after(async () => {
    await edge?.close();
    await fixture?.db.close();
  });

  beforeEach(() => {
    objectStoreModule.setObjectStoreForTests(fakeStoreModule.createFakeObjectStore());
  });

  afterEach(() => {
    objectStoreModule.resetObjectStoreForTests();
    depsModule.resetIngestDepsForTests();
    mock.restoreAll();
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

  const upload = async (body: string) =>
    ingestModule.ingest({
      scope: await scopeOf(TWO_TENANT_IDS.userA),
      source: 'config_upload',
      sourceKey: SOURCE_KEY,
      text: markdown(body),
      filename: FILENAME,
      mimeType: 'text/markdown',
      signal: new AbortController().signal,
    });

  const retrieve = async (query: string) =>
    rag.runRetrieval({
      scope: await scopeOf(TWO_TENANT_IDS.userA),
      query,
      profile: 'eval',
      options: OPTIONS,
      signal: new AbortController().signal,
    });

  const rows = async (sql: string, params: unknown[]): Promise<Row[]> => (await fixture.db.query<Row>(sql, params)).rows;
  const chunkIds = async (documentId: string | null) =>
    (await rows('SELECT id FROM document_chunks WHERE document_id = $1 ORDER BY chunk_index', [documentId])).map((row) => String(row.id));

  let v1: Awaited<ReturnType<typeof upload>>;
  let v2: Awaited<ReturnType<typeof upload>>;
  let v1ChunkIds: string[] = [];
  let v2ChunkIds: string[] = [];

  test('new text for the same identity becomes version 2 of the same lineage and supersedes version 1', async () => {
    v1 = await upload(V1_BODY);
    assert.equal(v1.status, 'ready');
    assert.equal(v1.version, 1);
    v1ChunkIds = await chunkIds(v1.documentId);
    assert.ok(v1ChunkIds.length > 0);

    v2 = await upload(V2_BODY);
    assert.equal(v2.status, 'ready');
    assert.equal(v2.version, 2);
    assert.notEqual(v2.documentId, v1.documentId);
    v2ChunkIds = await chunkIds(v2.documentId);
    assert.ok(v2ChunkIds.length > 0);

    const stored = await rows('SELECT id, lineage_id, version, is_current, status, superseded_by FROM documents WHERE id = ANY($1::uuid[]) ORDER BY version', [[v1.documentId, v2.documentId]]);
    assert.equal(stored.length, 2);
    assert.equal(stored[0]?.lineage_id, stored[1]?.lineage_id, 'one lineage');
    assert.equal(stored[0]?.lineage_id, v1.documentId, 'the lineage is the first version id');
    assert.equal(stored[0]?.is_current, false);
    assert.equal(stored[0]?.superseded_by, v2.documentId);
    assert.equal(stored[1]?.is_current, true);
    assert.equal(stored[1]?.status, 'ready');
    assert.equal(stored[1]?.superseded_by, null);

    const flags = await rows('SELECT document_id, is_current, status FROM document_chunks WHERE document_id = ANY($1::uuid[])', [[v1.documentId, v2.documentId]]);
    for (const flag of flags) assert.equal(flag.is_current, flag.document_id === v2.documentId, 'only the v2 chunks are current');
  });

  test('retrieval for the tenant returns only version 2 chunks, including for a query that matches version 1 text best', async () => {
    assert.ok(v2?.documentId);
    const forV2 = await retrieve(V2_BODY);
    const v2Hits = forV2.candidates.filter((candidate) => v2ChunkIds.includes(candidate.chunk_id));
    assert.ok(v2Hits.length > 0, 'the v2 chunk is retrieved');

    const forV1 = await retrieve(V1_BODY);
    for (const result of [forV2, forV1]) {
      assert.equal(
        result.candidates.some((candidate) => v1ChunkIds.includes(candidate.chunk_id) || candidate.document_id === v1.documentId),
        false,
        'no superseded chunk is returned',
      );
    }
  });

  test('the current-only filter holds even when a superseded chunk still has a vector', async () => {
    assert.ok(v1?.documentId);
    const vector = `[${embedText(V1_BODY).join(',')}]`;
    await fixture.db.query('UPDATE document_chunks SET embedding = $1::vector WHERE document_id = $2', [vector, v1.documentId]);
    try {
      const result = await retrieve(V1_BODY);
      assert.equal(
        result.candidates.some((candidate) => v1ChunkIds.includes(candidate.chunk_id) || candidate.document_id === v1.documentId),
        false,
        'a superseded chunk with an exact vector match is still excluded',
      );
    } finally {
      await fixture.db.query('UPDATE document_chunks SET embedding = NULL WHERE document_id = $1', [v1.documentId]);
    }
  });

  test('a stored citation of a version 1 chunk still loads its text and its document name by id', async () => {
    assert.ok(v1?.documentId);
    const admin = supabaseModule.getSupabaseAdmin();

    const chunk = await admin.from('document_chunks').select('id, content').eq('id', v1ChunkIds[0] as string);
    assert.equal(chunk.error, null);
    assert.equal(chunk.data?.length, 1, 'the v1 chunk row is still there');
    assert.ok(String(chunk.data?.[0]?.content).includes('teal fleet policy'), 'it still carries the v1 text');

    const document = await admin.from('documents').select('id, filename').eq('id', v1.documentId as string);
    assert.equal(document.error, null);
    assert.equal(document.data?.[0]?.filename, FILENAME, 'the v1 document still carries its name');

    const assembled = await fetchRows.fetchAssemblyRows(
      [{ chunk_id: v1ChunkIds[0] as string, document_id: v1.documentId as string }] as unknown as Parameters<typeof fetchRows.fetchAssemblyRows>[0],
      { adminClient: admin, signal: new AbortController().signal },
    );
    assert.equal(assembled.documents.get(v1.documentId as string)?.filename, FILENAME);
    assert.ok(assembled.chunkMetadata.has(v1ChunkIds[0] as string), 'the chunk metadata used for citations loads');
  });

  test('a failure while publishing version 3 leaves version 2 current and retrievable', async () => {
    assert.ok(v2?.documentId);
    await fixture.db.query(`
      CREATE FUNCTION test_block_v3_promotion() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.is_current AND NOT OLD.is_current AND NEW.version = 3 THEN
          RAISE EXCEPTION 'injected publish failure';
        END IF;
        RETURN NEW;
      END
      $$`);
    await fixture.db.query('CREATE TRIGGER test_block_v3_promotion BEFORE UPDATE ON documents FOR EACH ROW EXECUTE FUNCTION test_block_v3_promotion()');
    try {
      mock.method(console, 'error', () => undefined);
      const v3 = await upload(V3_BODY);
      mock.restoreAll();
      assert.equal(v3.status, 'failed');
      assert.equal(v3.version, 3);

      const state = await rows('SELECT version, is_current, status, superseded_by FROM documents WHERE lineage_id = $1 ORDER BY version', [v1.documentId]);
      assert.deepEqual(
        state.map((row) => [row.version, row.is_current, row.status]),
        [
          [1, false, 'ready'],
          [2, true, 'ready'],
          [3, false, 'failed'],
        ],
      );
      assert.equal(state[0]?.superseded_by, v2.documentId, 'v1 still points at v2');
      assert.equal(state[1]?.superseded_by, null, 'v2 was not demoted by the failed swap');
      const v2Flags = await rows('SELECT is_current, status FROM document_chunks WHERE document_id = $1', [v2.documentId]);
      assert.ok(v2Flags.length > 0);
      for (const flag of v2Flags) assert.deepEqual([flag.is_current, flag.status], [true, 'ready']);

      const afterFailure = await retrieve(V2_BODY);
      assert.ok(
        afterFailure.candidates.some((candidate) => v2ChunkIds.includes(candidate.chunk_id)),
        'version 2 is still retrievable',
      );
      const v3Chunks = await rows('SELECT id FROM document_chunks WHERE document_id = $1 AND is_current', [v3.documentId]);
      assert.equal(v3Chunks.length, 0, 'no version 3 chunk is current');
    } finally {
      await fixture.db.query('DROP TRIGGER IF EXISTS test_block_v3_promotion ON documents');
      await fixture.db.query('DROP FUNCTION IF EXISTS test_block_v3_promotion()');
    }
  });
});
