import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackendLegs, RetrievalBackend } from '@/lib/rag/backend/types';
import { resetRetrievalBackendForTests, setRetrievalBackendForTests } from '@/lib/rag/backend/registry';
import { resetActiveChunkingProfilesForTests } from '@/lib/rag/chunking/active';
import { runRetrieval } from '@/lib/rag';
import { mintScope } from '@/lib/rag/tenant/scope';
import type { RetrievalResult, RunRetrievalInput } from '@/lib/rag/types';
import { resetV2StartupForTests, verifyV2Startup } from '@/lib/rag/v2/startup';
import { hit } from '../fusion/helpers';
import { adminWithRpc, fakeAssemblyAdmin, fakeEmbedder, fakeRpcClient, installDeps, uninstallDeps } from '../helpers/pipeline-fakes';

const imported = vi.hoisted(() => ({ count: 0 }));

vi.mock('@/lib/rag/query/run-layer', () => {
  imported.count += 1;
  throw new Error('run-layer.ts must not be imported while the query layer is off');
});

const scope = mintScope('single', null, null);

function fakeBackend(): RetrievalBackend {
  return {
    id: 'pgvector',
    async search() {
      return {
        dense: [hit('chunk-1', { similarity: 0.9, documentId: 'doc-1' }), hit('chunk-2', { rank: 2, similarity: 0.8, documentId: 'doc-2' })],
        lexical: [],
      } satisfies BackendLegs;
    },
    health: async () => ({ ok: true }),
    isReady: async () => true,
  };
}

function install(env: Record<string, string>) {
  uninstallDeps();
  resetRetrievalBackendForTests();
  resetV2StartupForTests();
  resetActiveChunkingProfilesForTests();
  const { embedder } = fakeEmbedder();
  const rpc = fakeRpcClient();
  installDeps({
    embedder,
    adminClient: adminWithRpc(rpc.client, fakeAssemblyAdmin()),
    ragEnv: () => ({ RAG_LEXICAL_SEARCH: 'false', RAG_RERANKER: 'none', ...env }),
  });
  setRetrievalBackendForTests(fakeBackend());
}

function input(): RunRetrievalInput {
  return {
    scope,
    query: 'What does it weigh?',
    profile: 'eval',
    options: { ragMode: 'strict', webSearchEnabled: false },
    signal: new AbortController().signal,
    history: [
      { role: 'user', content: 'Tell me about the sample recorder.' },
      { role: 'assistant', content: 'The sample recorder is a portable device.' },
    ],
    classification: { needsMcp: false, confidence: 0.5, category: 'document_search', reasoningText: 'fixture' },
  };
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

async function retrieve(env: Record<string, string>): Promise<RetrievalResult> {
  install(env);
  if (env.RAG_PIPELINE === 'v2') await verifyV2Startup();
  return runRetrieval(input());
}

describe('query layer off: parity with Phase 4', () => {
  beforeEach(() => {
    imported.count = 0;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    uninstallDeps();
    resetRetrievalBackendForTests();
    resetV2StartupForTests();
    vi.restoreAllMocks();
  });

  it('RAG_QUERY_LAYER unset under v2 never imports run-layer and has no query plan', async () => {
    const result = await retrieve({ RAG_PIPELINE: 'v2' });
    expect(imported.count).toBe(0);
    expect(result.status).not.toBe('error');
    expect('queryPlan' in result).toBe(false);
    expect(result.stages.map((stage) => stage.name)).not.toContain('query_gate');
  });

  it('RAG_QUERY_LAYER=false under v2 equals the unset result', async () => {
    const baseline = comparable(await retrieve({ RAG_PIPELINE: 'v2' }));
    const off = comparable(await retrieve({ RAG_PIPELINE: 'v2', RAG_QUERY_LAYER: 'false' }));
    expect(imported.count).toBe(0);
    expect(off).toStrictEqual(baseline);
  });

  it('RAG_QUERY_LAYER=true under legacy equals legacy without it', async () => {
    const baseline = comparable(await retrieve({ RAG_PIPELINE: 'legacy' }));
    const on = comparable(await retrieve({ RAG_PIPELINE: 'legacy', RAG_QUERY_LAYER: 'true' }));
    expect(imported.count).toBe(0);
    expect(on).toStrictEqual(baseline);
    expect('queryPlan' in on).toBe(false);
  });

  it('RAG_QUERY_LAYER=true under v2 does import run-layer (the mock is live)', async () => {
    await expect(retrieve({ RAG_PIPELINE: 'v2', RAG_QUERY_LAYER: 'true' })).rejects.toThrow();
    expect(imported.count).toBeGreaterThan(0);
  });
});
