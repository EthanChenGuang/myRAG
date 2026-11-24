import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkFingerprint, startQueuedHarness, type QueuedHarness } from '../../eval/harness/queued-ingest.mts';

type Row = Record<string, unknown>;

const WORKER = 'idempotency-worker';
const OPTIONS_HASH = 'c'.repeat(64);
const POST_PARSE = ['content_hash_dedup', 'scan_injection', 'chunk', 'enrich', 'extract', 'images', 'embed', 'write', 'publish'] as const;

/** n sections of about forty words each: the markdown chunker makes one chunk per section. */
function sections(label: string, count: number): string {
  const body = Array.from(
    { length: count },
    (_, i) => `## Section ${label} ${i}\n\n${Array.from({ length: 40 }, (_, w) => `${label}${i}w${w}`).join(' ')}\n`,
  ).join('\n');
  return `# Document ${label}\n\n${body}`;
}

describe('stage idempotency: a slice is bounded, a replay changes nothing and a stage run twice leaves the same chunks', () => {
  let harness: QueuedHarness;
  let enqueueModule: typeof import('@/lib/rag/ingest/enqueue');
  let ingestModule: typeof import('@/lib/rag/ingest');
  let writerModule: typeof import('@/lib/rag/ingest/writer');

  before(async () => {
    harness = await startQueuedHarness();
    enqueueModule = await import('@/lib/rag/ingest/enqueue');
    ingestModule = await import('@/lib/rag/ingest');
    writerModule = await import('@/lib/rag/ingest/writer');
  });

  after(async () => {
    await harness?.close();
  });

  const enqueueText = async (scope: typeof harness.scopeA, label: string, text: string) => {
    const queued = await enqueueModule.enqueueIngest({
      scope,
      source: 'config_upload',
      sourceKey: `root/${label}.md`,
      text,
      filename: `${label}.md`,
      mimeType: 'text/markdown',
      docType: 'general',
      signal: new AbortController().signal,
    });
    assert.equal(queued.status, 'queued');
    return { jobId: String(queued.jobId), documentId: String(queued.documentId) };
  };

  /** Claims the job as WORKER and runs parse-external in chain mode; returns the cache id. */
  const claimAndParse = async (jobId: string): Promise<string> => {
    await harness.claim(jobId, WORKER);
    const parsed = await harness.callback(jobId, 'parse-external', { worker_id: WORKER, attempt_no: 1, mode: 'chain', options_hash: OPTIONS_HASH });
    assert.equal(parsed.status, 200, JSON.stringify(parsed.body));
    assert.equal(parsed.body.status, 'done');
    return String(parsed.body.cache_id);
  };

  const advanceBody = (cacheId: string, cursor: string | null, deadlineMs: number) => ({
    worker_id: WORKER,
    attempt_no: 1,
    phase: 'post_parse',
    parse_cache_id: cacheId,
    deadline_ms: deadlineMs,
    cursor,
  });

  const jobRow = async (jobId: string): Promise<Row> => (await harness.rows('SELECT status, stage, stage_state, timings, updated_at FROM ingestion_jobs WHERE id = $1', [jobId]))[0] as Row;

  test('a 900-chunk document with a 1 ms slice budget needs several advance calls and ends with exactly 900 chunks', async () => {
    const { jobId, documentId } = await enqueueText(harness.scopeA, 'nine-hundred', sections('nine', 900));
    const cacheId = await claimAndParse(jobId);

    const requests: Array<ReturnType<typeof advanceBody>> = [];
    const stages: string[] = [];
    let cursor: string | null = null;
    let last: Awaited<ReturnType<QueuedHarness['callback']>> | null = null;
    for (let call = 0; call < 40; call += 1) {
      const body = advanceBody(cacheId, cursor, 1);
      requests.push(body);
      last = await harness.callback(jobId, 'advance', body);
      assert.equal(last.status, 200, JSON.stringify(last.body));
      stages.push(String(last.body.stage));
      if (last.body.done === true) break;
      cursor = String(last.body.stage);
    }
    assert.ok(last);
    assert.equal(last.body.done, true);
    assert.equal(last.body.status, 'ready', JSON.stringify(last.body));
    assert.ok(requests.length >= POST_PARSE.length, `one stage per call at 1 ms, got ${requests.length} calls`);
    assert.deepEqual(stages.slice(0, -1), [...new Set(stages.slice(0, -1))], 'every call moved to a new stage');
    assert.deepEqual(stages.filter((stage) => POST_PARSE.includes(stage as (typeof POST_PARSE)[number])).slice(0, 3), ['content_hash_dedup', 'scan_injection', 'chunk']);

    const [{ n, distinct }] = (await harness.rows('SELECT count(*)::int AS n, count(DISTINCT id)::int AS distinct FROM document_chunks WHERE document_id = $1', [documentId])) as Array<{ n: number; distinct: number }>;
    assert.equal(n, 900);
    assert.equal(distinct, 900);
    const ids = (await harness.rows('SELECT id, chunk_index FROM document_chunks WHERE document_id = $1 ORDER BY chunk_index', [documentId])) as Array<{ id: string; chunk_index: number }>;
    assert.ok(ids.every((row) => row.id === writerModule.chunkIdFor(documentId, row.chunk_index)), 'chunk ids derive from the document id and the index');

    const before = await chunkFingerprint(harness, documentId);
    for (const request of requests) {
      const replay = await harness.callback(jobId, 'advance', request);
      assert.equal(replay.status, 200);
      assert.equal(replay.body.done, true, 'a replay after the end reports the terminal status');
      assert.equal(replay.body.status, 'ready');
    }
    assert.deepEqual(await chunkFingerprint(harness, documentId), before, 'replays changed no chunk');
  });

  test('replaying an earlier advance request in the middle of a run changes nothing and moves nothing', async () => {
    const { jobId, documentId } = await enqueueText(harness.scopeA, 'replay-middle', sections('replay', 8));
    const cacheId = await claimAndParse(jobId);

    const first = await harness.callback(jobId, 'advance', advanceBody(cacheId, null, 1));
    assert.equal(first.body.done, false);
    assert.equal(first.body.stage, 'content_hash_dedup');
    const second = await harness.callback(jobId, 'advance', advanceBody(cacheId, 'content_hash_dedup', 1));
    assert.equal(second.body.stage, 'scan_injection');

    const stored = await jobRow(jobId);
    const replay = await harness.callback(jobId, 'advance', advanceBody(cacheId, null, 1));
    assert.equal(replay.status, 200);
    assert.equal(replay.body.done, false);
    assert.equal(replay.body.stage, 'scan_injection', 'the replay is told where the job stands');
    assert.deepEqual(await jobRow(jobId), stored, 'the ledger row is untouched by the replay');
    assert.equal((await chunkFingerprint(harness, documentId)).chunks.length, 0, 'no chunk was written yet');
  });

  for (const stage of POST_PARSE.filter((name) => name !== 'publish')) {
    test(`stage ${stage} run twice leaves identical chunk ids, hashes and embeddings and no duplicates`, async () => {
      const text = sections(`twice-${stage}`, 6);
      const reference = await ingestModule.ingest({
        scope: harness.scopeB,
        source: 'config_upload',
        sourceKey: `root/reference-${stage}.md`,
        text,
        filename: `twice-${stage}.md`,
        mimeType: 'text/markdown',
        docType: 'general',
        signal: new AbortController().signal,
      });
      assert.equal(reference.status, 'ready');
      const expected = await chunkFingerprint(harness, String(reference.documentId), { embeddings: true });
      assert.equal(expected.chunks.length, 6);

      const { jobId, documentId } = await enqueueText(harness.scopeA, `twice-${stage}`, text);
      const cacheId = await claimAndParse(jobId);
      const previous = stage === 'content_hash_dedup' ? 'parse' : POST_PARSE[POST_PARSE.indexOf(stage) - 1];
      let cursor: string | null = null;
      let rewound = false;
      for (let call = 0; call < 40; call += 1) {
        const reply = await harness.callback(jobId, 'advance', advanceBody(cacheId, cursor, 1));
        assert.equal(reply.status, 200, JSON.stringify(reply.body));
        if (reply.body.done === true) break;
        cursor = String(reply.body.stage);
        if (reply.body.stage === stage && !rewound) {
          // The slice finished but its position was lost: the position goes back one stage and the worker resends that cursor.
          rewound = true;
          await harness.rows(
            `UPDATE ingestion_jobs SET stage_state = jsonb_set(jsonb_set(stage_state, '{cursor}', to_jsonb($2::text)), '{lastCompleted}', to_jsonb($2::text)) WHERE id = $1`,
            [jobId, previous],
          );
          cursor = previous;
        }
      }
      assert.ok(rewound, `the run reached ${stage}`);
      const [job] = await harness.rows('SELECT status, error_class FROM ingestion_jobs WHERE id = $1', [jobId]);
      assert.equal(job?.status, 'ready', String(job?.error_class));

      const actual = await chunkFingerprint(harness, documentId, { embeddings: true });
      assert.deepEqual(actual, expected, 'same chunks, hashes, paths, metadata and embeddings as one uninterrupted inline run');
      const ids = (await harness.rows('SELECT id, chunk_index FROM document_chunks WHERE document_id = $1 ORDER BY chunk_index', [documentId])) as Array<{ id: string; chunk_index: number }>;
      assert.equal(new Set(ids.map((row) => row.id)).size, ids.length, 'no duplicate chunk');
      assert.ok(ids.every((row) => row.id === writerModule.chunkIdFor(documentId, row.chunk_index)));
    });
  }
});
