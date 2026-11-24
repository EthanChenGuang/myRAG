import { afterEach, describe, expect, test } from 'vitest';
import {
  MAX_BATCH_BYTES,
  MAX_BATCH_INPUTS,
  buildBatchLines,
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
