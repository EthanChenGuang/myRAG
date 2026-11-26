import { afterEach, describe, expect, test } from 'vitest';
import { loadIngestConfig } from '@/lib/rag/ingest/config';
import { getIngestDeps } from '@/lib/rag/ingest/deps';
import { embedStage } from '@/lib/rag/ingest/stages/embed-write';
import { ingestStateFromRecord } from '@/lib/rag/ingest/status';
import { emptyIngestState, type IngestState, type StageContext } from '@/lib/rag/ingest/types';
import { createIngestWriter } from '@/lib/rag/ingest/writer';
import { mintScope } from '@/lib/rag/tenant/scope';
import { FAKE_DOCUMENT_ID, FAKE_LINEAGE_ID, callsOf, fakeIngestDb, installIngestDeps, uninstallIngestDeps, unitVector } from '../../helpers/ingest-fakes';

// Each chunk is large enough to fill one ~1 MB embedding batch on its own.
const CHUNKS = ['alpha', 'bravo', 'charlie'].map((word) => `${word} `.repeat(120_000));

afterEach(() => {
  uninstallIngestDeps();
});

function embedContext(clock: { now: number }, state: IngestState, onEmbed: () => void) {
  const { db, calls } = fakeIngestDb();
  installIngestDeps({
    db,
    now: () => clock.now,
    embedDocuments: async (texts) => {
      onEmbed();
      return texts.map(() => unitVector());
    },
  });
  const deps = getIngestDeps();
  const signal = new AbortController().signal;
  const scope = mintScope('single', null, null);
  const ctx: StageContext = {
    input: { scope, source: 'config_upload', sourceKey: 'root/big.pdf', file: new Uint8Array(1), filename: 'big.pdf', mimeType: 'application/pdf', signal },
    deps,
    writer: createIngestWriter({ db, scope, signal }),
    config: loadIngestConfig(deps.ingestEnv()),
    signal,
    deadline: clock.now + 50_000,
    state,
    warnings: [],
    identity: { profile: {}, docType: 'general', tenantKey: 's:single' } as unknown as StageContext['identity'],
    document: { id: FAKE_DOCUMENT_ID, lineageId: FAKE_LINEAGE_ID, version: 1, resumed: true },
    parserUsed: 'docling',
    work: {
      parseText: CHUNKS.join('\n\n'),
      parserVersion: 'test',
      chunks: CHUNKS.map((content) => ({ content, section_path: ['Big'], chunk_kind: 'text' as const, page_start: 1, page_end: 1, metadata: {} })),
      chunksWritten: 0,
    },
  };
  return { ctx, calls };
}

function writtenIndexes(calls: ReturnType<typeof fakeIngestDb>['calls']): number[] {
  return callsOf(calls, 'rag_write_chunks').flatMap((call) => (call.args.p_chunks as Array<{ chunk_index: number }>).map((chunk) => chunk.chunk_index));
}

describe('the embed stage resumes between batches', () => {
  test('yields after a batch when the budget runs low, and a resumed call continues with the next batch', async () => {
    const clock = { now: 1_000_000 };
    // Each embedding call uses 46 s of a 50 s budget: one batch fits per call.
    const first = embedContext(clock, emptyIngestState(), () => {
      clock.now += 46_000;
    });
    const yielded = await embedStage.run(first.ctx);
    expect(yielded).toEqual({ kind: 'yield', reason: 'deadline' });
    expect(writtenIndexes(first.calls)).toEqual([0]);
    expect(first.ctx.state.embedProgress).toMatchObject({ batchesDone: 1, written: 1, total: 3 });
    expect(first.ctx.work.chunksWritten).toBe(1);

    // The progress survives the processing_state round trip, as a resume reads it.
    const persisted = ingestStateFromRecord(JSON.parse(JSON.stringify(first.ctx.state)) as Record<string, unknown>);
    expect(persisted.embedProgress).toEqual(first.ctx.state.embedProgress);

    uninstallIngestDeps();
    const second = embedContext(clock, persisted, () => {
      clock.now += 46_000;
    });
    expect(await embedStage.run(second.ctx)).toEqual({ kind: 'yield', reason: 'deadline' });
    expect(writtenIndexes(second.calls)).toEqual([1]);

    uninstallIngestDeps();
    const third = embedContext(clock, ingestStateFromRecord(JSON.parse(JSON.stringify(second.ctx.state)) as Record<string, unknown>), () => {
      clock.now += 46_000;
    });
    const done = await embedStage.run(third.ctx);
    expect(done.kind).toBe('next');
    expect(writtenIndexes(third.calls)).toEqual([2]);
    expect(third.ctx.work.chunksWritten).toBe(3);
    expect(third.ctx.state.embedProgress).toBeUndefined();
    const finalCall = callsOf(third.calls, 'rag_write_chunks').at(-1);
    expect(finalCall?.args).toMatchObject({ p_final: true, p_total: 3 });
  });

  test('runs every batch in one call when the budget allows, and writes no progress', async () => {
    const clock = { now: 1_000_000 };
    const run = embedContext(clock, emptyIngestState(), () => {
      clock.now += 1_000;
    });
    expect((await embedStage.run(run.ctx)).kind).toBe('next');
    expect(writtenIndexes(run.calls)).toEqual([0, 1, 2]);
    expect(run.ctx.state.embedProgress).toBeUndefined();
  });

  test('ignores progress recorded for a different chunk total and starts over', async () => {
    const clock = { now: 1_000_000 };
    const state = emptyIngestState();
    state.embedProgress = { batchesDone: 2, written: 2, total: 7, targets: ['legacy'], gaps: [] };
    const run = embedContext(clock, state, () => {
      clock.now += 1_000;
    });
    expect((await embedStage.run(run.ctx)).kind).toBe('next');
    expect(writtenIndexes(run.calls)).toEqual([0, 1, 2]);
  });

  test('a malformed stored progress record is dropped on read', () => {
    expect(ingestStateFromRecord({ embedProgress: { batchesDone: -1, written: 0, total: 3, targets: [], gaps: [] } }).embedProgress).toBeUndefined();
    expect(ingestStateFromRecord({ embedProgress: { batchesDone: 1, written: 1, total: 3, targets: [1], gaps: [] } }).embedProgress).toBeUndefined();
    expect(ingestStateFromRecord({ uploaderId: 'not-a-uuid' }).uploaderId).toBeUndefined();
  });
});
