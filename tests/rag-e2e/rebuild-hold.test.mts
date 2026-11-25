import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { QUEUED_IDS, startQueuedHarness, type QueuedHarness } from '../../eval/harness/queued-ingest.mts';

// Plan 03.2-19 task 1 (D-11, D-12, LANG-04): a reparse rebuild re-ingests exactly the affected documents from their stored originals as a
// Phase 3.1 batch with hold_publish. The new versions stay unpublished until an activation with recorded passing evidence; a rollback
// makes the previous versions current again with the vectors they had.

type Row = Record<string, unknown>;

const WORKER = 'worker-rebuild-hold';
const OPTIONS_HASH = 'f'.repeat(64);
const SAVED = { RAG_SUPPORTED_LANGUAGES: 'zh,en,it', RAG_PRIMARY_LANGUAGE: 'zh' };
const PASSING_GATE = { mismatches: [], offenders: [], skipped: [], passed: true };
const FAILING_GATE = {
  mismatches: [],
  offenders: [{ baseline_mean: 0.9, direction: 'higher', metric: 'recall_at_5', observed: 0.5, slice: 'general', threshold: 0.05 }],
  skipped: [],
  passed: false,
};

function text(token: string, colour: string): string {
  return `# Panel Notes\n\nThe ${colour} panel is held by four brass screws, as the ${token} note records.\n\n## More\n\nA second neutral paragraph about the ${colour} panel and the oak frame.\n`;
}

describe('a held reparse rebuild', () => {
  let harness: QueuedHarness;
  let rebuild: typeof import('@/lib/rag/ingest/rebuild/run');
  let fp: typeof import('@/lib/rag/ingest/fingerprint');
  let hooks: typeof import('@/lib/rag/ingest/post-publish');
  const published: string[] = [];
  const docs: Array<{ documentId: string; sourceKey: string }> = [];
  let runId = '';
  let tenantKey = '';

  const deps = () => ({
    saved: SAVED,
    ingestAsync: () => true,
    scopeFor: async (key: string) => (key === tenantKey ? harness.scopeA : null),
  });

  before(async () => {
    harness = await startQueuedHarness();
    tenantKey = `u:${QUEUED_IDS.userA}`;
    rebuild = await import('@/lib/rag/ingest/rebuild/run');
    fp = await import('@/lib/rag/ingest/fingerprint');
    hooks = await import('@/lib/rag/ingest/post-publish');
    hooks.registerPostPublishHook('rebuild-hold-test', (event) => {
      published.push(event.documentId);
    });
  });

  after(async () => {
    hooks?.resetPostPublishHooksForTests();
    await harness?.close();
  });

  const runJob = async (jobId: string) => {
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

  const doc = async (documentId: string): Promise<Row> =>
    (await harness.rows('SELECT id, lineage_id, status, is_current, metadata, ingest_fingerprint FROM documents WHERE id = $1', [documentId]))[0] as Row;
  const versionsOf = async (sourceKey: string) =>
    harness.rows('SELECT id, version, is_current, status, metadata FROM documents WHERE source_key = $1 ORDER BY version', [sourceKey]);
  const vectorCount = async (documentId: string) =>
    Number(
      (
        await harness.rows(
          `SELECT (SELECT count(*) FROM document_chunks c WHERE c.document_id = $1 AND c.embedding IS NOT NULL)
                + (SELECT count(*) FROM chunk_embeddings e JOIN document_chunks c ON c.id = e.chunk_id WHERE c.document_id = $1) AS n`,
          [documentId],
        )
      )[0]?.n ?? 0,
    );

  /** Stores parts on a document so that it differs (or not) from what the saved settings expect for the reparse mechanism. */
  const stamp = async (documentId: string, affected: boolean) => {
    const row = await doc(documentId);
    const stored = (row.metadata as Row).ingest_fingerprint_parts as Parameters<typeof fp.expectedFingerprintFor>[0];
    const expected = fp.expectedFingerprintFor(stored, SAVED).parts;
    const parts = affected ? { ...expected, language_pack_versions: { ...expected.language_pack_versions, en: 9999 } } : expected;
    await harness.db.query(
      `UPDATE documents SET ingest_fingerprint = $2, metadata = jsonb_set(metadata, '{ingest_fingerprint_parts}', $3::jsonb) WHERE id = $1`,
      [documentId, fp.buildIngestFingerprint(parts), JSON.stringify(parts)],
    );
  };

  test('three current documents, two of them on previous settings', async () => {
    const enqueue = await import('@/lib/rag/ingest/enqueue');
    for (const [index, colour] of ['blue', 'green', 'red'].entries()) {
      const sourceKey = `root/rebuild-${index}.md`;
      const queued = await enqueue.enqueueIngest({
        scope: harness.scopeA,
        source: 'config_upload',
        sourceKey,
        text: text(`zqxqrb${index}`, colour),
        filename: `rebuild-${index}.md`,
        mimeType: 'text/markdown',
        docType: 'general',
        uploaderId: QUEUED_IDS.userA,
        signal: new AbortController().signal,
      });
      assert.equal(queued.status, 'queued', JSON.stringify(queued));
      assert.equal((await runJob(String(queued.jobId))).status, 'ready');
      docs.push({ documentId: String(queued.documentId), sourceKey });
    }
    await stamp(docs[0]!.documentId, true);
    await stamp(docs[1]!.documentId, true);
    await stamp(docs[2]!.documentId, false);
  });

  test('a dry run reports the two affected documents and writes nothing', async () => {
    const dry = await rebuild.startRebuild({ mechanism: 'reparse', dryRun: true, startedBy: 'test' }, deps());
    assert.equal(dry.status, 'dry_run');
    assert.equal(dry.plan.kind, 'held_batch');
    assert.equal(dry.affected, 2);
    assert.equal((await harness.rows('SELECT count(*)::int AS n FROM rag_rebuild_runs'))[0]?.n, 0);
  });

  test('the rebuild creates one held batch and re-ingests only the affected documents as new, unpublished versions', async () => {
    const started = await rebuild.startRebuild({ mechanism: 'reparse', startedBy: 'test' }, deps());
    assert.equal(started.status, 'started', JSON.stringify(started));
    assert.ok(started.run);
    runId = started.run.id;
    assert.equal(started.run.total, 2);
    assert.equal(started.run.activation, 'rebuild_batch');

    const again = await rebuild.startRebuild({ mechanism: 'reparse', startedBy: 'test' }, deps());
    assert.equal(again.run?.id, runId, 'a second start returns the same run');

    const batches = await harness.rows('SELECT id, hold_publish, tenant_key FROM ingestion_batches');
    assert.equal(batches.length, 1);
    assert.equal(batches[0]?.hold_publish, true);
    const jobs = await harness.rows('SELECT id FROM ingestion_jobs WHERE batch_id = $1 ORDER BY id', [batches[0]?.id]);
    assert.equal(jobs.length, 2);
    for (const job of jobs) assert.equal((await runJob(String(job.id))).status, 'ready');

    const status = await rebuild.getRebuildRun(runId);
    assert.deepEqual([status?.state, status?.done, status?.gaps], ['complete', 2, 0]);

    for (const { sourceKey, documentId } of docs.slice(0, 2)) {
      const versions = await versionsOf(sourceKey);
      assert.equal(versions.length, 2, sourceKey);
      const [previous, next] = versions as [Row, Row];
      assert.equal(previous.id, documentId);
      assert.equal(previous.is_current, true, 'the previous version keeps answering');
      assert.equal(next.is_current, false);
      assert.deepEqual((next.metadata as Row).publish_hold, { batch_id: batches[0]?.id });
      const current = await harness.rows('SELECT DISTINCT document_id FROM document_chunks WHERE is_current AND document_id IN ($1, $2)', [previous.id, next.id]);
      assert.deepEqual(current.map((row) => row.document_id), [previous.id], 'retrieval sees only the previous chunks');
    }
    assert.equal((await versionsOf(docs[2]!.sourceKey)).length, 1, 'the unaffected document is not rebuilt');
  });

  test('activation is refused without evidence and with failing evidence', async () => {
    await assert.rejects(rebuild.activateRebuild(runId, 'admin'), (error: unknown) => {
      assert.ok(error instanceof rebuild.RebuildRefused);
      assert.deepEqual([error.code, error.reason], ['activation_refused', 'eval_missing']);
      return true;
    });
    await rebuild.recordRebuildEvidence(runId, FAILING_GATE);
    await assert.rejects(rebuild.activateRebuild(runId, 'admin'), (error: unknown) => {
      assert.ok(error instanceof rebuild.RebuildRefused);
      assert.equal(error.reason, 'eval_failed');
      return true;
    });
    await assert.rejects(rebuild.recordRebuildEvidence(runId, { passed: 'yes' }), rebuild.RebuildInputError);
  });

  test('activation with passing evidence publishes both new versions and calls the post-publish hooks', async () => {
    const before = new Map<string, number>();
    for (const { documentId } of docs.slice(0, 2)) before.set(documentId, await vectorCount(documentId));
    await rebuild.recordRebuildEvidence(runId, PASSING_GATE);
    const activated = await rebuild.activateRebuild(runId, 'admin');
    assert.equal(activated.published.length, 2);
    assert.deepEqual([...published].sort(), [...activated.published].sort());
    for (const { sourceKey, documentId } of docs.slice(0, 2)) {
      const [previous, next] = (await versionsOf(sourceKey)) as [Row, Row];
      assert.deepEqual([previous.is_current, next.is_current], [false, true]);
      assert.equal('publish_hold' in (next.metadata as Row), false);
      assert.ok((before.get(documentId) ?? 0) > 0);
    }
    assert.equal((await rebuild.getRebuildRun(runId))?.state, 'activated');
    await assert.rejects(rebuild.activateRebuild(runId, 'admin'), (error: unknown) => {
      assert.ok(error instanceof rebuild.RebuildRefused);
      assert.deepEqual([error.code, error.reason], ['activation_refused', 'already_activated']);
      return true;
    });

    published.length = 0;
    const rolled = await rebuild.rollbackRebuild(runId, 'admin');
    assert.equal(rolled.restored.length, 2);
    for (const { sourceKey, documentId } of docs.slice(0, 2)) {
      const [previous, next] = (await versionsOf(sourceKey)) as [Row, Row];
      assert.deepEqual([previous.is_current, next.is_current], [true, false]);
      assert.equal(await vectorCount(documentId), before.get(documentId), 'the previous version has its vectors back');
      const current = await harness.rows('SELECT DISTINCT document_id FROM document_chunks WHERE is_current AND document_id IN ($1, $2)', [previous.id, next.id]);
      assert.deepEqual(current.map((row) => row.document_id), [previous.id]);
    }
    assert.deepEqual([...published].sort(), docs.slice(0, 2).map((d) => d.documentId).sort());
    assert.equal((await rebuild.getRebuildRun(runId))?.state, 'rolled_back');
    await assert.rejects(rebuild.rollbackRebuild(runId, 'admin'), (error: unknown) => {
      assert.ok(error instanceof rebuild.RebuildRefused);
      assert.deepEqual([error.code, error.reason], ['rollback_refused', 'already_rolled_back']);
      return true;
    });
    await assert.rejects(rebuild.activateRebuild(runId, 'admin'), (error: unknown) => error instanceof rebuild.RebuildRefused && error.code === 'activation_refused');
  });

  test('an unknown run is not found', async () => {
    await assert.rejects(rebuild.activateRebuild('00000000-0000-4000-8000-00000000dead', 'admin'), rebuild.RebuildNotFound);
    assert.equal(await rebuild.getRebuildRun('00000000-0000-4000-8000-00000000dead'), null);
  });
});
