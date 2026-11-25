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
    published.length = 0;
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

  test('a document that cannot be rebuilt leaves the run incomplete, and a restart processes only that document', async () => {
    const [first, second] = docs as [{ documentId: string; sourceKey: string }, { documentId: string; sourceKey: string }];
    const original = (await harness.rows('SELECT original_path FROM documents WHERE id = $1', [second.documentId]))[0]?.original_path;
    await harness.db.query('UPDATE documents SET original_path = NULL WHERE id = $1', [second.documentId]);
    const started = await rebuild.startRebuild({ mechanism: 'reparse', startedBy: 'test' }, deps());
    assert.equal(started.status, 'started');
    const gapRun = String(started.run?.id);
    assert.notEqual(gapRun, runId, 'a rolled-back run is not reopened');
    const [batch] = await harness.rows("SELECT id FROM ingestion_batches WHERE source_ref = 'rebuild:' || $1", [gapRun]);
    const jobs = await harness.rows('SELECT id FROM ingestion_jobs WHERE batch_id = $1', [batch?.id]);
    assert.equal(jobs.length, 1, 'only the document with an original is submitted');
    await runJob(String(jobs[0]?.id));
    const incomplete = await rebuild.getRebuildRun(gapRun);
    assert.deepEqual([incomplete?.state, incomplete?.done, incomplete?.gaps], ['incomplete', 1, 1]);
    await assert.rejects(rebuild.activateRebuild(gapRun, 'admin'), (error: unknown) => {
      assert.ok(error instanceof rebuild.RebuildRefused);
      return error.reason === 'eval_missing';
    });
    await rebuild.recordRebuildEvidence(gapRun, PASSING_GATE);
    await assert.rejects(rebuild.activateRebuild(gapRun, 'admin'), (error: unknown) => error instanceof rebuild.RebuildRefused && error.reason === 'incomplete');

    await harness.db.query('UPDATE documents SET original_path = $2 WHERE id = $1', [second.documentId, original]);
    const resumed = await rebuild.startRebuild({ mechanism: 'reparse', startedBy: 'test' }, deps());
    assert.equal(resumed.run?.id, gapRun);
    assert.equal(resumed.resumed, true);
    const after = await harness.rows('SELECT id FROM ingestion_jobs WHERE batch_id = $1 AND id <> $2', [batch?.id, jobs[0]?.id]);
    assert.equal(after.length, 1, 'the restart submits only the document that was a gap');
    await runJob(String(after[0]?.id));
    const complete = await rebuild.getRebuildRun(gapRun);
    assert.deepEqual([complete?.state, complete?.done, complete?.gaps], ['complete', 2, 0]);
    const activated = await rebuild.activateRebuild(gapRun, 'admin');
    assert.equal(activated.published.length, 2);
    void first;
  });

  test('a rechunk rebuild builds a legacy-sized chunking profile from stored parse output with zero parser calls', async () => {
    const parserCalls = harness.llama.calls.length;
    const saved = { ...SAVED, RAG_TABLE_ROW_SERIALIZATION: 'true' };
    const dry = await rebuild.startRebuild({ mechanism: 'rechunk', dryRun: true, startedBy: 'test' }, { ...deps(), saved });
    assert.equal(dry.plan.kind, 'chunking_profile');
    const started = await rebuild.startRebuild({ mechanism: 'rechunk', startedBy: 'test' }, { ...deps(), saved });
    assert.equal(started.status, 'started', JSON.stringify(started));
    assert.equal(started.run?.activation, 'chunking_profiles');
    assert.equal(started.run?.state, 'complete', JSON.stringify(started.run));
    assert.ok(started.plan.kind === 'chunking_profile');
    const [profile] = started.plan.profiles;
    const rows = await harness.rows('SELECT child_tokens, parent_mode, parent_tokens, status FROM chunking_profiles WHERE id = $1 AND doc_type = $2', [profile?.profileId, 'general']);
    assert.deepEqual(rows[0], { child_tokens: 512, parent_mode: 'none', parent_tokens: null, status: rows[0]?.status });
    assert.notEqual(rows[0]?.status, 'active', 'the pointer flip stays with rag:chunking activate');
    const children = await harness.rows('SELECT count(*)::int AS n FROM document_chunks WHERE chunking_profile_id = $1', [profile?.profileId]);
    assert.ok(Number(children[0]?.n) > 0);
    assert.equal(harness.llama.calls.length, parserCalls, 'no parser call');
    const again = await rebuild.startRebuild({ mechanism: 'rechunk', startedBy: 'test' }, { ...deps(), saved });
    assert.equal(again.run?.id, started.run?.id);
  });

  test('an unknown run is not found', async () => {
    await assert.rejects(rebuild.activateRebuild('00000000-0000-4000-8000-00000000dead', 'admin'), rebuild.RebuildNotFound);
    assert.equal(await rebuild.getRebuildRun('00000000-0000-4000-8000-00000000dead'), null);
  });
});

describe('planRebuild', () => {
  let plan: typeof import('@/lib/rag/ingest/rebuild/plan');
  const hash = 'a'.repeat(64);
  const A = 'u:00000000-0000-4000-8000-0000000000a1';
  const B = 'o:00000000-0000-4000-8000-0000000000c2';
  const documents = [
    { documentId: '00000000-0000-4000-8000-000000000001', tenantKey: B, docType: 'general' },
    { documentId: '00000000-0000-4000-8000-000000000002', tenantKey: A, docType: 'contract_legal' },
    { documentId: '00000000-0000-4000-8000-000000000003', tenantKey: A, docType: 'general' },
  ];
  const options = { ingestAsync: true, settingsHash: hash, legacyChildTokens: { general: 512, contract_legal: 768 } };

  before(async () => {
    plan = await import('@/lib/rag/ingest/rebuild/plan');
  });

  test('rechunk: one legacy-sized profile without parents per affected doc type, limited to the affected documents', () => {
    const built = plan.planRebuild('rechunk', { documents, withoutFingerprint: 0 }, options);
    assert.equal(built.kind, 'chunking_profile');
    assert.ok(built.kind === 'chunking_profile');
    assert.deepEqual(built.profiles, [
      { profileId: 'rb-aaaaaaaaaaaa', docType: 'contract_legal', childTokens: 768, parentMode: 'none', parentTokens: null, preset: 'custom' },
      { profileId: 'rb-aaaaaaaaaaaa', docType: 'general', childTokens: 512, parentMode: 'none', parentTokens: null, preset: 'custom' },
    ]);
    assert.deepEqual(built.documents.map((d) => d.documentId), documents.map((d) => d.documentId));
    assert.equal(built.activation, 'chunking_profiles');
  });

  test('relex, reembed, recaption and retranslate: the exact commands per tenant', () => {
    const commands = (mechanism: 'relex' | 'reembed' | 'recaption' | 'retranslate') => {
      const built = plan.planRebuild(mechanism, { documents, withoutFingerprint: 0 }, options);
      assert.equal(built.kind, 'command');
      return built.kind === 'command' ? built.commands : [];
    };
    assert.deepEqual(commands('relex'), [`npm run rag:relex -- --tenant ${B}`, `npm run rag:relex -- --tenant ${A}`]);
    assert.deepEqual(commands('reembed'), [`npm run rag:reembed -- --tenant ${B}`, `npm run rag:reembed -- --tenant ${A}`]);
    assert.deepEqual(commands('recaption'), [`npm run rag:reembed -- --recaption --tenant ${B}`, `npm run rag:reembed -- --recaption --tenant ${A}`]);
    assert.deepEqual(commands('retranslate'), [`npm run rag:translate -- --tenant ${B}`, `npm run rag:translate -- --tenant ${A}`]);
    const reembed = plan.planRebuild('reembed', { documents, withoutFingerprint: 0 }, options);
    assert.equal(reembed.kind === 'command' ? reembed.activation : null, 'embedding_profiles');
  });

  test('reparse: a held batch with the queue on, needs_async with the count and command with it off', () => {
    const held = plan.planRebuild('reparse', { documents, withoutFingerprint: 0 }, options);
    assert.equal(held.kind, 'held_batch');
    const off = plan.planRebuild('reparse', { documents, withoutFingerprint: 0 }, { ...options, ingestAsync: false });
    assert.deepEqual(off, { kind: 'needs_async', mechanism: 'reparse', affected: 3, command: 'npm run rag:rebuild -- start --mechanism reparse' });
    assert.deepEqual(plan.planRebuild('rechunk', { documents: [], withoutFingerprint: 2 }, options), { kind: 'nothing', mechanism: 'rechunk', affected: 0 });
  });
});
