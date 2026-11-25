import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { THREE_PAGES } from '../../tests/helpers/fake-llamaparse.ts';
import { pdfBytes, startQueuedHarness, type QueuedHarness } from '../../eval/harness/queued-ingest.mts';

const WORKER = 'pending-worker';
const OPTIONS_HASH = 'e'.repeat(64);

describe('parse-external: a LlamaParse job that outlasts the slice is handed back as pending and resumed, not resubmitted', () => {
  let harness: QueuedHarness;
  let baseEnv: Record<string, string | undefined>;
  let depsModule: typeof import('@/lib/rag/ingest/deps');

  before(async () => {
    harness = await startQueuedHarness({
      llamaSpecs: [{ statuses: [...Array<string>(80).fill('RUNNING'), 'COMPLETED'], pages: THREE_PAGES }],
      llamaSleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 15))),
    });
    depsModule = await import('@/lib/rag/ingest/deps');
    baseEnv = depsModule.getIngestDeps().ingestEnv() as Record<string, string | undefined>;
    depsModule.setIngestDepsForTests({ ingestEnv: () => ({ ...baseEnv, RAG_PARSE_POLL_BUDGET_MS: '1000' }) });
  });

  after(async () => {
    depsModule?.setIngestDepsForTests({ ingestEnv: () => baseEnv });
    await harness?.close();
  });

  test('pending with a continuation, then done on the same LlamaParse job, then ready', async () => {
    const enqueueModule = await import('@/lib/rag/ingest/enqueue');
    const queued = await enqueueModule.enqueueIngest({
      scope: harness.scopeA,
      source: 'config_upload',
      sourceKey: 'root/slow.pdf',
      file: pdfBytes('slow'),
      filename: 'slow.pdf',
      mimeType: 'application/pdf',
      docType: 'general',
      signal: new AbortController().signal,
    });
    assert.equal(queued.status, 'queued');
    const jobId = String(queued.jobId);
    await harness.claim(jobId, WORKER);

    const first = await harness.callback(jobId, 'parse-external', { worker_id: WORKER, attempt_no: 1, mode: 'chain', options_hash: OPTIONS_HASH });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.status, 'pending');
    const continuation = String(first.body.continuation);
    assert.ok(continuation.length > 0);
    assert.equal(typeof first.body.retry_after_ms, 'number');
    assert.equal(harness.llama.uploads.length, 1);

    const [pending] = await harness.rows('SELECT stage_state, status FROM ingestion_jobs WHERE id = $1', [jobId]);
    const state = pending?.stage_state as Record<string, unknown>;
    assert.equal((state.parseJob as Record<string, unknown>).jobId, continuation, 'the ledger holds the parse job the continuation names');
    assert.equal(state.cursor, undefined, 'a pending parse has no post-parse position');
    assert.equal(pending?.status, 'parsing');

    let reply = first;
    for (let call = 0; call < 20 && reply.body.status === 'pending'; call += 1) {
      reply = await harness.callback(jobId, 'parse-external', {
        worker_id: WORKER,
        attempt_no: 1,
        mode: 'chain',
        options_hash: OPTIONS_HASH,
        continuation: String(reply.body.continuation),
      });
      assert.equal(reply.status, 200, JSON.stringify(reply.body));
    }
    assert.equal(reply.body.status, 'done', JSON.stringify(reply.body));
    assert.equal(harness.llama.uploads.length, 1, 'the running job was polled again, never uploaded twice');
    const cacheId = String(reply.body.cache_id);

    let cursor: string | null = null;
    for (let call = 0; call < 30; call += 1) {
      const advanced = await harness.callback(jobId, 'advance', {
        worker_id: WORKER,
        attempt_no: 1,
        phase: 'post_parse',
        parse_cache_id: cacheId,
        deadline_ms: 40_000,
        cursor,
      });
      assert.equal(advanced.status, 200, JSON.stringify(advanced.body));
      if (advanced.body.done === true) {
        assert.equal(advanced.body.status, 'ready');
        break;
      }
      cursor = String(advanced.body.stage);
    }
    const [job] = await harness.rows('SELECT status, parser_used, stage_state FROM ingestion_jobs WHERE id = $1', [jobId]);
    assert.equal(job?.status, 'ready');
    assert.equal(job?.parser_used, 'llamaparse');
    assert.equal((job?.stage_state as Record<string, unknown>).parseJob, null, 'the finished parse job is cleared from the state');
  });

  test('a continuation that is not the parse job of this job is ignored: no foreign job id is polled', async () => {
    const enqueueModule = await import('@/lib/rag/ingest/enqueue');
    const queued = await enqueueModule.enqueueIngest({
      scope: harness.scopeA,
      source: 'config_upload',
      sourceKey: 'root/slow-two.pdf',
      file: pdfBytes('slow two'),
      filename: 'slow-two.pdf',
      mimeType: 'application/pdf',
      docType: 'general',
      signal: new AbortController().signal,
    });
    const jobId = String(queued.jobId);
    await harness.claim(jobId, WORKER);
    const uploads = harness.llama.uploads.length;
    const polledBefore = harness.llama.calls.filter((call) => call.method === 'GET').length;
    const reply = await harness.callback(jobId, 'parse-external', {
      worker_id: WORKER,
      attempt_no: 1,
      mode: 'chain',
      options_hash: OPTIONS_HASH,
      continuation: 'someone-elses-llamaparse-job',
    });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal(harness.llama.uploads.length, uploads + 1, 'a new upload, not a poll of the forged id');
    const polled = harness.llama.calls.filter((call) => call.method === 'GET' && call.path.includes('someone-elses-llamaparse-job'));
    assert.equal(polled.length, 0);
    assert.ok(harness.llama.calls.filter((call) => call.method === 'GET').length >= polledBefore);
  });
});
