import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';
import type { RpcClient } from '@/lib/rag/backend/supabase-rpc';
import type { StageContext } from '@/lib/rag/ingest/types';

type Row = Record<string, unknown>;

const MARKDOWN = [
  '# Dock Rules',
  '',
  'Forklift batteries rotate every shift under the zebra quartz seventeen policy and the staff follow the rules.',
  '',
  '## Receiving Dock',
  '',
  'Pallets arriving at the receiving dock are scanned by the night crew and staged beside bay four for the team.',
  '',
  '## Shipping Cage',
  '',
  'Outbound pallets leave through the shipping cage after the supervisor signs the manifest for the carrier.',
  '',
].join('\n');

const JUMP_MS = 49_500;

describe('ingest resume against the two-tenant database', () => {
  let fixture: TwoTenantDatabase;
  let edge: FakeEdge;
  let ingestModule: typeof import('@/lib/rag/ingest');
  let depsModule: typeof import('@/lib/rag/ingest/deps');
  let objectStoreModule: typeof import('@/lib/rag/ingest/object-store');
  let fakeStoreModule: typeof import('../helpers/fake-object-store');
  let resolver: typeof import('@/lib/rag/tenant/resolve-chat');
  let supabaseModule: typeof import('@/lib/supabase');
  let chunkModule: typeof import('@/lib/rag/ingest/stages/chunk');
  let enrichModule: typeof import('@/lib/rag/ingest/stages/enrich');

  before(async () => {
    fixture = await createTwoTenantDatabase();
    edge = await startFakeEdge({ db: fixture.db });
    Object.assign(process.env, fixtureProcessEnv(edge.url));
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    process.env.MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    ingestModule = await import('@/lib/rag/ingest');
    depsModule = await import('@/lib/rag/ingest/deps');
    objectStoreModule = await import('@/lib/rag/ingest/object-store');
    fakeStoreModule = await import('../helpers/fake-object-store');
    resolver = await import('@/lib/rag/tenant/resolve-chat');
    supabaseModule = await import('@/lib/supabase');
    chunkModule = await import('@/lib/rag/ingest/stages/chunk');
    enrichModule = await import('@/lib/rag/ingest/stages/enrich');
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

  const rows = async (sql: string, params: unknown[]): Promise<Row[]> => (await fixture.db.query<Row>(sql, params)).rows;

  /** The real admin client; once armed, the clock jumps when the images stage has saved its state, so embed no longer fits the deadline. */
  const interruptingDeps = () => {
    const real = supabaseModule.getSupabaseAdmin() as unknown as RpcClient;
    let clock = 1_000_000;
    let armed = true;
    const db: RpcClient = {
      rpc(fn, args) {
        const state = args.p_state as { lastCompleted?: string } | undefined;
        if (armed && fn === 'rag_save_ingest_state' && state?.lastCompleted === 'images') {
          clock += JUMP_MS;
          armed = false;
        }
        return real.rpc(fn, args);
      },
    };
    depsModule.setIngestDepsForTests({ db: () => db, now: () => clock });
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

  const chunkRows = (documentId: string) =>
    rows(
      'SELECT chunk_index, content_hash, lexical_text, language, embedding IS NOT NULL AS embedded FROM document_chunks WHERE document_id = $1 ORDER BY chunk_index',
      [documentId],
    );

  test('a run that runs out of time before embed stays resumable, is invisible to the other tenant, and completes on resume without duplicate chunks', async () => {
    interruptingDeps();
    const interrupted = await upload(TWO_TENANT_IDS.userA, MARKDOWN, 'dock-rules.md');

    assert.equal(interrupted.status, 'processing');
    assert.equal(interrupted.reason, 'deadline');
    assert.ok(interrupted.documentId);
    const documentId = interrupted.documentId;

    const [stored] = await rows('SELECT status, is_current, processing_status, processing_state FROM documents WHERE id = $1', [documentId]);
    assert.equal(stored?.status, 'processing');
    assert.equal(stored?.is_current, false);
    assert.equal(stored?.processing_status, 'processing');
    assert.equal((stored?.processing_state as Row).lastCompleted, 'images');
    assert.equal((await chunkRows(documentId)).length, 0, 'nothing was written before the deadline');

    depsModule.resetIngestDepsForTests();
    const scopeA = await scopeOf(TWO_TENANT_IDS.userA);
    const scopeB = await scopeOf(TWO_TENANT_IDS.userB);

    const view = await ingestModule.getIngestStatus(scopeA, documentId);
    assert.deepEqual(view, {
      status: 'processing',
      version: 1,
      processingStatus: 'processing',
      lastCompleted: 'images',
      parserUsed: 'text',
      docType: 'general',
    });
    assert.equal(await ingestModule.getIngestStatus(scopeB, documentId), null, 'another tenant sees no such document');
    const foreign = await ingestModule.resumeIngest(scopeB, documentId);
    assert.equal(foreign.status, 'failed');
    assert.equal(foreign.reason, 'document_not_found');
    const [untouched] = await rows('SELECT status, processing_status FROM documents WHERE id = $1', [documentId]);
    assert.equal(untouched?.status, 'processing');

    const withoutInputs = await ingestModule.resumeIngest(scopeA, documentId);
    assert.equal(withoutInputs.status, 'processing');
    assert.equal(withoutInputs.reason, 'resume_input_unavailable');
    assert.equal((await chunkRows(documentId)).length, 0);

    depsModule.setIngestDepsForTests({
      rehydrate: async (ctx: StageContext) => {
        ctx.work.parseText = MARKDOWN;
        await chunkModule.chunkStage.run(ctx);
        await enrichModule.enrichStage.run(ctx);
        return true;
      },
    });
    const resumed = await ingestModule.resumeIngest(scopeA, documentId);

    assert.equal(resumed.status, 'ready');
    assert.equal(resumed.documentId, documentId);
    assert.equal(resumed.chunkCount, 3);
    const chunks = await chunkRows(documentId);
    assert.deepEqual(chunks.map((chunk) => chunk.chunk_index), [0, 1, 2]);
    for (const chunk of chunks) {
      assert.equal(chunk.embedded, true);
      assert.ok(chunk.content_hash, 'chunk content hash written');
      assert.ok(chunk.lexical_text, 'lexical text written');
      assert.equal(chunk.language, 'en');
    }
    const [published] = await rows('SELECT status, is_current, processing_status FROM documents WHERE id = $1', [documentId]);
    assert.equal(published?.status, 'ready');
    assert.equal(published?.is_current, true);
    assert.equal(published?.processing_status, 'ready');

    const again = await ingestModule.resumeIngest(scopeA, documentId);
    assert.equal(again.status, 'ready');
    assert.equal(again.chunkCount, 3);
    assert.equal((await chunkRows(documentId)).length, 3, 'a second resume writes nothing');
  });

  test('uploading the same file again after an interrupted run reuses the processing version and ends with one set of chunks', async () => {
    const text = `${MARKDOWN}\nA closing note about the rules for the weekend crew.\n`;
    interruptingDeps();
    const interrupted = await upload(TWO_TENANT_IDS.userB, text, 'weekend-rules.md');
    assert.equal(interrupted.status, 'processing');
    assert.ok(interrupted.documentId);

    depsModule.resetIngestDepsForTests();
    const finished = await upload(TWO_TENANT_IDS.userB, text, 'weekend-rules.md');

    assert.equal(finished.status, 'ready');
    assert.equal(finished.documentId, interrupted.documentId);
    assert.equal(finished.version, 1);
    const chunks = await chunkRows(interrupted.documentId);
    assert.equal(chunks.length, finished.chunkCount);
    assert.equal(new Set(chunks.map((chunk) => chunk.chunk_index)).size, chunks.length);
    const documents = await rows('SELECT id FROM documents WHERE source_key = $1 AND tenant_key = $2', ['root/weekend-rules.md', `u:${TWO_TENANT_IDS.userB}`]);
    assert.equal(documents.length, 1, 'no second version was created');
  });
});
