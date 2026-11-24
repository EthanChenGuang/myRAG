import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';
import type { RpcClient } from '@/lib/rag/backend/supabase-rpc';

type Row = Record<string, unknown>;

const OPTIONS = { maxResults: 25, fallbackToLowerThreshold: true };

const BODY = 'The saffron inventory ledger is reconciled by the harbour clerk every Friday before the customs window closes.';
const TEXT_X = `# Harbour Ledger\n\n${BODY}\n\nA second paragraph records the tide table used by the clerk.\n`;

describe('ingest dedup and identity across two tenants (D-09, D-10)', () => {
  let fixture: TwoTenantDatabase;
  let edge: FakeEdge;
  let rag: typeof import('@/lib/rag');
  let ingestModule: typeof import('@/lib/rag/ingest');
  let depsModule: typeof import('@/lib/rag/ingest/deps');
  let objectStoreModule: typeof import('@/lib/rag/ingest/object-store');
  let fakeStoreModule: typeof import('../helpers/fake-object-store');
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
    depsModule = await import('@/lib/rag/ingest/deps');
    objectStoreModule = await import('@/lib/rag/ingest/object-store');
    fakeStoreModule = await import('../helpers/fake-object-store');
    resolver = await import('@/lib/rag/tenant/resolve-chat');
    supabaseModule = await import('@/lib/supabase');
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

  const upload = async (userId: string, text: string, sourceKey: string, filename = 'ledger.md') =>
    ingestModule.ingest({
      scope: await scopeOf(userId),
      source: 'config_upload',
      sourceKey,
      text,
      filename,
      mimeType: 'text/markdown',
      signal: new AbortController().signal,
    });

  const rows = async (sql: string, params: unknown[]): Promise<Row[]> => (await fixture.db.query<Row>(sql, params)).rows;
  const count = async (sql: string, params: unknown[]): Promise<number> => Number((await rows(sql, params))[0]?.n);
  const tenantChunks = (userId: string) =>
    count('SELECT count(*)::int AS n FROM document_chunks WHERE tenant_key = $1', [`u:${userId}`]);

  const retrieve = async (userId: string, query: string) =>
    rag.runRetrieval({
      scope: await scopeOf(userId),
      query,
      profile: 'eval',
      options: OPTIONS,
      signal: new AbortController().signal,
    });

  let originalA: Awaited<ReturnType<typeof upload>>;

  test('the same bytes under a different source key are a duplicate of the first document and add no chunks', async () => {
    originalA = await upload(TWO_TENANT_IDS.userA, TEXT_X, 'root/harbour-ledger.md');
    assert.equal(originalA.status, 'ready');
    assert.ok(originalA.documentId);
    const before = await tenantChunks(TWO_TENANT_IDS.userA);

    const again = await upload(TWO_TENANT_IDS.userA, TEXT_X, 'archive/harbour-ledger-copy.md', 'harbour-ledger-copy.md');
    assert.equal(again.status, 'skipped_duplicate');
    assert.equal(again.duplicateOf, originalA.documentId);
    assert.equal(again.documentId, null);
    assert.equal(again.chunkCount, 0);
    assert.equal(await tenantChunks(TWO_TENANT_IDS.userA), before, 'tenant A has no new chunk');
    assert.equal(await count('SELECT count(*)::int AS n FROM documents WHERE source_key = $1', ['archive/harbour-ledger-copy.md']), 0, 'no row for the copy');
  });

  test('CRLF line endings and doubled spaces are a content duplicate and the discarded version is deleted', async () => {
    assert.ok(originalA?.documentId, 'the first test ingested the original');
    const before = await tenantChunks(TWO_TENANT_IDS.userA);
    const variant = TEXT_X.replace(/\n/g, '\r\n').replace(/ /g, '  ');
    assert.notEqual(variant, TEXT_X);

    const again = await upload(TWO_TENANT_IDS.userA, variant, 'scans/harbour-ledger-rescan.md', 'harbour-ledger-rescan.md');
    assert.equal(again.status, 'skipped_duplicate');
    assert.equal(again.duplicateOf, originalA.documentId);
    assert.equal(again.chunkCount, 0);
    assert.equal(await tenantChunks(TWO_TENANT_IDS.userA), before, 'tenant A has no new chunk');

    const discarded = await rows(
      "SELECT status, is_current, content_hash, metadata->>'duplicate_of' AS duplicate_of, (SELECT count(*)::int FROM document_chunks c WHERE c.document_id = d.id) AS chunks FROM documents d WHERE d.source_key = $1",
      ['scans/harbour-ledger-rescan.md'],
    );
    assert.equal(discarded.length, 1);
    assert.equal(discarded[0]?.status, 'deleted');
    assert.equal(discarded[0]?.is_current, false);
    assert.equal(discarded[0]?.duplicate_of, originalA.documentId);
    assert.equal(discarded[0]?.chunks, 0);
    const original = await rows('SELECT content_hash FROM documents WHERE id = $1', [originalA.documentId]);
    assert.equal(discarded[0]?.content_hash, original[0]?.content_hash, 'both carry the same normalised hash');
  });

  test('the same identity with the same bytes is skipped and creates no version', async () => {
    assert.ok(originalA?.documentId);
    const again = await upload(TWO_TENANT_IDS.userA, TEXT_X, 'root/harbour-ledger.md');
    assert.equal(again.status, 'skipped_duplicate');
    assert.equal(again.duplicateOf, originalA.documentId);
    assert.equal(await count('SELECT count(*)::int AS n FROM documents WHERE source_key = $1', ['root/harbour-ledger.md']), 1, 'still one row for the identity');
    const current = await rows('SELECT version, is_current FROM documents WHERE id = $1', [originalA.documentId]);
    assert.equal(current[0]?.version, 1);
    assert.equal(current[0]?.is_current, true);
  });

  test('the same identity with different bytes and the same normalised text is skipped and the current version is untouched', async () => {
    assert.ok(originalA?.documentId);
    const before = await tenantChunks(TWO_TENANT_IDS.userA);
    const variant = TEXT_X.replace(/\n/g, '\r\n');
    const again = await upload(TWO_TENANT_IDS.userA, variant, 'root/harbour-ledger.md');
    assert.equal(again.status, 'skipped_duplicate');
    assert.equal(again.duplicateOf, originalA.documentId);
    assert.equal(await tenantChunks(TWO_TENANT_IDS.userA), before);

    const versions = await rows('SELECT version, is_current, status FROM documents WHERE source_key = $1 ORDER BY version', ['root/harbour-ledger.md']);
    assert.equal(versions.filter((row) => row.is_current === true).length, 1, 'exactly one current version');
    assert.equal(versions[0]?.is_current, true);
    assert.equal(versions[0]?.version, 1);
    for (const row of versions.slice(1)) assert.equal(row.status, 'deleted', 'a discarded candidate version is deleted');
  });

  test('another tenant uploading the same bytes is ingested with its own document and chunks, and neither tenant retrieves the other copy', async () => {
    assert.ok(originalA?.documentId);
    const forB = await upload(TWO_TENANT_IDS.userB, TEXT_X, 'root/harbour-ledger.md');
    assert.equal(forB.status, 'ready');
    assert.notEqual(forB.documentId, originalA.documentId);
    assert.equal(forB.duplicateOf, undefined, 'never linked to the other tenant document');
    assert.ok(forB.chunkCount > 0);

    const owner = await rows('SELECT tenant_key, user_id FROM documents WHERE id = $1', [forB.documentId]);
    assert.equal(owner[0]?.tenant_key, `u:${TWO_TENANT_IDS.userB}`);
    assert.equal(owner[0]?.user_id, TWO_TENANT_IDS.userB);
    const foreign = await count(
      'SELECT count(*)::int AS n FROM document_chunks c JOIN documents d ON d.id = c.document_id WHERE d.id = $1 AND c.tenant_key <> d.tenant_key',
      [forB.documentId],
    );
    assert.equal(foreign, 0, 'every chunk of B carries B tenant key');

    const forAHits = await retrieve(TWO_TENANT_IDS.userA, BODY);
    assert.ok(forAHits.candidates.some((candidate) => candidate.document_id === originalA.documentId), 'A retrieves its own copy');
    assert.equal(forAHits.candidates.some((candidate) => candidate.document_id === forB.documentId), false, 'A never sees the copy of B');

    const forBHits = await retrieve(TWO_TENANT_IDS.userB, BODY);
    assert.ok(forBHits.candidates.some((candidate) => candidate.document_id === forB.documentId), 'B retrieves its own copy');
    assert.equal(forBHits.candidates.some((candidate) => candidate.document_id === originalA.documentId), false, 'B never sees the copy of A');
  });

  test('the content duplicate check of one tenant never matches a document of another tenant', async () => {
    const text = '# Shared Wording\n\nThe cedar manifest names every crate loaded on the east pier before dawn.\n';
    const variant = text.replace(/\n/g, '\r\n');
    const forB = await upload(TWO_TENANT_IDS.userB, text, 'root/cedar.md', 'cedar.md');
    assert.equal(forB.status, 'ready');
    const forA = await upload(TWO_TENANT_IDS.userA, variant, 'root/cedar.md', 'cedar.md');
    assert.equal(forA.status, 'ready', 'different bytes, same normalised text, other tenant: no content duplicate');
    assert.notEqual(forA.documentId, forB.documentId);
    assert.equal(forA.duplicateOf, undefined);
  });

  test('two concurrent ingests of the same identity and bytes produce one version and one set of chunks', async () => {
    const text = '# Concurrent Copy\n\nThe indigo shipping schedule is posted at the gatehouse every Monday morning.\n\nA closing paragraph lists the berths.\n';
    const key = 'root/concurrent.md';
    const real = supabaseModule.getSupabaseAdmin() as unknown as RpcClient;
    const calls: string[] = [];
    depsModule.setIngestDepsForTests({
      db: () => ({
        rpc(fn, args) {
          calls.push(fn);
          return real.rpc(fn, args);
        },
      }),
    });
    const results = await Promise.all([
      upload(TWO_TENANT_IDS.userA, text, key, 'concurrent.md'),
      upload(TWO_TENANT_IDS.userA, text, key, 'concurrent.md'),
    ]);

    const begins = calls.flatMap((fn, index) => (fn === 'rag_begin_document_version' ? [index] : []));
    assert.equal(begins.length, 2, 'both runs began a version');
    assert.ok(begins[1] !== undefined && begins[1] < calls.indexOf('rag_publish_document_version'), 'both runs began before either published');

    for (const result of results) {
      assert.ok(result.status === 'ready' || result.status === 'skipped_duplicate' || result.status === 'processing', `unexpected status ${result.status}`);
    }
    assert.ok(results.some((result) => result.status === 'ready'), 'one run published the version');
    const documentIds = new Set(results.filter((result) => result.documentId !== null).map((result) => result.documentId));
    assert.equal(documentIds.size, 1, 'both runs refer to one document');

    const versions = await rows('SELECT id, version, is_current, status FROM documents WHERE source_key = $1 AND tenant_key = $2', [key, `u:${TWO_TENANT_IDS.userA}`]);
    assert.equal(versions.length, 1, 'one version row');
    assert.equal(versions[0]?.version, 1);
    assert.equal(versions[0]?.is_current, true);
    assert.equal(versions[0]?.status, 'ready');

    const chunks = await rows('SELECT chunk_index FROM document_chunks WHERE document_id = $1 ORDER BY chunk_index', [versions[0]?.id]);
    assert.ok(chunks.length > 0);
    assert.deepEqual(
      chunks.map((chunk) => chunk.chunk_index),
      chunks.map((_, index) => index),
      'chunk indexes are one contiguous set with no repeat',
    );
  });
});
