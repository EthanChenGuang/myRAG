import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';
import type { RpcClient } from '@/lib/rag/backend/supabase-rpc';
import type { FakeSidecar } from '../helpers/fake-sidecar';

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

    assert.equal((await chunkRows(documentId)).length, 0, 'the foreign resume wrote nothing');

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

  describe('a slow parse resumed through the resume route', () => {
    const PDF_ID = 'report-zh-table';
    const HOUR = 3_600_000;
    let sidecarModule: typeof import('@/lib/rag/ingest/parsers/sidecar-docling');
    let fakeSidecarModule: typeof import('../helpers/fake-sidecar');
    let writerModule: typeof import('@/lib/rag/ingest/writer');
    let handlers: typeof import('@/app/api/rag/ingest/_lib/handlers');
    let sidecar: FakeSidecar;
    let clock = 0;

    before(async () => {
      sidecarModule = await import('@/lib/rag/ingest/parsers/sidecar-docling');
      fakeSidecarModule = await import('../helpers/fake-sidecar');
      writerModule = await import('@/lib/rag/ingest/writer');
      handlers = await import('@/app/api/rag/ingest/_lib/handlers');
    });

    beforeEach(async () => {
      sidecar = await fakeSidecarModule.startFakeSidecar();
      clock = 1_000_000;
      depsModule.setIngestDepsForTests({
        now: () => clock,
        ingestEnv: () => ({ RAG_INGEST_PIPELINE: 'unified', RAG_PARSER: 'llamaparse', RAG_PARSE_POLL_BUDGET_MS: '5000' }),
      });
      sidecarModule.setSidecarParserForTests(
        sidecarModule.createSidecarParser({
          baseUrl: sidecar.url,
          secret: sidecar.secret,
          sleep: async (ms) => {
            clock += ms;
          },
        }),
      );
    });

    afterEach(async () => {
      sidecarModule.resetSidecarParserForTests();
      await sidecar.close();
    });

    /** A tenant's ready file is a duplicate for that tenant, so each test names its own fixture. */
    const uploadPdf = async (userId: string, sourceKey: string, fixtureId = PDF_ID, docType: 'financial_report' | 'scanned_image' = 'financial_report') =>
      ingestModule.ingest({
        scope: await scopeOf(userId),
        source: 'config_upload',
        sourceKey,
        file: fakeSidecarModule.fixtureBytes(fixtureId),
        filename: `${fixtureId}.pdf`,
        mimeType: 'application/pdf',
        docType,
        signal: new AbortController().signal,
      });

    const resumeVia = (userId: string, id: string) =>
      handlers.handleIngestResume(new Request(`http://localhost/api/rag/ingest/${id}/resume`, { method: 'POST' }), Promise.resolve({ id }), {
        getUser: async () => ({ id: userId }),
      });

    const statusVia = (userId: string, id: string) =>
      handlers.handleIngestStatus(new Request(`http://localhost/api/rag/ingest/${id}`), Promise.resolve({ id }), { getUser: async () => ({ id: userId }) });

    const contentRows = (documentId: string) =>
      rows(
        'SELECT id, chunk_index, content, content_hash, chunk_kind, section_path, page_start, page_end, metadata FROM document_chunks WHERE document_id = $1 ORDER BY chunk_index',
        [documentId],
      );

    /** A job that stays running until the test lets it succeed. */
    const slowJob = () => {
      const statuses: Array<'running' | 'succeeded'> = ['running'];
      sidecar.enqueue({ statuses });
      return { finish: () => void statuses.push('succeeded') };
    };

    const callsSince = (count: number) => sidecar.calls.slice(count);

    test('a parse job that outlasts the poll budget returns processing with its job id, and the resume route polls the same job to ready without a second submit', async () => {
      const job = slowJob();
      const interrupted = await uploadPdf(TWO_TENANT_IDS.userA, 'root/slow.pdf');

      assert.equal(interrupted.status, 'processing');
      assert.equal(interrupted.reason, 'parse_pending');
      assert.ok(interrupted.documentId);
      const documentId = interrupted.documentId;
      const [stored] = await rows('SELECT status, is_current, processing_state FROM documents WHERE id = $1', [documentId]);
      assert.equal(stored?.status, 'processing');
      assert.equal(stored?.is_current, false);
      const savedJob = (stored?.processing_state as { parseJob?: { jobId: string; parser: string } }).parseJob;
      assert.equal(savedJob?.jobId, 'job1');
      assert.equal(savedJob?.parser, 'docling');
      assert.equal(sidecar.uploads.length, 1);
      assert.equal((await contentRows(documentId)).length, 0, 'no chunk was written before the parse finished');

      const before = await statusVia(TWO_TENANT_IDS.userA, documentId);
      assert.equal(before.status, 200);
      const pending = (await before.json()) as Record<string, unknown>;
      assert.equal(pending.status, 'processing');
      assert.deepEqual(pending.warnings, ['parse_pending']);

      job.finish();
      const seen = sidecar.calls.length;
      const response = await resumeVia(TWO_TENANT_IDS.userA, documentId);

      assert.equal(response.status, 200);
      const body = (await response.json()) as Record<string, unknown>;
      assert.equal(body.status, 'ready');
      assert.equal(body.documentId, documentId);
      assert.equal(body.parserUsed, 'docling');
      assert.equal(sidecar.uploads.length, 1, 'the sidecar received one submit');
      const after = callsSince(seen);
      assert.ok(after.length > 0 && after.every((call) => call.method !== 'POST'), 'after the interruption the sidecar saw polls, artifact reads and a delete only');
      assert.ok(after.some((call) => call.method === 'GET' && call.path === '/v1/parse/jobs/job1'));

      const chunks = await contentRows(documentId);
      assert.ok(chunks.length > 1);
      assert.deepEqual(chunks.map((chunk) => chunk.chunk_index), chunks.map((_, index) => index), 'chunk indexes are contiguous: no gap, no duplicate');
      for (const chunk of chunks) assert.equal(chunk.id, writerModule.chunkIdFor(documentId, chunk.chunk_index as number));

      const [published] = await rows('SELECT status, is_current, processing_status FROM documents WHERE id = $1', [documentId]);
      assert.equal(published?.status, 'ready');
      assert.equal(published?.is_current, true);

      const again = await resumeVia(TWO_TENANT_IDS.userA, documentId);
      assert.equal(((await again.json()) as Record<string, unknown>).status, 'ready');
      assert.equal((await contentRows(documentId)).length, chunks.length, 'a second resume writes nothing');
      assert.equal(sidecar.uploads.length, 1);

      sidecar.enqueue({});
      const uninterrupted = await uploadPdf(TWO_TENANT_IDS.userB, 'root/direct.pdf');
      assert.equal(uninterrupted.status, 'ready');
      assert.ok(uninterrupted.documentId);
      const reference = await contentRows(uninterrupted.documentId);
      const shape = (list: Row[]) =>
        list.map((chunk) => ({
          index: chunk.chunk_index,
          content: chunk.content,
          hash: chunk.content_hash,
          kind: chunk.chunk_kind,
          path: chunk.section_path,
          pages: [chunk.page_start, chunk.page_end],
          metadata: chunk.metadata,
        }));
      assert.deepEqual(shape(chunks), shape(reference), 'the resumed run produced the chunks an uninterrupted run produces');
    });

    test('a job the sidecar no longer knows is resubmitted once on resume and still reaches ready', async () => {
      sidecar.enqueue({ statuses: ['running'] }, {});
      const interrupted = await uploadPdf(TWO_TENANT_IDS.userA, 'root/expired.pdf', 'scan-en', 'scanned_image');
      assert.equal(interrupted.status, 'processing');
      assert.ok(interrupted.documentId);
      assert.equal(sidecar.uploads.length, 1);

      sidecar.expire('job1');
      const response = await resumeVia(TWO_TENANT_IDS.userA, interrupted.documentId);

      assert.equal(response.status, 200);
      assert.equal(((await response.json()) as Record<string, unknown>).status, 'ready');
      assert.equal(sidecar.uploads.length, 2, 'one resubmit and no more');
      const chunks = await contentRows(interrupted.documentId);
      assert.ok(chunks.length > 1);
      assert.deepEqual(chunks.map((chunk) => chunk.chunk_index), chunks.map((_, index) => index));
    });

    test('another tenant sees no status for the interrupted document and cannot resume it; the sidecar is not touched', async () => {
      slowJob();
      const interrupted = await uploadPdf(TWO_TENANT_IDS.userA, 'root/private.pdf', 'scan-zh', 'scanned_image');
      assert.ok(interrupted.documentId);
      const documentId = interrupted.documentId;
      const seen = sidecar.calls.length;
      const unknown = '00000000-0000-4000-8000-00000000dfff';

      const foreignStatus = await statusVia(TWO_TENANT_IDS.userB, documentId);
      const unknownStatus = await statusVia(TWO_TENANT_IDS.userB, unknown);
      assert.equal(foreignStatus.status, 404);
      assert.equal(unknownStatus.status, 404);
      assert.deepEqual(await foreignStatus.json(), await unknownStatus.json());
      const foreignResume = await resumeVia(TWO_TENANT_IDS.userB, documentId);
      const unknownResume = await resumeVia(TWO_TENANT_IDS.userB, unknown);
      assert.equal(foreignResume.status, 404);
      assert.deepEqual(await foreignResume.json(), await unknownResume.json());

      assert.equal(callsSince(seen).length, 0, 'the sidecar saw nothing');
      const [untouched] = await rows('SELECT status, processing_state FROM documents WHERE id = $1', [documentId]);
      assert.equal(untouched?.status, 'processing');
      assert.equal((untouched?.processing_state as { parseJob?: { jobId: string } }).parseJob?.jobId, 'job1');
      assert.equal((await contentRows(documentId)).length, 0);
    });

    test('a version still processing after 24 hours is failed by the status read, only in its own tenant, and the same file can then be uploaded again as a new version', async () => {
      slowJob();
      const stale = await uploadPdf(TWO_TENANT_IDS.userA, 'root/stale.pdf', 'scan-it', 'scanned_image');
      sidecar.enqueue({ statuses: ['running'] });
      const foreign = await uploadPdf(TWO_TENANT_IDS.userB, 'root/stale-b.pdf', 'scan-zh', 'scanned_image');
      assert.ok(stale.documentId && foreign.documentId);
      assert.equal(stale.status, 'processing');
      assert.equal(foreign.status, 'processing');

      depsModule.setIngestDepsForTests({ now: () => Date.now() + 25 * HOUR });
      const first = await statusVia(TWO_TENANT_IDS.userA, stale.documentId);
      assert.equal(first.status, 200);
      const view = (await first.json()) as Record<string, unknown>;
      assert.equal(view.status, 'failed');
      assert.equal(view.reason, 'stale_processing');
      const [reaped] = await rows('SELECT status, processing_status, is_current, processing_state FROM documents WHERE id = $1', [stale.documentId]);
      assert.equal(reaped?.status, 'failed');
      assert.equal(reaped?.is_current, false);
      assert.equal((reaped?.processing_state as { failure_reason?: string }).failure_reason, 'stale_processing');

      const [other] = await rows('SELECT status FROM documents WHERE id = $1', [foreign.documentId]);
      assert.equal(other?.status, 'processing', 'the other tenant row was not touched');
      const asA = await statusVia(TWO_TENANT_IDS.userA, foreign.documentId);
      assert.equal(asA.status, 404);
      const [stillOther] = await rows('SELECT status FROM documents WHERE id = $1', [foreign.documentId]);
      assert.equal(stillOther?.status, 'processing', 'asking for another tenant id reaped nothing');

      const resumed = await resumeVia(TWO_TENANT_IDS.userA, stale.documentId);
      assert.equal(resumed.status, 200);
      const settled = (await resumed.json()) as Record<string, unknown>;
      assert.equal(settled.status, 'failed');
      assert.equal(settled.reason, 'stale_processing');

      clock = 1_000_000;
      depsModule.setIngestDepsForTests({ now: () => clock });
      sidecar.enqueue({});
      const retried = await uploadPdf(TWO_TENANT_IDS.userA, 'root/stale.pdf', 'scan-it', 'scanned_image');
      assert.equal(retried.status, 'ready');
      assert.notEqual(retried.documentId, stale.documentId);
      assert.equal(retried.version, 2, 'the retry is a new version of the same lineage');
    });
  });
});
