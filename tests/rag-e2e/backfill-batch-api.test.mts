/**
 * Batch API embeddings for backfill (D-35, D-36, SC5): with RAG_EMBED_BATCH_MODE=batch_api the worker writes chunks without vectors and
 * parks each job at embed_deferred; the rag:backfill process submits the chunks to a recorded OpenAI Batch API fake in batches of at
 * most 50,000 inputs, writes the vectors by custom_id, publishes every job whose vectors are complete and resumes open batches.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import OpenAI from 'openai';
import { SIDECAR_SECRET, startQueuedHarness, type QueuedHarness } from '../../eval/harness/queued-ingest.mts';
import { spawnSidecarModule } from '../../eval/harness/sidecar-worker.mts';
import { fakeVector, startFakeOpenAiBatch, type FakeOpenAiBatch } from '../helpers/fake-openai-batch.ts';

type Row = Record<string, unknown>;
type Orchestrate = typeof import('@/lib/rag/ingest/backfill/orchestrate');

const LEGACY = 'openai-3-small-1536';
const SMALL = 'openai-3-small-512';
const MAX_INPUTS = 8;

let harness: QueuedHarness;
let fake: FakeOpenAiBatch;
let client: OpenAI;
let orchestrate: Orchestrate;
let rpc: import('@/lib/rag/backend/supabase-rpc').RpcClient;
let tenant: string;
let serviceKey: string;
let onEvent: ((event: string) => void) | null = null;
const folders: string[] = [];
let fileSeq = 0;

before(async () => {
  harness = await startQueuedHarness();
  // The fixed chain sends text files to LlamaParse first: every upload gets its own text, so no two versions are content duplicates.
  harness.llama.enqueue(
    ...Array.from({ length: 400 }, (_, index) => ({
      pages: [{ page_number: 1, success: true, markdown: `Batch page ${index}\n\nUnique deferred text number ${index} about cabinet ${index}.` }],
    })),
  );
  const objectStore = await import('@/lib/rag/ingest/object-store');
  objectStore.resetObjectStoreForTests();
  const { scopeKey } = await import('@/lib/rag/tenant/scope');
  tenant = scopeKey(harness.scopeA).toLowerCase();
  const { fixtureProcessEnv } = await import('../../eval/harness/fake-edge.mts');
  serviceKey = String(fixtureProcessEnv(harness.edge.url).SUPABASE_SERVICE_ROLE_KEY);
  const deps = await import('@/lib/rag/ingest/deps');
  const admin = deps.getIngestDeps().db();
  assert.ok(admin, 'admin client');
  rpc = admin;
  orchestrate = await import('@/lib/rag/ingest/backfill/orchestrate');
  fake = await startFakeOpenAiBatch({ onEvent: (event) => onEvent?.(event) });
  client = new OpenAI({ apiKey: 'sk-fake-batch-placeholder', baseURL: fake.baseUrl, maxRetries: 0 });
});

after(async () => {
  await fake?.stop();
  await harness?.close();
  for (const folder of folders) await rm(folder, { recursive: true, force: true });
});

async function folderOf(count: number): Promise<string> {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'backfill-batch-api-'));
  folders.push(folder);
  for (let index = 0; index < count; index += 1) {
    fileSeq += 1;
    const label = `ledger-${fileSeq}`;
    await writeFile(path.join(folder, `${label}.txt`), `# ${label}\n\nThe ${label} note explains one archive step in plain words.\n`);
  }
  return folder;
}

/** A batch past its dry run (status running), so --resume goes straight to enqueue, the worker and the Batch API. */
async function runningBatch(folder: string): Promise<string> {
  const [row] = await harness.rows("SELECT id FROM rag_create_ingestion_batch($1, 'folder', $2, 100, 3, 'worker', 'test')", [tenant, path.resolve(folder)]);
  const batchId = String(row?.id);
  await harness.rows("SELECT id FROM rag_update_ingestion_batch($1, 'running')", [batchId]);
  return batchId;
}

function startWorker(): { kill(): void; done: Promise<unknown> } {
  return spawnSidecarModule(
    'uvicorn',
    ['rag_sidecar.main:app', '--host', '127.0.0.1', '--port', '0', '--log-level', 'warning'],
    {
      RAG_INGEST_WORKER: 'on',
      RAG_INGEST_WORKER_CONCURRENCY: '4',
      RAG_INGEST_MAINTENANCE: 'off',
      RAG_SIDECAR_SECRET: SIDECAR_SECRET,
      NEXT_PUBLIC_SUPABASE_URL: harness.edge.url,
      SUPABASE_SERVICE_ROLE_KEY: serviceKey,
      RAG_APP_INTERNAL_URL: harness.app.url,
      UV_OFFLINE: '1',
      UV_FROZEN: '1',
    },
    { timeoutMs: 600_000 },
  );
}

async function backfill(batchId: string, options: { signal?: AbortSignal; limits?: { maxInputs?: number } } = {}) {
  const { loadQueueConfig } = await import('@/lib/rag/ingest/queue-config');
  const lines: string[] = [];
  const outcome = await orchestrate.runBackfill(
    {
      scope: harness.scopeA,
      source: null,
      root: null,
      budgetUsd: null,
      concurrency: 3,
      dryRun: false,
      resumeBatchId: batchId,
      runner: 'worker',
    },
    {
      rpc,
      signal: options.signal ?? new AbortController().signal,
      io: { out: (line) => lines.push(line), err: (line) => lines.push(line) },
      snapshot: () => loadQueueConfig({ RAG_INGEST_PIPELINE: 'unified', RAG_INGEST_ASYNC: 'on', RAG_EMBED_BATCH_MODE: 'batch_api' }),
      startRunner: () => {
        const worker = startWorker();
        return { runner: 'worker', done: new Promise(() => undefined), stop: () => worker.kill() };
      },
      monitorIntervalMs: 250,
      monitorTimeoutMs: 300_000,
      embedBatch: { client, pollIntervalMs: 5, ...(options.limits ? { limits: options.limits } : {}) },
    },
  );
  return { outcome, lines };
}

async function ingestCounts(batchId: string): Promise<Record<string, number>> {
  const rows = await harness.rows(
    "SELECT CASE WHEN stage = 'embed_deferred' THEN 'embed_deferred' ELSE status END AS status, count(*)::int AS n FROM ingestion_jobs WHERE batch_id = $1 AND kind = 'ingest' GROUP BY 1",
    [batchId],
  );
  return Object.fromEntries(rows.map((row) => [String(row.status), Number(row.n)]));
}

async function batchChunks(batchId: string): Promise<Row[]> {
  return harness.rows(
    `SELECT c.id, c.document_id, c.embedding_text_version, c.embedding IS NOT NULL AS embedded, c.is_current, c.status
       FROM document_chunks c JOIN ingestion_jobs j ON j.document_id = c.document_id
      WHERE j.batch_id = $1 AND j.kind = 'ingest' ORDER BY c.id`,
    [batchId],
  );
}

function uploadedIds(from: number): string[][] {
  return fake.uploads.slice(from).map((upload) => upload.lines.map((line) => String((JSON.parse(line) as Row).custom_id)));
}

function activationCalls(): number {
  return harness.edge.calls.filter((call) => call.path.endsWith('/rag_activate_embedding_profile')).length;
}

describe('rag:backfill with RAG_EMBED_BATCH_MODE=batch_api (D-35, SC5)', () => {
  test('30 documents: deferred at write, submitted in batches of at most 50,000 inputs, vectors written by custom_id, every job published', async () => {
    const folder = await folderOf(30);
    const batchId = await runningBatch(folder);
    const uploadsBefore = fake.uploads.length;
    let atFirstUpload: Promise<{ counts: Record<string, number>; embedded: number; current: number }> | null = null;
    onEvent = (event) => {
      if (event === 'upload' && atFirstUpload === null) {
        atFirstUpload = (async () => {
          const chunks = await batchChunks(batchId);
          return {
            counts: await ingestCounts(batchId),
            embedded: chunks.filter((chunk) => chunk.embedded === true).length,
            current: chunks.filter((chunk) => chunk.is_current === true).length,
          };
        })();
      }
    };
    try {
      const { outcome, lines } = await backfill(batchId, { limits: { maxInputs: MAX_INPUTS } });
      assert.equal(outcome.exitCode, 0, lines.join('\n'));

      assert.ok(atFirstUpload, 'the Batch API was used');
      const before = await (atFirstUpload as unknown as Promise<{ counts: Record<string, number>; embedded: number; current: number }>);
      assert.deepEqual(before.counts, { embed_deferred: 30 }, 'every job was parked before the first submission');
      assert.equal(before.embedded, 0, 'advance wrote no vector');
      assert.equal(before.current, 0, 'nothing was published before its vectors');

      const chunks = await batchChunks(batchId);
      assert.ok(chunks.length >= 30, `chunks: ${chunks.length}`);
      const uploads = uploadedIds(uploadsBefore);
      assert.ok(uploads.length >= Math.ceil(chunks.length / MAX_INPUTS), `uploads: ${uploads.length}`);
      for (const ids of uploads) {
        assert.ok(ids.length <= MAX_INPUTS, `a batch carried ${ids.length} inputs`);
        assert.ok(ids.length <= 50_000);
      }
      const sent = uploads.flat();
      assert.equal(new Set(sent).size, sent.length, 'no input submitted twice');
      assert.deepEqual([...sent].sort(), chunks.map((chunk) => `${chunk.id}:${chunk.embedding_text_version}`).sort());

      assert.deepEqual(await ingestCounts(batchId), { ready: 30 });
      assert.ok(chunks.every((chunk) => chunk.embedded === true && chunk.is_current === true && chunk.status === 'ready'));
      // Results are mapped by custom_id: the fake answers in shuffled order with a vector derived from the custom_id.
      for (const chunk of chunks.slice(0, 3)) {
        const [stored] = await harness.rows('SELECT embedding::text AS v FROM document_chunks WHERE id = $1', [chunk.id]);
        const vector = JSON.parse(String(stored?.v)) as number[];
        const expected = fakeVector(`${chunk.id}:${chunk.embedding_text_version}`, 1536);
        assert.equal(vector.length, expected.length);
        assert.ok(vector.every((value, index) => Math.abs(value - (expected[index] as number)) < 1e-6), 'the vector of its own custom_id');
        // Retrieval: a vector search over the tenant's current chunks finds the chunk's own document first.
        const [hit] = await harness.rows(
          "SELECT document_id FROM document_chunks WHERE tenant_key = $1 AND is_current AND status = 'ready' AND embedding IS NOT NULL ORDER BY embedding <=> $2::vector LIMIT 1",
          [tenant, String(stored?.v)],
        );
        assert.equal(hit?.document_id, chunk.document_id);
      }

      const profiles = outcome.embeddings?.profiles ?? [];
      assert.deepEqual(
        profiles.map((entry) => [entry.profileId, entry.mode, entry.chunks]),
        [[LEGACY, 'batch_api', chunks.length]],
      );
      assert.ok((profiles[0]?.usd ?? 0) > 0);
      assert.ok(lines.some((line) => line.startsWith(`[Backfill] embeddings ${LEGACY} (active, Batch API)`)), lines.join('\n'));
      assert.equal(outcome.end?.ingest.byStatus.ready, 30);
      assert.equal(activationCalls(), 0, 'no profile activation');
      const [batch] = await harness.rows('SELECT status FROM ingestion_batches WHERE id = $1', [batchId]);
      assert.equal(batch?.status, 'completed');
    } finally {
      onEvent = null;
    }
  });

  test('an expired batch is resubmitted for its missing inputs only', async () => {
    const folder = await folderOf(5);
    const batchId = await runningBatch(folder);
    const uploadsBefore = fake.uploads.length;
    fake.script({ states: ['in_progress', 'expired'], completeOnly: 2 });
    const { outcome, lines } = await backfill(batchId);
    assert.equal(outcome.exitCode, 0, lines.join('\n'));
    const uploads = uploadedIds(uploadsBefore);
    assert.equal(uploads.length, 2, JSON.stringify(uploads));
    const [first, second] = uploads as [string[], string[]];
    assert.equal(first.length, 5);
    assert.deepEqual([...second].sort(), first.slice(2).sort(), 'only the inputs the expired batch did not deliver');
    assert.deepEqual(await ingestCounts(batchId), { ready: 5 });
    assert.ok((await batchChunks(batchId)).every((chunk) => chunk.embedded === true));
  });

  test('killed after submit, --resume polls the open batch instead of submitting it again', async () => {
    const folder = await folderOf(4);
    const batchId = await runningBatch(folder);
    const uploadsBefore = fake.uploads.length;
    fake.script({ states: ['validating', 'in_progress', 'in_progress', 'in_progress', 'finalizing', 'completed'] });
    const controller = new AbortController();
    onEvent = (event) => {
      if (event.startsWith('retrieve:')) controller.abort(new Error('killed'));
    };
    try {
      await assert.rejects(backfill(batchId, { signal: controller.signal }));
    } finally {
      onEvent = null;
    }
    const open = await harness.rows("SELECT provider_batch_id, status FROM rag_embed_batches WHERE batch_id = $1 AND status NOT IN ('completed', 'cancelled')", [
      batchId,
    ]);
    assert.equal(open.length, 1, 'the submitted batch was recorded before the kill');
    assert.deepEqual(await ingestCounts(batchId), { embed_deferred: 4 });
    const uploadsAfterKill = fake.uploads.length;
    assert.equal(uploadsAfterKill - uploadsBefore, 1);

    const eventsBefore = fake.events.length;
    const { outcome, lines } = await backfill(batchId);
    assert.equal(outcome.exitCode, 0, lines.join('\n'));
    assert.equal(fake.uploads.length, uploadsAfterKill, 'nothing was submitted again');
    assert.ok(fake.events.slice(eventsBefore).includes(`retrieve:${String(open[0]?.provider_batch_id)}`), 'the open batch was polled');
    assert.deepEqual(await ingestCounts(batchId), { ready: 4 });
    assert.ok((await batchChunks(batchId)).every((chunk) => chunk.embedded === true));
  });

  test('a backfilling profile gets its vectors too (dual-write), the report shows the cost per profile, and nothing is activated', async () => {
    const deps = await import('@/lib/rag/ingest/deps');
    const activeProfile = await import('@/lib/rag/embeddings/active-profile');
    const originalEnv = deps.getIngestDeps().ingestEnv;
    await harness.rows(
      "INSERT INTO embedding_profiles (id, provider, model, dims, storage, status, score_calibration) VALUES ($1, 'openai', 'text-embedding-3-small', 512, 'halfvec', 'backfilling', '{}'::jsonb) ON CONFLICT (id) DO UPDATE SET status = 'backfilling'",
      [SMALL],
    );
    deps.setIngestDepsForTests({ ingestEnv: () => ({ ...originalEnv(), RAG_EMBEDDING_PROFILES: 'on' }) });
    await activeProfile.refreshActiveProfile();
    try {
      const folder = await folderOf(3);
      const batchId = await runningBatch(folder);
      const uploadsBefore = fake.uploads.length;
      const { outcome, lines } = await backfill(batchId);
      assert.equal(outcome.exitCode, 0, lines.join('\n'));

      const chunks = await batchChunks(batchId);
      const smallRows = await harness.rows('SELECT chunk_id, dims, tenant_key FROM chunk_embeddings WHERE profile_id = $1 AND chunk_id = ANY($2)', [
        SMALL,
        chunks.map((chunk) => chunk.id),
      ]);
      assert.equal(smallRows.length, chunks.length, 'every chunk has its backfilling-profile vector');
      assert.ok(smallRows.every((row) => row.dims === 512 && row.tenant_key === tenant));
      assert.ok(chunks.every((chunk) => chunk.embedded === true));
      const bodies = fake.uploads.slice(uploadsBefore).map((upload) => (JSON.parse(upload.lines[0] as string) as { body: Row }).body);
      assert.ok(bodies.some((body) => body.dimensions === 512), 'the 512-dimension profile went through the Batch API');

      const profiles = outcome.embeddings?.profiles ?? [];
      assert.deepEqual(
        profiles.map((entry) => [entry.profileId, entry.role, entry.mode, entry.chunks]),
        [
          [LEGACY, 'active', 'batch_api', chunks.length],
          [SMALL, 'backfilling', 'batch_api', chunks.length],
        ],
      );
      assert.ok(profiles.every((entry) => entry.usd > 0));
      assert.ok(lines.some((line) => line.startsWith(`[Backfill] embeddings ${SMALL} (backfilling, Batch API)`)), lines.join('\n'));
      assert.equal(activationCalls(), 0, 'no profile activation');
      const [profile] = await harness.rows('SELECT status FROM embedding_profiles WHERE id = $1', [SMALL]);
      assert.equal(profile?.status, 'backfilling');
      assert.deepEqual(await ingestCounts(batchId), { ready: 3 });
    } finally {
      await harness.rows("UPDATE embedding_profiles SET status = 'available' WHERE id = $1", [SMALL]);
      deps.setIngestDepsForTests({ ingestEnv: originalEnv });
      await activeProfile.refreshActiveProfile();
    }
  });
});
