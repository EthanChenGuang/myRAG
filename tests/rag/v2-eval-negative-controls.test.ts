import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackendLegs, RetrievalBackend } from '@/lib/rag/backend/types';
import { resetRetrievalBackendForTests, setRetrievalBackendForTests } from '@/lib/rag/backend/registry';
import { resetActiveChunkingProfilesForTests } from '@/lib/rag/chunking/active';
import { runRetrieval } from '@/lib/rag';
import { mintScope } from '@/lib/rag/tenant/scope';
import type { Profile, RetrievalResult, RunRetrievalInput } from '@/lib/rag/types';
import { resetV2StartupForTests, verifyV2Startup } from '@/lib/rag/v2/startup';
import { hit } from './fusion/helpers';
import { adminWithRpc, fakeAssemblyAdmin, fakeEmbedder, fakeRpcClient, installDeps, uninstallDeps } from './helpers/pipeline-fakes';

const scope = mintScope('single', null, null);
const QUERY = 'Which synthetic sample record describes the reference value?';
const V2_ENV = { RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'false', RAG_RERANKER: 'none', RAG_REFUSAL_THRESHOLD: 'false' };
const FINAL_TOP_K = 8;

/** Twelve dense hits, best first; every chunk sits in its own document. */
function backend(similarities: number[]): RetrievalBackend {
  return {
    id: 'pgvector',
    async search() {
      return {
        dense: similarities.map((similarity, index) =>
          hit(`chunk-${index + 1}`, {
            rank: index + 1,
            similarity,
            documentId: `doc-${index + 1}`,
            chunkIndex: index,
            content: `Synthetic sample record number ${index + 1} with a neutral reference value.`,
            document: { filename: `sample-${index + 1}.txt`, createdAt: null, metadata: {}, contentPreview: '' },
          }),
        ),
        lexical: [],
      } satisfies BackendLegs;
    },
    health: async () => ({ ok: true }),
    isReady: async () => true,
  };
}

const ALL_HIGH = Array.from({ length: 12 }, (_unused, index) => 0.95 - index * 0.01);
const ONLY_TOP_HIGH = [0.95, ...Array.from({ length: 11 }, (_unused, index) => 0.3 - index * 0.01)];

async function install(similarities: number[]) {
  uninstallDeps();
  resetRetrievalBackendForTests();
  resetV2StartupForTests();
  resetActiveChunkingProfilesForTests();
  const { embedder } = fakeEmbedder();
  const rpc = fakeRpcClient();
  installDeps({
    embedder,
    adminClient: adminWithRpc(rpc.client, fakeAssemblyAdmin()),
    ragEnv: () => V2_ENV,
  });
  setRetrievalBackendForTests(backend(similarities));
  await verifyV2Startup();
}

function input(profile: Profile, options: RunRetrievalInput['options'] = {}): RunRetrievalInput {
  return {
    scope,
    query: QUERY,
    profile,
    options: { ragMode: 'strict', webSearchEnabled: false, ...options },
    signal: new AbortController().signal,
  };
}

async function retrieve(similarities: number[], profile: Profile, options?: RunRetrievalInput['options']) {
  await install(similarities);
  return runRetrieval(input(profile, options));
}

/** Timing and the trace id differ per run; everything else must be identical. */
function comparable(result: RetrievalResult) {
  const copy: Partial<RetrievalResult> = { ...result };
  delete copy.traceId;
  copy.stages = result.stages.map((stage) => {
    const record: Partial<typeof stage> = { ...stage };
    delete record.startedAt;
    delete record.endedAt;
    delete record.latency_ms;
    return record as typeof stage;
  });
  return copy;
}

function ids(list: Array<{ chunk_id: string }>): string[] {
  return list.map((entry) => entry.chunk_id);
}

describe('CI negative controls on the v2 eval path', () => {
  const processEnv = process.env as Record<string, string | undefined>;
  let savedFinalCount: string | undefined;

  beforeEach(() => {
    savedFinalCount = processEnv.RAG_FINAL_RESULT_COUNT;
    delete processEnv.RAG_FINAL_RESULT_COUNT;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    if (savedFinalCount === undefined) delete processEnv.RAG_FINAL_RESULT_COUNT;
    else processEnv.RAG_FINAL_RESULT_COUNT = savedFinalCount;
    uninstallDeps();
    resetRetrievalBackendForTests();
    resetV2StartupForTests();
    vi.restoreAllMocks();
  });

  it('v2 eval drops the top candidate from the final order and the kept list', async () => {
    const baseline = await retrieve(ALL_HIGH, 'eval');
    const degraded = await retrieve(ALL_HIGH, 'eval', { degrade: 'drop_top_candidate' });

    expect(baseline.refusal?.decision).not.toBe('refuse');
    expect(ids(baseline.candidates)[0]).toBe('chunk-1');
    expect(ids(baseline.candidates)).toEqual(backendOrder(1, FINAL_TOP_K));
    expect(ids(degraded.candidates)).toEqual(backendOrder(2, FINAL_TOP_K));
    expect(ids(degraded.kept)).not.toContain('chunk-1');
    expect(degraded.kept.length).toBeGreaterThan(0);
    const refusalStage = degraded.stages.find((stage) => stage.name === 'refusal');
    expect(refusalStage?.detail ?? '').toContain('drop_top_candidate');
    expect(baseline.stages.find((stage) => stage.name === 'refusal')?.detail ?? '').not.toContain('drop_top_candidate');
  });

  it('v2 eval drops the top candidate before the refusal decision and from the pre-refusal candidates', async () => {
    const baseline = await retrieve(ONLY_TOP_HIGH, 'eval');
    const degraded = await retrieve(ONLY_TOP_HIGH, 'eval', { degrade: 'drop_top_candidate' });

    expect(baseline.refusal?.decision).toBe('answer');
    expect(degraded.refusal?.decision).toBe('refuse');
    expect(ids(degraded.candidates)).toEqual(backendOrder(2, 11));
    expect(ids(degraded.candidates)).not.toContain('chunk-1');
  });

  it('v2 eval honours max results on the final top-k and the kept list', async () => {
    const one = await retrieve(ALL_HIGH, 'eval', { maxResults: 1 });
    expect(ids(one.candidates)).toEqual(['chunk-1']);
    expect(one.kept.length).toBeLessThanOrEqual(1);

    const three = await retrieve(ALL_HIGH, 'eval', { maxResults: 3 });
    expect(ids(three.candidates)).toEqual(backendOrder(1, 3));
    expect(three.stages.find((stage) => stage.name === 'assemble')?.counts?.max_results).toBe(3);
  });

  it('v2 eval honours max results on the pre-refusal candidates of a refused item', async () => {
    const capped = await retrieve(ONLY_TOP_HIGH, 'eval', { maxResults: 2, degrade: 'drop_top_candidate' });
    expect(capped.refusal?.decision).toBe('refuse');
    expect(ids(capped.candidates)).toEqual(['chunk-2', 'chunk-3']);
  });

  it('a max results above the final top-k changes nothing', async () => {
    const baseline = comparable(await retrieve(ALL_HIGH, 'eval'));
    const wide = await retrieve(ALL_HIGH, 'eval', { maxResults: 25 });
    expect(ids(wide.candidates)).toEqual(ids(baseline.candidates ?? []));
    expect(wide.retrievalConfigHash).toBe(baseline.retrievalConfigHash);
  });

  it.each<Profile>(['chat', 'embed'])('options are eval-only: the %s profile ignores degrade and max results', async (profile) => {
    for (const similarities of [ALL_HIGH, ONLY_TOP_HIGH]) {
      const baseline = comparable(await retrieve(similarities, profile));
      const withOptions = comparable(await retrieve(similarities, profile, { degrade: 'drop_top_candidate', maxResults: 1 }));
      expect(withOptions).toStrictEqual(baseline);
      expect(withOptions.retrievalConfigHash).toBe(baseline.retrievalConfigHash);
    }
  });

  it('options are eval-only: the voice profile ignores degrade', async () => {
    for (const similarities of [ALL_HIGH, ONLY_TOP_HIGH]) {
      const baseline = comparable(await retrieve(similarities, 'voice'));
      const degraded = comparable(await retrieve(similarities, 'voice', { degrade: 'drop_top_candidate' }));
      expect(degraded).toStrictEqual(baseline);
    }
  });

  it('unset options change nothing, also with RAG_FINAL_RESULT_COUNT below the final top-k', async () => {
    for (const similarities of [ALL_HIGH, ONLY_TOP_HIGH]) {
      const baseline = comparable(await retrieve(similarities, 'eval'));
      processEnv.RAG_FINAL_RESULT_COUNT = '2';
      const lowEnv = comparable(await retrieve(similarities, 'eval'));
      delete processEnv.RAG_FINAL_RESULT_COUNT;
      expect(lowEnv).toStrictEqual(baseline);
      expect(baseline.stages?.find((stage) => stage.name === 'assemble')?.counts?.max_results).toBeUndefined();
      expect(baseline.stages?.find((stage) => stage.name === 'refusal')?.detail ?? '').not.toContain('drop_top_candidate');
    }
    const answered = await retrieve(ALL_HIGH, 'eval');
    expect(ids(answered.candidates)).toEqual(backendOrder(1, FINAL_TOP_K));
  });
});

/** chunk-<from> .. chunk-<from + count - 1>. */
function backendOrder(from: number, count: number): string[] {
  return Array.from({ length: count }, (_unused, index) => `chunk-${from + index}`);
}
