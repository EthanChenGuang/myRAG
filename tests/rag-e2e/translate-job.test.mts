import { after, afterEach, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { QUEUED_IDS, startQueuedHarness, type QueuedHarness } from '../../eval/harness/queued-ingest.mts';
import type { ChunkTranslationModel, ChunkTranslationRequest } from '@/lib/rag/ingest/translate/translator';
import type { TenantScope } from '@/lib/rag/tenant/scope';

// Plan 03.2-50 (XLG-04, D-29): with asynchronous ingestion, translation after publish is a ledger job of kind translate, claimed by the
// sidecar worker and executed by the app through the translate callback. Two tenants, the real one-shot worker, a fixture translator.
// Neutral synthetic sentences only.

type Row = Record<string, unknown>;

const TENANT_A = `u:${QUEUED_IDS.userA}`;
const TENANT_B = `o:${QUEUED_IDS.orgB}`;
const WORKER = 'translate-test-worker';
const OPTIONS_HASH = 'd'.repeat(64);

const ZH_ONE = [
  '本节说明系统的总体结构以及各个组成部分之间的关系。',
  '每个模块都有明确的职责，模块之间通过约定的接口交换数据。',
  '数据在进入系统之前会经过校验，校验失败的数据不会被保存。',
].join('');
const ZH_TWO = [
  '运行期间产生的记录按照时间顺序保存，便于之后查阅和比较。',
  '配置项集中保存在一个文件中，修改之后需要重新启动服务才能生效。',
  '当某个模块出现异常时，其余模块继续工作，异常信息会被单独记录。',
].join('');
const EN_ONE =
  'This section describes the general structure of the system and the relation between its parts. Each module has a clear task and the modules exchange data through agreed interfaces.';
const EN_TWO =
  'Records produced while the service runs are kept in time order, so that they can be read and compared later on. A module that stops does not stop the others.';

const markdown = (marker: string) =>
  ['# 总体结构', '', `${ZH_ONE}（编号 ${marker}）`, '', '# 运行记录', '', ZH_TWO, '', '# Overview', '', EN_ONE, '', '# Records', '', EN_TWO, ''].join('\n');

const sha256 = (text: string) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

interface Recorder extends ChunkTranslationModel {
  calls: ChunkTranslationRequest[];
  fail: boolean;
  delayMs: number;
}

function taggingModel(): Recorder {
  const model: Recorder = {
    model: 'fixture-translator',
    calls: [],
    fail: false,
    delayMs: 0,
    async translate(request) {
      model.calls.push(request);
      if (model.delayMs) await new Promise((resolve) => setTimeout(resolve, model.delayMs));
      if (model.fail) throw new Error('translator unreachable');
      return { content: `[${request.targetLanguage}] ${request.text}` };
    },
  };
  return model;
}

describe('queued chunk translation: a ledger job of kind translate (plan 03.2-50, D-29)', () => {
  let harness: QueuedHarness;
  let enqueueModule: typeof import('@/lib/rag/ingest/enqueue');
  let postPublish: typeof import('@/lib/rag/ingest/post-publish');
  let translator: typeof import('@/lib/rag/ingest/translate/translator');
  let translateEnqueue: typeof import('@/lib/rag/ingest/translate/enqueue');
  let model: Recorder;
  let counter = 0;

  before(async () => {
    harness = await startQueuedHarness({ env: { RAG_DOC_TRANSLATION: 'on', RAG_LANGUAGE_AWARE_INGEST: 'on' } });
    enqueueModule = await import('@/lib/rag/ingest/enqueue');
    postPublish = await import('@/lib/rag/ingest/post-publish');
    translator = await import('@/lib/rag/ingest/translate/translator');
    translateEnqueue = await import('@/lib/rag/ingest/translate/enqueue');
    const depsModule = await import('@/lib/rag/ingest/deps');
    const base = depsModule.getIngestDeps().ingestEnv;
    depsModule.setIngestDepsForTests({ ingestEnv: () => ({ ...base(), RAG_LANGUAGE_AWARE_INGEST: 'on', RAG_DOC_TRANSLATION: 'on' }) });
    (await import('@/lib/rag/ingest/config')).resetIngestConfigForTests();
    (await import('@/lib/rag/lang/settings')).resetLanguageSettingsForTests();
    // Fixture rows: the settings functions are exercised by tests/rag-db/chunk-translations.test.mts.
    await harness.db.query('INSERT INTO rag_translation_settings (tenant_key, target_languages, enabled) VALUES ($1, $2::text[], true), ($3, $4::text[], true)', [
      TENANT_A,
      ['en'],
      TENANT_B,
      ['zh'],
    ]);
  });

  after(async () => {
    translator?.resetChunkTranslationModelForTests();
    await harness?.close();
  });

  afterEach(async () => {
    await postPublish.postPublishSettledForTests();
    postPublish.setPostPublishQueueConfigForTests(null);
  });

  const freshModel = () => {
    model = taggingModel();
    translator.setChunkTranslationModelForTests(model);
    return model;
  };

  const advanceBody = (cacheId: string, cursor: string | null) => ({
    worker_id: WORKER,
    attempt_no: 1,
    phase: 'post_parse',
    parse_cache_id: cacheId,
    deadline_ms: 40_000,
    cursor,
  });

  /** Uploads through the queue and plays the worker for the ingest job, so the document is published by the app's own advance. */
  const publishQueued = async (scope: TenantScope, label: string): Promise<{ documentId: string; ingestJobId: string }> => {
    counter += 1;
    const queued = await enqueueModule.enqueueIngest({
      scope,
      source: 'config_upload',
      sourceKey: `root/${label}-${counter}.md`,
      text: markdown(`${label}-${counter}`),
      filename: `${label}-${counter}.md`,
      mimeType: 'text/markdown',
      docType: 'general',
      signal: new AbortController().signal,
    });
    assert.equal(queued.status, 'queued', JSON.stringify(queued));
    const jobId = String(queued.jobId);
    await harness.claim(jobId, WORKER);
    const parsed = await harness.callback(jobId, 'parse-external', { worker_id: WORKER, attempt_no: 1, mode: 'chain', options_hash: OPTIONS_HASH });
    assert.equal(parsed.status, 200, JSON.stringify(parsed.body));
    let cursor: string | null = null;
    for (let call = 0; call < 30; call += 1) {
      const reply = await harness.callback(jobId, 'advance', advanceBody(String(parsed.body.cache_id), cursor));
      assert.equal(reply.status, 200, JSON.stringify(reply.body));
      if (reply.body.done === true) {
        assert.equal(reply.body.status, 'ready');
        await postPublish.postPublishSettledForTests();
        return { documentId: String(queued.documentId), ingestJobId: jobId };
      }
      cursor = String(reply.body.stage);
    }
    throw new Error('the ingest job did not finish');
  };

  const translateJobs = async (documentId: string): Promise<Row[]> =>
    harness.rows(
      `SELECT id::text, tenant_key, status, stage, settings, attempts, retries, max_retries, dead_letter_at, error_class, document_id::text, timings, stage_state
         FROM ingestion_jobs WHERE kind = 'translate' AND document_id = $1 ORDER BY created_at`,
      [documentId],
    );

  const onlyJob = async (documentId: string): Promise<Row> => {
    const jobs = await translateJobs(documentId);
    assert.equal(jobs.length, 1, 'one translate job for the document and its target');
    return jobs[0]!;
  };

  const documentRow = async (documentId: string): Promise<Row> =>
    (await harness.rows('SELECT status, processing_status, is_current, needs_review FROM documents WHERE id = $1', [documentId]))[0] as Row;

  const jobStatus = async (jobId: string): Promise<Row> =>
    (await harness.rows('SELECT status, stage, error, error_class, dead_letter_at, retries FROM ingestion_jobs WHERE id = $1', [jobId]))[0] as Row;

  const translationsOf = async (documentId: string): Promise<Row[]> =>
    harness.rows(
      `SELECT t.chunk_id::text, t.tenant_key, t.language, t.content, t.source_content_hash, t.model, e.profile_id
         FROM chunk_translations t LEFT JOIN chunk_translation_embeddings e ON e.translation_id = t.id
        WHERE t.document_id = $1 ORDER BY t.chunk_id`,
      [documentId],
    );

  const chunksIn = async (documentId: string, language: string): Promise<Row[]> =>
    harness.rows("SELECT id::text, content FROM document_chunks WHERE document_id = $1 AND is_current AND language = $2 AND chunk_kind = 'text' ORDER BY chunk_index", [
      documentId,
      language,
    ]);

  const countParseRows = async (): Promise<number> => Number((await harness.rows('SELECT count(*)::int AS n FROM rag_parse_cache'))[0]?.n);

  const translateBody = (extra: Record<string, unknown> = {}) => ({ worker_id: WORKER, deadline_ms: 40_000, ...extra });

  /** Plays the worker for a claimed translate job: claim, callback until done or retry. */
  const playWorker = async (jobId: string, deadlineMs = 40_000): Promise<Record<string, unknown>[]> => {
    await harness.claim(jobId, WORKER);
    const replies: Record<string, unknown>[] = [];
    for (let call = 0; call < 20; call += 1) {
      const reply = await harness.callback(jobId, 'translate', translateBody({ deadline_ms: deadlineMs }));
      assert.equal(reply.status, 200, JSON.stringify(reply.body));
      replies.push(reply.body);
      if (reply.body.outcome !== 'continue') return replies;
    }
    throw new Error('the translate job did not finish');
  };

  describe('Task 1: enqueue after publish, the worker claims it, the callback completes it', () => {
    test('one translate job per target after publish; the real worker completes it without parsing; translations match the inline path', async () => {
      freshModel();
      const a = await publishQueued(harness.scopeA, 'tenant-a');
      const b = await publishQueued(harness.scopeB, 'tenant-b');

      const jobsA = await translateJobs(a.documentId);
      const jobsB = await translateJobs(b.documentId);
      assert.equal(jobsA.length, 1, JSON.stringify(jobsA));
      assert.equal(jobsB.length, 1, JSON.stringify(jobsB));
      assert.equal(jobsA[0]?.tenant_key, TENANT_A);
      assert.equal(jobsB[0]?.tenant_key, TENANT_B);
      assert.equal((jobsA[0]?.settings as Row).target_language, 'en');
      assert.equal((jobsB[0]?.settings as Row).target_language, 'zh');
      assert.equal(jobsA[0]?.status, 'queued');
      assert.equal(model.calls.length, 0, 'nothing is translated inside the publishing request');

      const docBefore = { a: await documentRow(a.documentId), b: await documentRow(b.documentId) };
      const parseRows = await countParseRows();
      for (const job of [jobsA[0]!, jobsB[0]!]) {
        const run = await harness.runWorker(String(job.id));
        assert.equal(run.exitCode, 0, `${run.stdout}\n${run.stderr}`);
        assert.match(run.stdout, /"status": "ready"/);
      }

      for (const [documentId, tenant, source, target] of [
        [a.documentId, TENANT_A, 'zh', 'en'],
        [b.documentId, TENANT_B, 'en', 'zh'],
      ] as const) {
        const [job] = await translateJobs(documentId);
        assert.equal(job?.status, 'ready');
        assert.deepEqual(job?.attempts, [], 'a translate job writes no parse attempt');
        const sources = await chunksIn(documentId, source);
        assert.ok(sources.length >= 2, JSON.stringify(sources));
        const rows = await translationsOf(documentId);
        assert.deepEqual(rows.map((row) => row.chunk_id).sort(), sources.map((chunk) => chunk.id).sort());
        for (const row of rows) {
          const chunk = sources.find((candidate) => candidate.id === row.chunk_id)!;
          assert.equal(row.tenant_key, tenant);
          assert.equal(row.language, target);
          assert.equal(row.content, `[${target}] ${chunk.content}`);
          assert.equal(row.source_content_hash, sha256(String(chunk.content)));
          assert.equal(row.model, 'fixture-translator');
          assert.ok(row.profile_id, 'a vector of the active profile');
        }
      }
      assert.equal(await countParseRows(), parseRows, 'no parse-cache row');
      assert.deepEqual(await documentRow(a.documentId), docBefore.a);
      assert.deepEqual(await documentRow(b.documentId), docBefore.b);
      assert.ok(model.calls.some((call) => call.targetLanguage === 'en') && model.calls.some((call) => call.targetLanguage === 'zh'));
    });

    test('the ledger moves queued, embedding, ready', async () => {
      freshModel();
      const a = await publishQueued(harness.scopeA, 'ledger');
      const job = await onlyJob(a.documentId);
      const jobId = String(job?.id);
      assert.equal((await jobStatus(jobId)).status, 'queued');
      await harness.claim(jobId, WORKER);
      assert.equal((await jobStatus(jobId)).status, 'embedding');
      const reply = await harness.callback(jobId, 'translate', translateBody());
      assert.equal(reply.status, 200, JSON.stringify(reply.body));
      assert.equal(reply.body.outcome, 'done');
      assert.equal(reply.body.status, 'ready');
      assert.equal(reply.body.remaining, 0);
      assert.equal((await jobStatus(jobId)).status, 'ready');
      const replay = await harness.callback(jobId, 'translate', translateBody());
      assert.equal(replay.status, 200);
      assert.equal(replay.body.outcome, 'done');
      assert.equal(replay.body.status, 'ready');
    });

    test('the callback refuses a missing or wrong secret and touches nothing', async () => {
      freshModel();
      const a = await publishQueued(harness.scopeA, 'secret');
      const job = await onlyJob(a.documentId);
      const jobId = String(job?.id);
      await harness.claim(jobId, WORKER);
      const before = await jobStatus(jobId);
      for (const headers of [{ 'x-sidecar-secret': null }, { 'x-sidecar-secret': '' }, { 'x-sidecar-secret': 'not-the-secret' }]) {
        const reply = await harness.callback(jobId, 'translate', translateBody(), headers);
        assert.equal(reply.status, 401, JSON.stringify(headers));
      }
      assert.deepEqual(await jobStatus(jobId), before);
      assert.equal((await translationsOf(a.documentId)).length, 0);
      assert.equal(model.calls.length, 0);
    });

    test('a body naming a tenant, a document or a language is refused, and the job row decides what is translated', async () => {
      freshModel();
      const a = await publishQueued(harness.scopeA, 'forged');
      const b = await publishQueued(harness.scopeB, 'forged');
      const jobA = await onlyJob(a.documentId);
      const jobId = String(jobA?.id);
      await harness.claim(jobId, WORKER);
      for (const extra of [{ tenant_key: TENANT_B }, { document_id: b.documentId }, { target_language: 'it' }, { tenant: TENANT_B }]) {
        const reply = await harness.callback(jobId, 'translate', translateBody(extra));
        assert.equal(reply.status, 400, JSON.stringify(extra));
      }
      assert.equal(model.calls.length, 0);
      const reply = await harness.callback(jobId, 'translate', translateBody());
      assert.equal(reply.body.status, 'ready', JSON.stringify(reply.body));
      assert.ok((await translationsOf(a.documentId)).every((row) => row.tenant_key === TENANT_A && row.language === 'en'));
      assert.equal((await translationsOf(b.documentId)).length, 0, 'the other tenant document is not touched');
      assert.ok(model.calls.every((call) => call.targetLanguage === 'en'));
    });

    test('a worker holding another lease, an unknown job and a job of another kind are refused', async () => {
      freshModel();
      const a = await publishQueued(harness.scopeA, 'lease');
      const job = await onlyJob(a.documentId);
      await harness.claim(String(job?.id), WORKER);
      assert.equal((await harness.callback(String(job?.id), 'translate', translateBody({ worker_id: 'other-worker' }))).status, 409);
      assert.equal((await harness.callback('99999999-9999-4999-8999-999999999999', 'translate', translateBody())).status, 404);
      assert.equal((await harness.callback('not-a-uuid', 'translate', translateBody())).status, 400);

      const ingest = await enqueueModule.enqueueIngest({
        scope: harness.scopeA,
        source: 'config_upload',
        sourceKey: 'root/kind.md',
        text: markdown('kind'),
        filename: 'kind.md',
        mimeType: 'text/markdown',
        docType: 'general',
        signal: new AbortController().signal,
      });
      await harness.claim(String(ingest.jobId), WORKER);
      assert.equal((await harness.callback(String(ingest.jobId), 'translate', translateBody())).status, 409);
      assert.equal(model.calls.length, 0);
    });
  });

  describe('Task 2: failure isolation, continuation, idempotent enqueue and the inline fallback', () => {
    test('a failing translation is retried under the ledger rules and dead-lettered at the limit; the document and its ingest job stay ready', async () => {
      const failing = freshModel();
      failing.fail = true;
      const a = await publishQueued(harness.scopeA, 'dead-letter');
      const job = await onlyJob(a.documentId);
      const jobId = String(job?.id);
      const docBefore = await documentRow(a.documentId);
      const maxRetries = Number(job?.max_retries);
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        await harness.db.query('UPDATE ingestion_jobs SET run_after = NULL WHERE id = $1', [jobId]);
        const replies = await playWorker(jobId);
        const last = replies.at(-1)!;
        assert.equal(last.outcome, 'retry', JSON.stringify(last));
        assert.equal(last.reason, 'model_unavailable');
        await harness.db.query('SELECT rag_fail_ingestion_job($1, $2, $3, true)', [jobId, WORKER, 'translate_model_unavailable']);
        const row = await jobStatus(jobId);
        assert.equal(row.status, attempt < maxRetries ? 'queued' : 'failed', `attempt ${attempt}`);
      }
      const dead = await jobStatus(jobId);
      assert.ok(dead.dead_letter_at, 'dead-lettered after the retry limit');
      assert.equal(dead.error_class, 'translate_model_unavailable');
      assert.deepEqual(await documentRow(a.documentId), docBefore);
      assert.equal((await documentRow(a.documentId)).status, 'ready');
      assert.equal((await documentRow(a.documentId)).is_current, true);
      assert.equal((await jobStatus(a.ingestJobId)).status, 'ready');
    });

    test('a callback out of its time budget answers with the remaining count, the job stays open, and the next call finishes it', async () => {
      const slow = freshModel();
      slow.delayMs = 300;
      const a = await publishQueued(harness.scopeA, 'budget');
      const job = await onlyJob(a.documentId);
      const jobId = String(job?.id);
      await harness.claim(jobId, WORKER);
      const started = Date.now();
      const first = await harness.callback(jobId, 'translate', translateBody({ deadline_ms: 200 }));
      assert.equal(first.status, 200, JSON.stringify(first.body));
      assert.ok(Date.now() - started < 5_000, 'the callback stops within its budget');
      assert.equal(first.body.outcome, 'continue', JSON.stringify(first.body));
      assert.ok(Number(first.body.remaining) >= 1);
      assert.equal(first.body.reason, 'time_budget');
      const open = await jobStatus(jobId);
      assert.equal(open.status, 'embedding');
      assert.ok((await translationsOf(a.documentId)).length >= 1, 'the first slice kept its translations');
      slow.delayMs = 0;
      const second = await harness.callback(jobId, 'translate', translateBody());
      assert.equal(second.body.outcome, 'done', JSON.stringify(second.body));
      assert.equal(second.body.remaining, 0);
      assert.equal((await jobStatus(jobId)).status, 'ready');
      assert.equal((await translationsOf(a.documentId)).length, (await chunksIn(a.documentId, 'zh')).length);
    });

    test('enqueuing twice for the same document and language returns the same job', async () => {
      freshModel();
      const a = await publishQueued(harness.scopeA, 'twice');
      const job = await onlyJob(a.documentId);
      const signal = new AbortController().signal;
      const again = await translateEnqueue.enqueueTranslateJob(TENANT_A, a.documentId, 'en', { signal });
      const third = await translateEnqueue.enqueueTranslateJob(TENANT_A, a.documentId, 'en', { signal });
      assert.equal(again?.id, job?.id);
      assert.equal(third?.id, job?.id);
      assert.equal((await translateJobs(a.documentId)).length, 1);
      await postPublish.afterPublish({ documentId: a.documentId, tenantKey: TENANT_A });
      assert.equal((await translateJobs(a.documentId)).length, 1, 'a second publish event enqueues no second job');
    });

    test('enqueueing refuses a document of another tenant', async () => {
      const b = await publishQueued(harness.scopeB, 'cross');
      await assert.rejects(translateEnqueue.enqueueTranslateJob(TENANT_A, b.documentId, 'en', { signal: new AbortController().signal }));
      assert.equal((await harness.rows("SELECT count(*)::int AS n FROM ingestion_jobs WHERE kind = 'translate' AND document_id = $1 AND tenant_key = $2", [b.documentId, TENANT_A]))[0]?.n, 0);
    });

    test('with asynchronous ingestion off no translate job is written and the inline producer runs', async () => {
      freshModel();
      const queueConfig = await import('@/lib/rag/ingest/queue-config');
      postPublish.setPostPublishQueueConfigForTests(() => ({ ...queueConfig.queueConfigFromProcessEnv(), ingestAsync: false }));
      const ingestModule = await import('@/lib/rag/ingest');
      const result = await ingestModule.ingest({
        scope: harness.scopeA,
        source: 'config_upload',
        sourceKey: 'root/inline.md',
        text: markdown('inline'),
        filename: 'inline.md',
        mimeType: 'text/markdown',
        docType: 'general',
        signal: new AbortController().signal,
      });
      assert.equal(result.status, 'ready', JSON.stringify(result));
      await postPublish.postPublishSettledForTests();
      const documentId = String(result.documentId);
      assert.equal((await translateJobs(documentId)).length, 0);
      assert.equal((await translationsOf(documentId)).length, (await chunksIn(documentId, 'zh')).length);
      assert.ok(model.calls.length >= 1);
    });

    test('a worker that does not know the kind is refused by the parse and advance callbacks and fails the job retryably; no document changes', async () => {
      freshModel();
      const a = await publishQueued(harness.scopeA, 'old-worker');
      const job = await onlyJob(a.documentId);
      const jobId = String(job?.id);
      const docBefore = await documentRow(a.documentId);
      const chunksBefore = await harness.rows('SELECT id::text, is_current, status FROM document_chunks WHERE document_id = $1 ORDER BY id', [a.documentId]);
      const parseRows = await countParseRows();
      await harness.claim(jobId, WORKER);
      const parse = await harness.callback(jobId, 'parse-external', { worker_id: WORKER, attempt_no: 1, mode: 'chain', options_hash: OPTIONS_HASH });
      assert.equal(parse.status, 409, JSON.stringify(parse.body));
      assert.equal(parse.body.error, 'kind_mismatch', 'refused for its kind, before any parse work');
      const advance = await harness.callback(jobId, 'advance', advanceBody('c'.repeat(8), null));
      assert.equal(advance.status, 409, JSON.stringify(advance.body));
      assert.equal(advance.body.error, 'kind_mismatch');
      await harness.db.query('SELECT rag_fail_ingestion_job($1, $2, $3, true)', [jobId, WORKER, 'callback_transient']);
      assert.equal((await jobStatus(jobId)).status, 'queued');
      assert.deepEqual(await documentRow(a.documentId), docBefore);
      assert.deepEqual(await harness.rows('SELECT id::text, is_current, status FROM document_chunks WHERE document_id = $1 ORDER BY id', [a.documentId]), chunksBefore);
      assert.equal(await countParseRows(), parseRows);
      assert.equal(model.calls.length, 0);
    });
  });
});
