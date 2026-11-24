import OpenAI from 'openai';
import { afterEach, describe, expect, test } from 'vitest';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import {
  MAX_BATCH_BYTES,
  MAX_BATCH_INPUTS,
  buildBatchLines,
  embedViaBatchApi,
  pollAndCollect,
  resubmitMissing,
  submitBatch,
  type BatchApiClient,
  type BatchApiDeps,
  type BatchChunk,
  type BatchProfile,
} from '@/lib/rag/ingest/backfill/batch-api';
import { fakeVector, startFakeOpenAiBatch, type FakeOpenAiBatch } from '../../helpers/fake-openai-batch';

const PROFILE: BatchProfile = { id: 'openai-3-small-1536', provider: 'openai', model: 'text-embedding-3-small', dims: 1536 };
const MRL_PROFILE: BatchProfile = { id: 'openai-3-small-512', provider: 'openai', model: 'text-embedding-3-small', dims: 512 };

function chunks(count: number, text = 'chunk text', version = 2): BatchChunk[] {
  return Array.from({ length: count }, (_, i) => ({
    chunkId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    embeddingTextVersion: version,
    text: `${text} ${i}`,
  }));
}

describe('buildBatchLines', () => {
  test('splits 120,001 chunks into files of 50,000, 50,000 and 20,001 lines', () => {
    const files = buildBatchLines(chunks(120_001), PROFILE);
    expect(MAX_BATCH_INPUTS).toBe(50_000);
    expect(files.map((f) => f.lines.length)).toEqual([50_000, 50_000, 20_001]);
    expect(files.map((f) => f.customIds.length)).toEqual([50_000, 50_000, 20_001]);
  });

  test('splits large inputs before the 190 MB file limit', () => {
    const big = 'x'.repeat(5 * 1024 * 1024);
    const files = buildBatchLines(chunks(40, big), PROFILE);
    expect(files.length).toBeGreaterThanOrEqual(2);
    for (const file of files) {
      expect(file.bytes).toBeLessThanOrEqual(MAX_BATCH_BYTES);
      expect(file.bytes).toBe(file.lines.reduce((sum, l) => sum + Buffer.byteLength(l, 'utf8') + 1, 0));
    }
    expect(files.reduce((sum, f) => sum + f.lines.length, 0)).toBe(40);
  });

  test('honours smaller limits passed in', () => {
    const files = buildBatchLines(chunks(25), PROFILE, { maxInputs: 10 });
    expect(files.map((f) => f.lines.length)).toEqual([10, 10, 5]);
    const byBytes = buildBatchLines(chunks(10), PROFILE, { maxBytes: 300 });
    expect(byBytes.length).toBeGreaterThan(1);
    for (const file of byBytes) expect(file.bytes).toBeLessThanOrEqual(300);
  });

  test('rejects a single input that cannot fit in any file', () => {
    expect(() => buildBatchLines(chunks(1, 'y'.repeat(500)), PROFILE, { maxBytes: 200 })).toThrow(/too_large/);
  });

  test('writes one embeddings request per chunk with custom_id chunk id plus text version', () => {
    const input = chunks(3, 'alpha', 7);
    const [file] = buildBatchLines(input, PROFILE);
    expect(file?.lines).toHaveLength(3);
    const parsed = (file?.lines ?? []).map((l) => JSON.parse(l));
    expect(parsed.map((p) => p.custom_id)).toEqual(input.map((c) => `${c.chunkId}:7`));
    expect(file?.customIds).toEqual(input.map((c) => `${c.chunkId}:7`));
    for (const [i, line] of parsed.entries()) {
      expect(line.method).toBe('POST');
      expect(line.url).toBe('/v1/embeddings');
      expect(line.body.model).toBe('text-embedding-3-small');
      expect(line.body.input).toBe(`alpha ${i}`);
      expect(line.body).not.toHaveProperty('dimensions');
    }
  });

  test('adds dimensions only when the profile is truncated below the native size', () => {
    const [file] = buildBatchLines(chunks(1), MRL_PROFILE);
    const body = JSON.parse(file?.lines[0] ?? '{}').body;
    expect(body.dimensions).toBe(512);
    expect(body.model).toBe('text-embedding-3-small');
  });

  test('keeps JSONL valid when text carries newlines and unicode separators', () => {
    const [file] = buildBatchLines(chunks(1, 'a\nb c'), PROFILE);
    expect(file?.lines).toHaveLength(1);
    expect(file?.lines[0]).not.toContain('\n');
    expect(JSON.parse(file?.lines[0] ?? '{}').body.input).toBe('a\nb c 0');
  });
});

describe('fake OpenAI Files and Batches API', () => {
  let fake: FakeOpenAiBatch | null = null;
  afterEach(async () => {
    await fake?.stop();
    fake = null;
  });

  async function upload(api: FakeOpenAiBatch, lines: string[]): Promise<{ id: string; purpose: string }> {
    const form = new FormData();
    form.append('purpose', 'batch');
    form.append('file', new Blob([lines.join('\n') + '\n']), 'batch.jsonl');
    const res = await fetch(`${api.baseUrl}/files`, { method: 'POST', body: form });
    return (await res.json()) as { id: string; purpose: string };
  }

  async function create(api: FakeOpenAiBatch, inputFileId: string): Promise<{ id: string; status: string }> {
    const res = await fetch(`${api.baseUrl}/batches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input_file_id: inputFileId, endpoint: '/v1/embeddings', completion_window: '24h' }),
    });
    return (await res.json()) as { id: string; status: string };
  }

  async function retrieve(api: FakeOpenAiBatch, id: string): Promise<Record<string, unknown>> {
    const res = await fetch(`${api.baseUrl}/batches/${id}`);
    return (await res.json()) as Record<string, unknown>;
  }

  test('accepts an upload and a create, then walks validating, in_progress, completed', async () => {
    fake = await startFakeOpenAiBatch();
    const [file] = buildBatchLines(chunks(6), PROFILE);
    expect(file).toBeDefined();
    const uploaded = await upload(fake, file?.lines ?? []);
    expect(uploaded.purpose).toBe('batch');
    expect(fake.uploads[0]?.lines).toHaveLength(6);

    const created = await create(fake, uploaded.id);
    expect(created.status).toBe('validating');
    expect((await retrieve(fake, created.id)).status).toBe('in_progress');
    const done = await retrieve(fake, created.id);
    expect(done.status).toBe('completed');
    expect(done.output_file_id).toBeTruthy();
    expect(fake.counts).toEqual({ upload: 1, create: 1, retrieve: 2, content: 0 });
    expect(fake.batches[0]).toMatchObject({ endpoint: '/v1/embeddings', completionWindow: '24h' });
  });

  test('serves the output file in shuffled order and the error file for failed lines', async () => {
    fake = await startFakeOpenAiBatch();
    fake.script({ failLine: (id) => id.endsWith('0003:2') });
    const input = chunks(12);
    const [file] = buildBatchLines(input, PROFILE);
    const uploaded = await upload(fake, file?.lines ?? []);
    const created = await create(fake, uploaded.id);
    await retrieve(fake, created.id);
    const done = await retrieve(fake, created.id);

    const out = await (await fetch(`${fake.baseUrl}/files/${done.output_file_id}/content`)).text();
    const outIds = out.split('\n').filter(Boolean).map((l) => JSON.parse(l).custom_id as string);
    expect(outIds).toHaveLength(11);
    expect(outIds).not.toEqual([...outIds].sort());
    const first = JSON.parse(out.split('\n')[0] ?? '{}');
    expect(first.response.body.data[0].embedding).toEqual(fakeVector(first.custom_id, 1536));

    const err = await (await fetch(`${fake.baseUrl}/files/${done.error_file_id}/content`)).text();
    const errLines = err.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(errLines).toHaveLength(1);
    expect(errLines[0].custom_id.endsWith('0003:2')).toBe(true);
    expect(fake.counts.content).toBe(2);
  });

  test('an expired script completes only the first N lines and reports the rest in the error file', async () => {
    fake = await startFakeOpenAiBatch();
    fake.script({ states: ['in_progress', 'expired'], completeOnly: 3 });
    const [file] = buildBatchLines(chunks(10), PROFILE);
    const uploaded = await upload(fake, file?.lines ?? []);
    const created = await create(fake, uploaded.id);
    expect(created.status).toBe('in_progress');
    const done = await retrieve(fake, created.id);
    expect(done.status).toBe('expired');
    const out = await (await fetch(`${fake.baseUrl}/files/${done.output_file_id}/content`)).text();
    expect(out.split('\n').filter(Boolean)).toHaveLength(3);
    const err = await (await fetch(`${fake.baseUrl}/files/${done.error_file_id}/content`)).text();
    expect(err.split('\n').filter(Boolean)).toHaveLength(7);
  });

  test('tracks the largest number of open batches', async () => {
    fake = await startFakeOpenAiBatch();
    const [file] = buildBatchLines(chunks(2), PROFILE);
    const uploaded = await upload(fake, file?.lines ?? []);
    const a = await create(fake, uploaded.id);
    const b = await create(fake, uploaded.id);
    expect(fake.maxOpen()).toBe(2);
    for (const id of [a.id, b.id]) {
      await retrieve(fake, id);
      await retrieve(fake, id);
    }
    const c = await create(fake, uploaded.id);
    expect(c.status).toBe('validating');
    expect(fake.maxOpen()).toBe(2);
  });
});

const BATCH_ID = '00000000-0000-4000-8000-0000000000b1';
const POLL_MS = 60_000;

interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}

interface FakeRow {
  id: string;
  batch_id: string;
  profile_id: string;
  provider: string;
  provider_batch_id: string | null;
  input_file_id: string | null;
  input_count: number;
  status: string;
  output_file_id: string | null;
  error_file_id: string | null;
  error: string | null;
}

function fakeRpc(onEvent?: (event: string) => void, seed: FakeRow[] = []) {
  const calls: RpcCall[] = [];
  const rows: FakeRow[] = [...seed];
  let failRecord = false;
  const rpc: RpcClient = {
    rpc(fn, args) {
      calls.push({ fn, args });
      onEvent?.(`rpc:${fn}`);
      const respond = (): RpcResponse => {
        if (fn === 'rag_record_embed_batch') {
          if (failRecord) return { data: null, error: { message: 'boom', code: '57014' } };
          const row: FakeRow = {
            id: `row-${rows.length + 1}`,
            batch_id: String(args.p_batch_id),
            profile_id: String(args.p_profile_id),
            provider: String(args.p_provider),
            provider_batch_id: (args.p_provider_batch_id as string | null) ?? null,
            input_file_id: (args.p_input_file_id as string | null) ?? null,
            input_count: Number(args.p_input_count),
            status: String(args.p_status),
            output_file_id: null,
            error_file_id: null,
            error: null,
          };
          rows.push(row);
          return { data: [row], error: null };
        }
        if (fn === 'rag_update_embed_batch') {
          const row = rows.find((r) => r.id === args.p_embed_batch_id);
          if (!row) return { data: null, error: { message: 'missing', code: '22023' } };
          row.status = String(args.p_status);
          row.provider_batch_id = (args.p_provider_batch_id as string | null) ?? row.provider_batch_id;
          row.output_file_id = (args.p_output_file_id as string | null) ?? row.output_file_id;
          row.error_file_id = (args.p_error_file_id as string | null) ?? row.error_file_id;
          row.error = (args.p_error as string | null) ?? row.error;
          return { data: [row], error: null };
        }
        if (fn === 'rag_open_embed_batches') {
          return { data: rows.filter((r) => r.status !== 'completed' && r.status !== 'cancelled'), error: null };
        }
        return { data: null, error: { message: 'unknown rpc', code: '42883' } };
      };
      const request: RpcRequest = {
        abortSignal: () => request,
        then: (resolve, reject) => Promise.resolve(respond()).then(resolve, reject),
      };
      return request;
    },
  };
  return {
    rpc,
    calls,
    rows,
    failRecord(value: boolean) {
      failRecord = value;
    },
  };
}

function fakeClock() {
  const sleeps: number[] = [];
  return { sleeps, clock: { sleep: async (ms: number) => void sleeps.push(ms) } };
}

describe('Batch API client against the fake', () => {
  let fake: FakeOpenAiBatch | null = null;
  afterEach(async () => {
    await fake?.stop();
    fake = null;
  });

  async function setup(seed: FakeRow[] = []) {
    const events: string[] = [];
    fake = await startFakeOpenAiBatch({ onEvent: (e) => events.push(e) });
    const client = new OpenAI({ apiKey: 'sk-test-placeholder', baseURL: fake.baseUrl, maxRetries: 0 });
    const rpc = fakeRpc((e) => events.push(e), seed);
    const { sleeps, clock } = fakeClock();
    const deps: BatchApiDeps = {
      rpc: rpc.rpc,
      client: client as unknown as BatchApiClient,
      signal: new AbortController().signal,
      clock,
    };
    return { fake, events, rpc, sleeps, deps, client };
  }

  test('submit uploads with purpose batch, creates with window 24h and records the row before any retrieve', async () => {
    const { fake: api, events, rpc, deps } = await setup();
    const [file] = buildBatchLines(chunks(4), PROFILE);
    const submitted = await submitBatch(deps, { batchId: BATCH_ID, profile: PROFILE, file: file! });

    expect(api.uploads[0]?.purpose).toBe('batch');
    expect(api.uploads[0]?.lines).toEqual(file?.lines);
    expect(api.batches[0]).toMatchObject({ endpoint: '/v1/embeddings', completionWindow: '24h' });
    const record = rpc.calls.find((c) => c.fn === 'rag_record_embed_batch');
    expect(record?.args).toMatchObject({
      p_batch_id: BATCH_ID,
      p_profile_id: PROFILE.id,
      p_provider: 'openai',
      p_provider_batch_id: 'batch_fake_1',
      p_input_file_id: api.uploads[0]?.id,
      p_input_count: 4,
      p_status: 'validating',
    });
    expect(submitted).toMatchObject({ providerBatchId: 'batch_fake_1', customIds: file?.customIds });
    expect(events).toEqual(['upload', 'create:batch_fake_1', 'rpc:rag_record_embed_batch']);

    await pollAndCollect(deps, submitted, { profile: PROFILE, expected: file?.customIds });
    expect(events.indexOf('rpc:rag_record_embed_batch')).toBeLessThan(events.indexOf('retrieve:batch_fake_1'));
  });

  test('a failed row write reports the provider batch id so the batch can be found', async () => {
    const { rpc, deps } = await setup();
    rpc.failRecord(true);
    const [file] = buildBatchLines(chunks(2), PROFILE);
    await expect(submitBatch(deps, { batchId: BATCH_ID, profile: PROFILE, file: file! })).rejects.toMatchObject({
      providerBatchId: 'batch_fake_1',
    });
  });

  test('polls every 60 s on the injected clock and maps shuffled output by custom_id', async () => {
    const { fake: api, sleeps, deps } = await setup();
    const input = chunks(40);
    const [file] = buildBatchLines(input, PROFILE);
    const submitted = await submitBatch(deps, { batchId: BATCH_ID, profile: PROFILE, file: file! });
    const result = await pollAndCollect(deps, submitted, { profile: PROFILE, expected: file?.customIds });

    expect(result.status).toBe('completed');
    expect(sleeps.length).toBeGreaterThanOrEqual(1);
    expect(sleeps.every((ms) => ms === POLL_MS)).toBe(true);
    expect(result.vectors.size).toBe(40);
    expect(result.missing).toEqual([]);
    for (const customId of file?.customIds ?? []) expect(result.vectors.get(customId)).toEqual(fakeVector(customId, 1536));
    const outputOrder = (await (await fetch(`${api.baseUrl}/files/${result.outputFileId}/content`)).text())
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l).custom_id);
    expect(outputOrder).not.toEqual(file?.customIds);
  });

  test('rejects a vector of the wrong length and reports it missing', async () => {
    const { fake: api, deps } = await setup();
    const input = chunks(5);
    const bad = `${input[2]?.chunkId}:2`;
    api.script({ wrongDims: (id) => (id === bad ? 1535 : undefined) });
    const [file] = buildBatchLines(input, PROFILE);
    const submitted = await submitBatch(deps, { batchId: BATCH_ID, profile: PROFILE, file: file! });
    const result = await pollAndCollect(deps, submitted, { profile: PROFILE, expected: file?.customIds });
    expect(result.vectors.has(bad)).toBe(false);
    expect(result.vectors.size).toBe(4);
    expect(result.rejected).toEqual([bad]);
    expect(result.missing).toEqual([bad]);
  });

  test('reports lines from the error file as errored and missing', async () => {
    const { fake: api, deps } = await setup();
    const input = chunks(6);
    api.script({ failLine: (id) => id.startsWith(input[1]!.chunkId) });
    const [file] = buildBatchLines(input, PROFILE);
    const submitted = await submitBatch(deps, { batchId: BATCH_ID, profile: PROFILE, file: file! });
    const result = await pollAndCollect(deps, submitted, { profile: PROFILE, expected: file?.customIds });
    expect(result.errored).toEqual([`${input[1]?.chunkId}:2`]);
    expect(result.missing).toEqual([`${input[1]?.chunkId}:2`]);
    expect(result.vectors.size).toBe(5);
  });

  test('an expired batch yields its completed share and reports the rest missing; resubmit sends only those', async () => {
    const { fake: api, deps, rpc } = await setup();
    const input = chunks(100);
    api.script({ states: ['in_progress', 'expired'], completeOnly: 30 });
    const [file] = buildBatchLines(input, PROFILE);
    const submitted = await submitBatch(deps, { batchId: BATCH_ID, profile: PROFILE, file: file! });
    const result = await pollAndCollect(deps, submitted, { profile: PROFILE, expected: file?.customIds });
    expect(result.status).toBe('expired');
    expect(result.vectors.size).toBe(30);
    expect(result.missing).toHaveLength(70);

    const resubmitted = await resubmitMissing(deps, { batchId: BATCH_ID, profile: PROFILE, chunks: input, result, openSlots: 2 });
    expect(resubmitted).toHaveLength(1);
    const lines = api.uploads[1]?.lines.map((l) => JSON.parse(l).custom_id as string);
    expect(lines).toEqual(input.slice(30).map((c) => `${c.chunkId}:2`));
    expect(rpc.rows[0]).toMatchObject({ status: 'cancelled' });
    expect(rpc.rows[0]?.error).toMatch(/superseded/);
  });

  test('resubmitMissing refuses to exceed the open slots', async () => {
    const { deps } = await setup();
    const input = chunks(3);
    const result = {
      rowId: 'row-1',
      providerBatchId: 'batch_fake_9',
      status: 'failed',
      vectors: new Map(),
      missing: input.map((c) => `${c.chunkId}:2`),
      errored: [],
      rejected: [],
      outputFileId: null,
      errorFileId: null,
    };
    await expect(
      resubmitMissing(deps, { batchId: BATCH_ID, profile: PROFILE, chunks: input, result, openSlots: 0 }),
    ).rejects.toThrow(/open_limit/);
  });

  test('embedViaBatchApi resubmits a failed batch for all of its inputs', async () => {
    const { fake: api, deps } = await setup();
    const input = chunks(20);
    api.script({ states: ['validating', 'failed'] });
    const out = await embedViaBatchApi(deps, { batchId: BATCH_ID, profile: PROFILE, chunks: input });
    expect(api.counts.create).toBe(2);
    expect(api.uploads[1]?.lines).toEqual(api.uploads[0]?.lines);
    expect(out.vectors.size).toBe(20);
    expect(out.unresolved).toEqual([]);
  });

  test('embedViaBatchApi resubmits an expired batch with only the missing 70 of 100', async () => {
    const { fake: api, deps } = await setup();
    const input = chunks(100);
    api.script({ states: ['in_progress', 'expired'], completeOnly: 30 });
    const out = await embedViaBatchApi(deps, { batchId: BATCH_ID, profile: PROFILE, chunks: input });
    expect(api.uploads).toHaveLength(2);
    expect(api.uploads[1]?.lines).toHaveLength(70);
    expect(out.vectors.size).toBe(100);
    for (const c of input) expect(out.vectors.get(`${c.chunkId}:2`)).toEqual(fakeVector(`${c.chunkId}:2`, 1536));
  });

  test('keeps at most two batches open and submits the third only after one completes', async () => {
    const { fake: api, events, deps } = await setup();
    const out = await embedViaBatchApi(deps, {
      batchId: BATCH_ID,
      profile: PROFILE,
      chunks: chunks(25),
      limits: { maxInputs: 10 },
    });
    expect(api.counts.create).toBe(3);
    expect(api.maxOpen()).toBe(2);
    const thirdCreate = events.indexOf('create:batch_fake_3');
    const terminalRetrieves = events.slice(0, thirdCreate).filter((e) => e.startsWith('retrieve:')).length;
    expect(terminalRetrieves).toBeGreaterThanOrEqual(3);
    expect(out.vectors.size).toBe(25);
  });

  test('stops resubmitting an input that keeps erroring and reports it unresolved', async () => {
    const { fake: api, deps } = await setup();
    const input = chunks(5);
    const poison = `${input[3]?.chunkId}:2`;
    for (let i = 0; i < 4; i += 1) api.script({ failLine: (id) => id === poison });
    const out = await embedViaBatchApi(deps, { batchId: BATCH_ID, profile: PROFILE, chunks: input, maxAttempts: 3 });
    expect(out.unresolved).toEqual([poison]);
    expect(out.vectors.size).toBe(4);
    expect(api.counts.create).toBe(3);
  });

  test('resuming with an open in_progress row polls it instead of submitting again', async () => {
    const input = chunks(12);
    const { fake: api, deps, client, rpc } = await setup();
    const [file] = buildBatchLines(input, PROFILE);
    const submitted = await submitBatch(deps, { batchId: BATCH_ID, profile: PROFILE, file: file! });
    expect(submitted.providerBatchId).toBe('batch_fake_1');
    const createsBefore = api.counts.create;
    const uploadsBefore = api.counts.upload;

    const resumeDeps: BatchApiDeps = { ...deps, rpc: rpc.rpc, client: client as unknown as BatchApiClient };
    const out = await embedViaBatchApi(resumeDeps, { batchId: BATCH_ID, profile: PROFILE, chunks: input });
    expect(api.counts.create).toBe(createsBefore);
    expect(api.counts.upload).toBe(uploadsBefore);
    expect(out.vectors.size).toBe(12);
    expect(out.batchesSubmitted).toBe(0);
    expect(rpc.rows[0]?.status).toBe('completed');
  });

  test('after draining a resumed batch it submits only the chunks that still have no vector', async () => {
    const input = chunks(10);
    const { fake: api, deps } = await setup();
    api.script({ states: ['in_progress', 'expired'], completeOnly: 4 });
    const [file] = buildBatchLines(input, PROFILE);
    await submitBatch(deps, { batchId: BATCH_ID, profile: PROFILE, file: file! });
    const out = await embedViaBatchApi(deps, { batchId: BATCH_ID, profile: PROFILE, chunks: input });
    expect(api.uploads).toHaveLength(2);
    expect(api.uploads[1]?.lines).toHaveLength(6);
    expect(out.vectors.size).toBe(10);
  });

  test('hands each batch its vectors before closing its row', async () => {
    const { deps, rpc } = await setup();
    const seen: string[] = [];
    await embedViaBatchApi(deps, {
      batchId: BATCH_ID,
      profile: PROFILE,
      chunks: chunks(3),
      onVectors: async (vectors) => {
        seen.push(`vectors:${vectors.size}:${rpc.rows[0]?.status}`);
      },
    });
    expect(seen).toEqual(['vectors:3:in_progress']);
    expect(rpc.rows[0]?.status).toBe('completed');
  });
});

describe('collecting hostile or malformed output', () => {
  function stubClient(output: string, errorFile?: string): BatchApiClient {
    return {
      files: {
        create: async () => ({ id: 'file-1' }),
        content: async (id: string) => new Response(id === 'out' ? output : (errorFile ?? '')),
      },
      batches: {
        create: async () => ({ id: 'b1', status: 'validating' }),
        retrieve: async () => ({ id: 'b1', status: 'completed', output_file_id: 'out', error_file_id: errorFile ? 'err' : null }),
      },
    };
  }

  const okLine = (customId: string, dims = 1536, status = 200) =>
    JSON.stringify({
      custom_id: customId,
      response: { status_code: status, body: { data: [{ embedding: Array.from({ length: dims }, () => 0.25) }] } },
      error: null,
    });

  function collectDeps(client: BatchApiClient): BatchApiDeps {
    return { rpc: fakeRpc().rpc, client, signal: new AbortController().signal, clock: fakeClock().clock };
  }

  test('ignores custom ids that were not requested and malformed lines', async () => {
    const out = [okLine('a:1'), okLine('stranger:1'), '{not json', okLine('b:1', 1535), okLine('c:1', 1536, 429)].join('\n');
    const deps = collectDeps(stubClient(out));
    const result = await pollAndCollect(deps, { rowId: 'r', providerBatchId: 'b1' }, { profile: PROFILE, expected: ['a:1', 'b:1', 'c:1', 'd:1'] });
    expect([...result.vectors.keys()]).toEqual(['a:1']);
    expect(result.missing.sort()).toEqual(['b:1', 'c:1', 'd:1']);
    expect(result.rejected).toEqual(['b:1']);
    expect(result.errored).toEqual(['c:1']);
  });

  test('keeps the first line when a custom id repeats', async () => {
    const first = JSON.stringify({ custom_id: 'a:1', response: { status_code: 200, body: { data: [{ embedding: new Array(1536).fill(0.1) }] } } });
    const second = JSON.stringify({ custom_id: 'a:1', response: { status_code: 200, body: { data: [{ embedding: new Array(1536).fill(0.9) }] } } });
    const result = await pollAndCollect(collectDeps(stubClient([first, second].join('\n'))), { rowId: 'r', providerBatchId: 'b1' }, { profile: PROFILE, expected: ['a:1'] });
    expect(result.vectors.get('a:1')?.[0]).toBe(0.1);
  });

  test('a non-finite component rejects the vector', async () => {
    const line = JSON.stringify({ custom_id: 'a:1', response: { status_code: 200, body: { data: [{ embedding: [...new Array(1535).fill(0.1), 'x'] }] } } });
    const result = await pollAndCollect(collectDeps(stubClient(line)), { rowId: 'r', providerBatchId: 'b1' }, { profile: PROFILE, expected: ['a:1'] });
    expect(result.rejected).toEqual(['a:1']);
    expect(result.vectors.size).toBe(0);
  });
});
