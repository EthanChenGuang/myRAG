import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { QUEUED_IDS, startQueuedHarness, type QueuedHarness } from '../../eval/harness/queued-ingest.mts';

// Plan 03.2-14 task 2 (D-12, D-36, D-56): the queued path holds the same way as the inline one. The decision is made at enqueue,
// frozen in the job settings snapshot and enforced at publish whatever RAG_UPLOAD_APPROVAL says by then; a job of a batch with
// hold_publish ends ready on the ledger while its version stays unpublished. Tenant B is an organization whose user is a plain member.

type Row = Record<string, unknown>;

const WORKER = 'worker-upload-approval';
const OPTIONS_HASH = 'e'.repeat(64);

function text(token: string, colour: string): string {
  return `# Widget Notes\n\nThe ${colour} widget is fastened to the grey panel with four brass screws, as the ${token} note records.\n\n## More\n\nA second neutral paragraph about the ${colour} widget and the oak frame.\n`;
}

describe('upload approval on the queued unified path', () => {
  let harness: QueuedHarness;
  let enqueueModule: typeof import('@/lib/rag/ingest/enqueue');
  let depsModule: typeof import('@/lib/rag/ingest/deps');
  let baseEnv: () => Record<string, unknown>;

  before(async () => {
    harness = await startQueuedHarness();
    enqueueModule = await import('@/lib/rag/ingest/enqueue');
    depsModule = await import('@/lib/rag/ingest/deps');
    baseEnv = depsModule.getIngestDeps().ingestEnv as () => Record<string, unknown>;
  });

  after(async () => {
    depsModule?.setIngestDepsForTests({ ingestEnv: baseEnv as never });
    await harness?.close();
  });

  const withMode = (mode: 'off' | 'members' | 'all') => {
    depsModule.setIngestDepsForTests({ ingestEnv: (() => ({ ...baseEnv(), RAG_UPLOAD_APPROVAL: mode })) as never });
  };

  const enqueue = async (scope: typeof harness.scopeB, sourceKey: string, body: string, options: { batchId?: string; holdPublish?: boolean } = {}) => {
    const queued = await enqueueModule.enqueueIngest(
      {
        scope,
        source: 'config_upload',
        sourceKey,
        text: body,
        filename: sourceKey.slice(sourceKey.lastIndexOf('/') + 1),
        mimeType: 'text/markdown',
        docType: 'general',
        uploaderId: scope.userId,
        signal: new AbortController().signal,
      },
      options,
    );
    assert.equal(queued.status, 'queued', JSON.stringify(queued));
    return { jobId: String(queued.jobId), documentId: String(queued.documentId) };
  };

  const run = async (jobId: string) => {
    await harness.claim(jobId, WORKER);
    const parsed = await harness.callback(jobId, 'parse-external', { worker_id: WORKER, attempt_no: 1, mode: 'chain', options_hash: OPTIONS_HASH });
    assert.equal(parsed.status, 200, JSON.stringify(parsed.body));
    let cursor: string | null = null;
    for (let call = 0; call < 30; call += 1) {
      const reply = await harness.callback(jobId, 'advance', {
        worker_id: WORKER,
        attempt_no: 1,
        phase: 'post_parse',
        parse_cache_id: parsed.body.cache_id,
        deadline_ms: 40_000,
        cursor,
      });
      assert.equal(reply.status, 200, JSON.stringify(reply.body));
      if (reply.body.done === true) return reply.body;
      cursor = String(reply.body.stage);
    }
    throw new Error('the job did not finish');
  };

  const job = async (jobId: string): Promise<Row> => (await harness.rows('SELECT status, settings, locked_by FROM ingestion_jobs WHERE id = $1', [jobId]))[0] as Row;
  const doc = async (documentId: string): Promise<Row> =>
    (await harness.rows('SELECT status, is_current, metadata FROM documents WHERE id = $1', [documentId]))[0] as Row;
  const chunkStatuses = async (documentId: string) =>
    (await harness.rows('SELECT DISTINCT status FROM document_chunks WHERE document_id = $1', [documentId])).map((row) => row.status);

  test("a member's queued upload ends pending_review on the ledger and the document is held", async () => {
    withMode('members');
    const queued = await enqueue(harness.scopeB, 'root/held.md', text('zqxqheld', 'blue'));
    const settings = (await job(queued.jobId)).settings as Row;
    const approval = (settings.approval ?? {}) as Row;
    assert.deepEqual(
      { required: approval.required, reason: approval.reason, uploader: approval.uploader_id },
      { required: true, reason: 'member_upload', uploader: QUEUED_IDS.userB },
    );
    const done = await run(queued.jobId);
    assert.equal(done.status, 'pending_review');
    const ledger = await job(queued.jobId);
    assert.equal(ledger.status, 'pending_review');
    assert.equal(ledger.locked_by, null, 'the lease is released');
    const document = await doc(queued.documentId);
    assert.deepEqual([document.status, document.is_current], ['pending_review', false]);
    assert.deepEqual(await chunkStatuses(queued.documentId), ['pending_review']);
  });

  test('the decision made at enqueue is the one enforced, even when the mode changes before the job runs', async () => {
    withMode('members');
    const held = await enqueue(harness.scopeB, 'root/frozen.md', text('zqxqfrozen', 'green'));
    withMode('off');
    assert.equal((await run(held.jobId)).status, 'pending_review');
    assert.equal((await doc(held.documentId)).status, 'pending_review');

    withMode('off');
    const open = await enqueue(harness.scopeB, 'root/open.md', text('zqxqopen', 'red'));
    assert.equal('approval' in ((await job(open.jobId)).settings as Row), false, 'no approval key in the snapshot while off');
    withMode('all');
    assert.equal((await run(open.jobId)).status, 'ready');
    const document = await doc(open.documentId);
    assert.deepEqual([document.status, document.is_current], ['ready', true]);
  });

  test("a personal workspace's own queued upload is not held and writes no approval into the snapshot", async () => {
    withMode('members');
    const own = await enqueue(harness.scopeA, 'root/own.md', text('zqxqown', 'yellow'));
    assert.equal('approval' in ((await job(own.jobId)).settings as Row), false);
    assert.equal((await run(own.jobId)).status, 'ready');
  });

  test('a job of a batch with hold_publish ends ready on the ledger; its version carries publish_hold and the previous one stays current', async () => {
    withMode('off');
    const first = await enqueue(harness.scopeA, 'root/batch.md', text('zqxqbatch1', 'purple'));
    assert.equal((await run(first.jobId)).status, 'ready');

    const batchId = randomUUID();
    await harness.db.query(
      `INSERT INTO ingestion_batches (id, tenant_key, source_kind, source_ref, budget_usd, concurrency, runner, status, hold_publish)
       VALUES ($1, $2, 'folder', '/tmp/rebuild', 100, 2, 'worker', 'running', true)`,
      [batchId, `u:${QUEUED_IDS.userA}`],
    );
    const second = await enqueue(harness.scopeA, 'root/batch.md', text('zqxqbatch2', 'orange'), { batchId, holdPublish: true });
    assert.notEqual(second.documentId, first.documentId);
    assert.equal(((await job(second.jobId)).settings as Row).hold_publish, true);
    const done = await run(second.jobId);
    assert.equal(done.status, 'ready');
    assert.equal((await job(second.jobId)).status, 'ready');

    // The ledger's ready mirrors status ready onto the row (0801); what keeps it out of retrieval is that it was never made current.
    const held = await doc(second.documentId);
    assert.equal(held.is_current, false);
    assert.deepEqual((held.metadata as Row).publish_hold, { batch_id: batchId });
    const chunks = await harness.rows('SELECT status, is_current FROM document_chunks WHERE document_id = $1', [second.documentId]);
    assert.ok(chunks.length >= 1);
    for (const chunk of chunks) {
      assert.equal(chunk.is_current, false);
      assert.notEqual(chunk.status, 'ready');
    }
    const outcome = (await harness.rows('SELECT outcome FROM rag_publish_document_version($1, $2)', [second.documentId, `u:${QUEUED_IDS.userA}`]))[0] as Row;
    assert.equal(outcome.outcome, 'held', 'a direct publish is refused until the batch hold is released');
    const previous = await doc(first.documentId);
    assert.deepEqual([previous.status, previous.is_current], ['ready', true]);
  });
});
