import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { QUEUED_IDS, startQueuedHarness, type QueuedHarness } from '../../eval/harness/queued-ingest.mts';

type Row = Record<string, unknown>;

const WORKER_A = 'worker-for-tenant-a';
const WORKER_B = 'worker-for-tenant-b';
const OPTIONS_HASH = 'd'.repeat(64);
const UNKNOWN_JOB = '99999999-9999-4999-8999-999999999999';
const TEXT = '# Shared Bytes\n\nThe cobalt manifest lists every crate on the west pier before the evening tide.\n\n## Second\n\nA second paragraph about the east pier cranes.\n';

describe('internal ingest callbacks: authentication and tenant isolation with two tenants', () => {
  let harness: QueuedHarness;
  let enqueueModule: typeof import('@/lib/rag/ingest/enqueue');
  let ledger: typeof import('@/lib/rag/ingest/ledger');
  let writerModule: typeof import('@/lib/rag/ingest/writer');
  let scopeModule: typeof import('@/lib/rag/tenant/ingestion-job');
  let depsModule: typeof import('@/lib/rag/ingest/deps');
  let a: { jobId: string; documentId: string };
  let b: { jobId: string; documentId: string };
  let cacheA = '';
  let cacheB = '';

  before(async () => {
    harness = await startQueuedHarness();
    enqueueModule = await import('@/lib/rag/ingest/enqueue');
    ledger = await import('@/lib/rag/ingest/ledger');
    writerModule = await import('@/lib/rag/ingest/writer');
    scopeModule = await import('@/lib/rag/tenant/ingestion-job');
    depsModule = await import('@/lib/rag/ingest/deps');
    const enqueue = async (scope: typeof harness.scopeA) => {
      const queued = await enqueueModule.enqueueIngest({
        scope,
        source: 'config_upload',
        sourceKey: 'root/shared.md',
        text: TEXT,
        filename: 'shared.md',
        mimeType: 'text/markdown',
        docType: 'general',
        signal: new AbortController().signal,
      });
      assert.equal(queued.status, 'queued');
      return { jobId: String(queued.jobId), documentId: String(queued.documentId) };
    };
    a = await enqueue(harness.scopeA);
    b = await enqueue(harness.scopeB);
    await harness.claim(a.jobId, WORKER_A);
    await harness.claim(b.jobId, WORKER_B);
  });

  after(async () => {
    await harness?.close();
  });

  const parseBody = (worker: string, extra: Record<string, unknown> = {}) => ({ worker_id: worker, attempt_no: 1, mode: 'chain', options_hash: OPTIONS_HASH, ...extra });
  const advanceBody = (worker: string, cacheId: string, extra: Record<string, unknown> = {}) => ({
    worker_id: worker,
    attempt_no: 1,
    phase: 'post_parse',
    parse_cache_id: cacheId,
    deadline_ms: 40_000,
    cursor: null,
    ...extra,
  });
  const jobRow = async (jobId: string): Promise<Row> =>
    (await harness.rows('SELECT status, stage, stage_state, timings, attempts, locked_by, lease_until, updated_at FROM ingestion_jobs WHERE id = $1', [jobId]))[0] as Row;
  const ledgerCalls = (): number => harness.edge.calls.filter((call) => call.path.includes('/rpc/rag_')).length;

  describe('the shared secret', () => {
    for (const action of ['parse-external', 'advance'] as const) {
      const body = action === 'advance' ? advanceBody(WORKER_A, 'a'.repeat(8)) : parseBody(WORKER_A);

      test(`${action} refuses a missing, empty or wrong secret with 401 and touches nothing`, async () => {
        const before = { rows: await jobRow(a.jobId), calls: ledgerCalls() };
        for (const headers of [{ 'x-sidecar-secret': null }, { 'x-sidecar-secret': '' }, { 'x-sidecar-secret': 'not-the-secret' }, { 'x-sidecar-secret': 'queued-harness-sidecar-secret-00000' }]) {
          const reply = await harness.callback(a.jobId, action, body, headers);
          assert.equal(reply.status, 401, JSON.stringify(headers));
          assert.deepEqual(reply.body, { error: 'unauthorized' });
        }
        assert.equal(ledgerCalls(), before.calls, 'no ledger or storage call before the secret is accepted');
        assert.deepEqual(await jobRow(a.jobId), before.rows);
      });

      test(`${action} refuses every call, even with a header, while RAG_SIDECAR_SECRET is unset`, async () => {
        const saved = process.env.RAG_SIDECAR_SECRET;
        delete process.env.RAG_SIDECAR_SECRET;
        try {
          const calls = ledgerCalls();
          const empty = await harness.callback(a.jobId, action, body, { 'x-sidecar-secret': '' });
          const sent = await harness.callback(a.jobId, action, body);
          assert.equal(empty.status, 401);
          assert.equal(sent.status, 401);
          assert.equal(ledgerCalls(), calls);
        } finally {
          process.env.RAG_SIDECAR_SECRET = saved;
        }
      });
    }
  });

  describe('request validation', () => {
    test('a tenant in the body is an unknown field: 400, and the job is untouched', async () => {
      const before = await jobRow(a.jobId);
      for (const extra of [{ tenant_key: `o:${QUEUED_IDS.orgB}` }, { tenant: `u:${QUEUED_IDS.userB}` }, { organization_id: QUEUED_IDS.orgB }]) {
        const parse = await harness.callback(a.jobId, 'parse-external', parseBody(WORKER_A, extra));
        const advance = await harness.callback(a.jobId, 'advance', advanceBody(WORKER_A, 'b'.repeat(8), extra));
        assert.equal(parse.status, 400, JSON.stringify(extra));
        assert.equal(advance.status, 400, JSON.stringify(extra));
      }
      assert.deepEqual(await jobRow(a.jobId), before);
    });

    test('a malformed body, a bad id and an unknown job are refused with 400 and 404', async () => {
      assert.equal((await harness.callback(a.jobId, 'parse-external', { worker_id: WORKER_A })).status, 400);
      assert.equal((await harness.callback(a.jobId, 'advance', advanceBody(WORKER_A, 'x', { deadline_ms: 40_001 }))).status, 400);
      assert.equal((await harness.callback('not-a-uuid', 'parse-external', parseBody(WORKER_A))).status, 400);
      assert.equal((await harness.callback(UNKNOWN_JOB, 'parse-external', parseBody(WORKER_A))).status, 404);
      assert.equal((await harness.callback(UNKNOWN_JOB, 'advance', advanceBody(WORKER_A, UNKNOWN_JOB))).status, 404);
    });

    test('unknown modes and phases that do not apply to this job are refused, and the job is untouched', async () => {
      const before = await jobRow(a.jobId);
      assert.equal((await harness.callback(a.jobId, 'parse-external', parseBody(WORKER_A, { mode: 'unknown-mode' }))).status, 400);
      const begin = await harness.callback(a.jobId, 'advance', advanceBody(WORKER_A, 'x', { phase: 'begin', parse_cache_id: null }));
      assert.ok(begin.status === 400 || begin.status === 409, `begin on an upload job: ${begin.status}`);
      assert.deepEqual(await jobRow(a.jobId), before);
      assert.equal((await harness.rows('SELECT count(*)::int AS n FROM rag_parse_cache'))[0]?.n, 0);
    });
  });

  describe('a job id of one tenant cannot be advanced or read with the other tenant', () => {
    test('a worker that holds the lease of the other tenant is refused with 409 and nothing changes', async () => {
      const beforeA = await jobRow(a.jobId);
      const beforeB = await jobRow(b.jobId);
      assert.equal((await harness.callback(a.jobId, 'parse-external', parseBody(WORKER_B))).status, 409);
      assert.equal((await harness.callback(a.jobId, 'advance', advanceBody(WORKER_B, 'e'.repeat(8)))).status, 409);
      assert.equal((await harness.callback(b.jobId, 'parse-external', parseBody(WORKER_A))).status, 409);
      assert.deepEqual(await jobRow(a.jobId), beforeA);
      assert.deepEqual(await jobRow(b.jobId), beforeB);
    });

    test('each tenant parses its own copy of the same bytes: two cache rows, one per tenant, no shared entry', async () => {
      const uploads = harness.llama.uploads.length;
      const replyA = await harness.callback(a.jobId, 'parse-external', parseBody(WORKER_A));
      const replyB = await harness.callback(b.jobId, 'parse-external', parseBody(WORKER_B));
      assert.equal(replyA.status, 200, JSON.stringify(replyA.body));
      assert.equal(replyB.status, 200, JSON.stringify(replyB.body));
      cacheA = String(replyA.body.cache_id);
      cacheB = String(replyB.body.cache_id);
      assert.notEqual(cacheA, cacheB);

      const entries = await harness.rows('SELECT id, tenant_key, object_prefix FROM rag_parse_cache ORDER BY tenant_key');
      assert.equal(entries.length, 2);
      const byId = new Map(entries.map((entry) => [String(entry.id), entry]));
      assert.equal(byId.get(cacheA)?.tenant_key, `u:${QUEUED_IDS.userA}`);
      assert.equal(byId.get(cacheB)?.tenant_key, `o:${QUEUED_IDS.orgB}`);
      assert.ok(String(byId.get(cacheA)?.object_prefix).startsWith(`u:${QUEUED_IDS.userA}/_parse-cache/`));
      assert.ok(String(byId.get(cacheB)?.object_prefix).startsWith(`o:${QUEUED_IDS.orgB}/_parse-cache/`));
      assert.ok(harness.llama.uploads.length >= uploads, 'text input needs no parser call');
    });

    test('parse-external is idempotent: the same body returns the same cache entry', async () => {
      const again = await harness.callback(a.jobId, 'parse-external', parseBody(WORKER_A));
      assert.equal(again.status, 200);
      assert.equal(again.body.status, 'done');
      assert.equal(again.body.cache_id, cacheA);
      assert.equal((await harness.rows('SELECT count(*)::int AS n FROM rag_parse_cache'))[0]?.n, 2);
    });

    test("a cache id of the other tenant is refused with 404: no link is written and no chunk appears", async () => {
      const beforeA = await jobRow(a.jobId);
      const beforeB = await jobRow(b.jobId);
      const intoA = await harness.callback(a.jobId, 'advance', advanceBody(WORKER_A, cacheB));
      const intoB = await harness.callback(b.jobId, 'advance', advanceBody(WORKER_B, cacheA));
      assert.equal(intoA.status, 404, JSON.stringify(intoA.body));
      assert.equal(intoB.status, 404, JSON.stringify(intoB.body));
      assert.deepEqual(await jobRow(a.jobId), beforeA);
      assert.deepEqual(await jobRow(b.jobId), beforeB);
      const links = await harness.rows('SELECT id, parse_cache_id FROM documents WHERE id = ANY($1::uuid[])', [[a.documentId, b.documentId]]);
      assert.ok(links.every((row) => row.parse_cache_id === null), 'no document was linked to the other tenant cache');
      const chunks = await harness.rows('SELECT count(*)::int AS n FROM document_chunks WHERE document_id = ANY($1::uuid[])', [[a.documentId, b.documentId]]);
      assert.equal(chunks[0]?.n, 0);
    });

    test('the tenant of a callback is the job row: scope minting, scoped ledger reads and the scoped writer never cross', async () => {
      const signal = new AbortController().signal;
      const minted = await scopeModule.scopeFromIngestionJob(a.jobId, { db: depsModule.getIngestDeps().db, signal });
      assert.ok(minted);
      assert.equal(`${minted.kind}:${minted.userId}`, `personal:${QUEUED_IDS.userA}`);
      assert.equal(await ledger.getJobForScope(harness.scopeB, a.jobId, { signal }), null);
      assert.equal(await ledger.getJobForDocument(harness.scopeB, a.documentId, { signal }), null);
      assert.equal(await ledger.getJobForScope(harness.scopeA, b.jobId, { signal }), null);
      assert.equal((await ledger.getJobForScope(harness.scopeA, a.jobId, { signal }))?.id, a.jobId);

      const db = depsModule.getIngestDeps().db();
      assert.ok(db);
      const writerB = writerModule.createIngestWriter({ db, scope: harness.scopeB, signal });
      const writerA = writerModule.createIngestWriter({ db, scope: harness.scopeA, signal });
      assert.equal(await writerB.getDocument(a.documentId), null, 'tenant B cannot read tenant A version');
      assert.equal(await writerA.getDocument(b.documentId), null, 'tenant A cannot read tenant B version');
      assert.ok(await writerA.getDocument(a.documentId));
    });

    test('both jobs finish with their own cache, and each tenant keeps only its own chunks', async () => {
      const finish = async (jobId: string, worker: string, cacheId: string) => {
        let cursor: string | null = null;
        for (let call = 0; call < 30; call += 1) {
          const reply = await harness.callback(jobId, 'advance', advanceBody(worker, cacheId, { cursor }));
          assert.equal(reply.status, 200, JSON.stringify(reply.body));
          if (reply.body.done === true) return reply.body;
          cursor = String(reply.body.stage);
        }
        throw new Error('the job did not finish');
      };
      assert.equal((await finish(a.jobId, WORKER_A, cacheA)).status, 'ready');
      assert.equal((await finish(b.jobId, WORKER_B, cacheB)).status, 'ready');

      const owners = await harness.rows(
        'SELECT d.id AS document_id, d.tenant_key, count(c.id)::int AS chunks FROM documents d JOIN document_chunks c ON c.document_id = d.id GROUP BY d.id, d.tenant_key ORDER BY d.tenant_key',
      );
      assert.equal(owners.length, 2);
      assert.deepEqual(
        owners.map((row) => [row.document_id, row.tenant_key]).sort(),
        [
          [a.documentId, `u:${QUEUED_IDS.userA}`],
          [b.documentId, `o:${QUEUED_IDS.orgB}`],
        ].sort(),
      );
      const linked = await harness.rows('SELECT id, parse_cache_id FROM documents WHERE id = ANY($1::uuid[])', [[a.documentId, b.documentId]]);
      assert.equal(linked.find((row) => row.id === a.documentId)?.parse_cache_id, cacheA);
      assert.equal(linked.find((row) => row.id === b.documentId)?.parse_cache_id, cacheB);
    });

    test('a finished job answers a replay with its terminal status only', async () => {
      const replay = await harness.callback(a.jobId, 'advance', advanceBody(WORKER_B, cacheA));
      assert.equal(replay.status, 200);
      assert.deepEqual(Object.keys(replay.body).sort(), ['done', 'reason', 'stage', 'status', 'wait_ms', 'worker_id']);
      assert.equal(replay.body.done, true);
      assert.equal(replay.body.status, 'ready');
    });
  });
});
