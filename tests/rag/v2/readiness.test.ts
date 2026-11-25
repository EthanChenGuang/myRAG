import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RetrievalBackendError } from '@/lib/rag/backend/supabase-rpc';
import { DEFAULT_PIPELINE, loadRagConfig, resetRagConfigForTests, setDefaultPipelineForTests } from '@/lib/rag/config';
import { getRagDeps, resetRagDepsForTests, setRagDepsForTests } from '@/lib/rag/deps';
import { IngestWriterError } from '@/lib/rag/ingest/writer';
import {
  isMissingPhase4Function,
  isV2Available,
  markV2Unavailable,
  resetV2ReadinessForTests,
  resolveEffectivePipeline,
} from '@/lib/rag/v2/readiness';
import { runRetrieval } from '@/lib/rag';
import type { BackendLegs, RetrievalBackend } from '@/lib/rag/backend/types';
import { resetRetrievalBackendForTests, setRetrievalBackendForTests } from '@/lib/rag/backend/registry';
import { resetActiveChunkingProfilesForTests } from '@/lib/rag/chunking/active';
import { mintScope } from '@/lib/rag/tenant/scope';
import { isV2Pipeline } from '@/lib/rag/v2/switch';
import { resetV2StartupForTests, verifyV2Startup } from '@/lib/rag/v2/startup';
import { hit } from '../fusion/helpers';
import { SEMANTIC_QUERY, adminWithRpc, fakeAssemblyAdmin, fakeEmbedder, fakeRpcClient, installDeps, rows, uninstallDeps } from '../helpers/pipeline-fakes';

function resetAll(): void {
  resetRagDepsForTests();
  resetRagConfigForTests();
  setDefaultPipelineForTests(null);
  resetV2ReadinessForTests();
}

describe('DEFAULT_PIPELINE and pipelineSource', () => {
  beforeEach(() => {
    resetAll();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    resetAll();
    vi.restoreAllMocks();
  });

  it('ships legacy as the default', () => {
    expect(DEFAULT_PIPELINE).toBe('legacy');
    const config = loadRagConfig({ RAG_PIPELINE: '' });
    expect(config.pipeline).toBe('legacy');
    expect(config.pipelineSource).toBe('default');
  });

  it('an empty value parses to the default the setter chose, source default', () => {
    setDefaultPipelineForTests('v2');
    const config = loadRagConfig({ RAG_PIPELINE: '' });
    expect(config.pipeline).toBe('v2');
    expect(config.pipelineSource).toBe('default');
  });

  it('a value of spaces only counts as unset', () => {
    setDefaultPipelineForTests('v2');
    const config = loadRagConfig({ RAG_PIPELINE: '   ' });
    expect(config.pipeline).toBe('v2');
    expect(config.pipelineSource).toBe('default');
  });

  it('RAG_PIPELINE=v2 and RAG_PIPELINE=legacy are explicit', () => {
    expect(loadRagConfig({ RAG_PIPELINE: 'v2' })).toMatchObject({ pipeline: 'v2', pipelineSource: 'explicit' });
    setDefaultPipelineForTests('v2');
    expect(loadRagConfig({ RAG_PIPELINE: 'legacy' })).toMatchObject({ pipeline: 'legacy', pipelineSource: 'explicit' });
  });

  it('an unknown value still runs legacy with the existing warning, source explicit', () => {
    setDefaultPipelineForTests('v2');
    const config = loadRagConfig({ RAG_PIPELINE: 'v3' });
    expect(config).toMatchObject({ pipeline: 'legacy', pipelineSource: 'explicit' });
    expect(config.warnings.some((warning) => warning.startsWith('Unsupported RAG_PIPELINE value'))).toBe(true);
  });

  it('the deps reader takes the source from the process value, not the env.ts fallback', () => {
    setDefaultPipelineForTests('v2');
    setRagDepsForTests({ rawPipelineEnv: () => ({ RAG_PIPELINE: undefined, RAG_INGEST_PIPELINE: undefined }) });
    const unset = getRagDeps().ragEnv();
    expect(unset.pipelineSourceHint).toBe('default');
    expect(loadRagConfig({ ...unset, RAG_PIPELINE: 'legacy' })).toMatchObject({ pipeline: 'v2', pipelineSource: 'default' });

    setRagDepsForTests({ rawPipelineEnv: () => ({ RAG_PIPELINE: 'legacy', RAG_INGEST_PIPELINE: undefined }) });
    expect(getRagDeps().ragEnv().pipelineSourceHint).toBe('explicit');
  });

  it('the language seam reports no reader by default', () => {
    expect(getRagDeps().languagesConfigured()).toBeNull();
  });
});

describe('isMissingPhase4Function', () => {
  it('is true only for the two Phase 4 functions with PGRST202 or 42883', () => {
    expect(isMissingPhase4Function(new RetrievalBackendError('hybrid_search_chunks', 'PGRST202'))).toBe(true);
    expect(isMissingPhase4Function(new RetrievalBackendError('hybrid_search_chunks', '42883'))).toBe(true);
    expect(isMissingPhase4Function(new IngestWriterError('rag_list_chunking_profiles', 'PGRST202'))).toBe(true);
    expect(isMissingPhase4Function(new IngestWriterError('rag_list_chunking_profiles', '42883'))).toBe(true);

    expect(isMissingPhase4Function(new RetrievalBackendError('hybrid_search_chunks', '57014'))).toBe(false);
    expect(isMissingPhase4Function(new RetrievalBackendError('hybrid_search_chunks', null))).toBe(false);
    expect(isMissingPhase4Function(new RetrievalBackendError('match_document_chunks', 'PGRST202'))).toBe(false);
    expect(isMissingPhase4Function(new IngestWriterError('rag_write_profile_chunks', '42883'))).toBe(false);
    expect(isMissingPhase4Function(Object.assign(new Error('x'), { rpc: 'hybrid_search_chunks', code: 'PGRST202' }))).toBe(false);
    expect(isMissingPhase4Function(null)).toBe(false);
  });
});

describe('markV2Unavailable', () => {
  beforeEach(resetAll);
  afterEach(() => {
    resetAll();
    vi.restoreAllMocks();
  });

  it('logs once and stays unavailable until reset', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(isV2Available()).toBe(true);
    markV2Unavailable('hybrid_search_chunks');
    markV2Unavailable('rag_list_chunking_profiles');
    expect(isV2Available()).toBe(false);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0])).toMatch(/^\[RAG Config\] a Phase 4 database function is missing/);
    expect(error.mock.calls[0]?.[1]).toEqual({ function: 'hybrid_search_chunks' });
    resetV2ReadinessForTests();
    expect(isV2Available()).toBe(true);
  });
});

describe('resolveEffectivePipeline', () => {
  let logs: ReturnType<typeof vi.spyOn>[] = [];

  beforeEach(() => {
    resetAll();
    logs = [
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
    ];
  });
  afterEach(() => {
    for (const log of logs) expect(log).not.toHaveBeenCalled();
    resetAll();
    vi.restoreAllMocks();
  });

  function silentUnavailable(): void {
    markV2Unavailable('hybrid_search_chunks');
    for (const log of logs) log.mockClear();
  }

  it('explicit legacy', () => {
    setDefaultPipelineForTests('v2');
    expect(resolveEffectivePipeline({ RAG_PIPELINE: 'legacy' })).toEqual({ pipeline: 'legacy', source: 'explicit', fallback: 'none' });
  });

  it('default legacy', () => {
    expect(resolveEffectivePipeline({ RAG_PIPELINE: '' })).toEqual({ pipeline: 'legacy', source: 'default', fallback: 'none' });
  });

  it('explicit v2 never falls back', () => {
    setRagDepsForTests({ languagesConfigured: () => false });
    silentUnavailable();
    expect(resolveEffectivePipeline({ RAG_PIPELINE: 'v2' })).toEqual({ pipeline: 'v2', source: 'explicit', fallback: 'none' });
  });

  it('default v2 with languages not configured serves legacy', () => {
    setDefaultPipelineForTests('v2');
    setRagDepsForTests({ languagesConfigured: () => false });
    expect(resolveEffectivePipeline({ RAG_PIPELINE: '' })).toEqual({
      pipeline: 'legacy',
      source: 'default',
      fallback: 'languages_not_configured',
    });
  });

  it('default v2 with v2 unavailable serves legacy', () => {
    setDefaultPipelineForTests('v2');
    silentUnavailable();
    expect(resolveEffectivePipeline({ RAG_PIPELINE: '' })).toEqual({ pipeline: 'legacy', source: 'default', fallback: 'v2_unavailable' });
  });

  it('default v2 with languages configured runs v2', () => {
    setDefaultPipelineForTests('v2');
    setRagDepsForTests({ languagesConfigured: () => true });
    expect(resolveEffectivePipeline({ RAG_PIPELINE: '' })).toEqual({ pipeline: 'v2', source: 'default', fallback: 'none' });
  });

  it('no language reader connected means no language fallback', () => {
    setDefaultPipelineForTests('v2');
    setRagDepsForTests({ languagesConfigured: () => null });
    expect(resolveEffectivePipeline({ RAG_PIPELINE: '' })).toEqual({ pipeline: 'v2', source: 'default', fallback: 'none' });
  });

  it('languages are checked before readiness', () => {
    setDefaultPipelineForTests('v2');
    setRagDepsForTests({ languagesConfigured: () => false });
    silentUnavailable();
    expect(resolveEffectivePipeline({ RAG_PIPELINE: '' })).toEqual({
      pipeline: 'legacy',
      source: 'default',
      fallback: 'languages_not_configured',
    });
  });

  it('reads the deps environment when called without one', () => {
    setDefaultPipelineForTests('v2');
    setRagDepsForTests({ ragEnv: () => ({ RAG_PIPELINE: undefined }) });
    expect(resolveEffectivePipeline()).toEqual({ pipeline: 'v2', source: 'default', fallback: 'none' });
  });
});

describe('runRetrieval follows the resolver', () => {
  const scope = mintScope('single', null, null);
  const PROFILES = ['chat', 'embed', 'eval', 'voice'] as const;

  function backend(error: RetrievalBackendError | null): { backend: RetrievalBackend; calls: () => number } {
    let count = 0;
    return {
      backend: {
        id: 'pgvector',
        async search() {
          count += 1;
          if (error) throw error;
          return { dense: [hit('chunk-1', { similarity: 0.9, documentId: 'doc-1' })], lexical: [] } satisfies BackendLegs;
        },
        health: async () => ({ ok: true }),
        isReady: async () => true,
      },
      calls: () => count,
    };
  }

  function install(options: { pipeline?: string; error?: RetrievalBackendError | null; languages?: boolean | null }) {
    resetActiveChunkingProfilesForTests();
    const { embedder } = fakeEmbedder();
    const rpc = fakeRpcClient({ rows: rows(3) });
    installDeps({
      embedder,
      adminClient: adminWithRpc(rpc.client, fakeAssemblyAdmin()),
      ragEnv: () => ({ RAG_PIPELINE: options.pipeline, RAG_LEXICAL_SEARCH: 'false', RAG_RERANKER: 'none' }),
      ...(options.languages !== undefined ? { languagesConfigured: () => options.languages ?? null } : {}),
    });
    const fake = backend(options.error ?? null);
    setRetrievalBackendForTests(fake.backend);
    return { rpcCalls: rpc.calls, backendCalls: fake.calls };
  }

  const run = (profile: (typeof PROFILES)[number] = 'chat') =>
    runRetrieval({ scope, query: SEMANTIC_QUERY, profile, signal: new AbortController().signal });

  const LEGACY_SEARCH_RPCS = ['match_document_chunks', 'match_documents_by_workspace', 'match_chunks_by_profile'];
  const legacySearchCalls = (calls: { fn: string }[]) => calls.filter((call) => LEGACY_SEARCH_RPCS.includes(call.fn)).length;
  const fallbackOf = (result: { stages: { name: string; detail?: string }[] }) =>
    result.stages.filter((stage) => stage.name === 'pipeline_fallback').map((stage) => stage.detail);
  const comparable = (result: Awaited<ReturnType<typeof run>>) => ({
    status: result.status,
    reason: result.reason,
    candidates: result.candidates,
    context: result.context,
    usedDocuments: result.usedDocuments,
  });

  beforeEach(() => {
    resetAll();
    resetRetrievalBackendForTests();
    resetV2StartupForTests();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    uninstallDeps();
    resetAll();
    resetRetrievalBackendForTests();
    resetV2StartupForTests();
    vi.restoreAllMocks();
  });

  async function legacyBaseline(profile: (typeof PROFILES)[number] = 'chat') {
    install({ pipeline: 'legacy' });
    const result = await run(profile);
    uninstallDeps();
    resetRetrievalBackendForTests();
    return result;
  }

  it('default v2 with a missing hybrid_search_chunks re-runs on legacy and stays there', async () => {
    const baseline = await legacyBaseline();
    expect(baseline.status).toBe('ok');

    setDefaultPipelineForTests('v2');
    const fake = install({ error: new RetrievalBackendError('hybrid_search_chunks', 'PGRST202') });
    const first = await run();
    expect(comparable(first)).toEqual(comparable(baseline));
    expect(fallbackOf(first)).toEqual(['v2_unavailable']);
    expect(fake.backendCalls()).toBe(1);
    expect(isV2Available()).toBe(false);
    expect(isV2Pipeline()).toBe(false);

    const second = await run();
    expect(comparable(second)).toEqual(comparable(baseline));
    expect(fallbackOf(second)).toEqual(['v2_unavailable']);
    expect(fake.backendCalls()).toBe(1);
  });

  it('a missing function with code 42883 falls back too', async () => {
    setDefaultPipelineForTests('v2');
    install({ error: new RetrievalBackendError('hybrid_search_chunks', '42883') });
    const result = await run('eval');
    expect(result.status).toBe('ok');
    expect(fallbackOf(result)).toEqual(['v2_unavailable']);
  });

  it('the fallback log names the function and no query text', async () => {
    setDefaultPipelineForTests('v2');
    install({ error: new RetrievalBackendError('hybrid_search_chunks', 'PGRST202') });
    const error = vi.mocked(console.error);
    await run();
    await run();
    const lines = error.mock.calls.filter((call) => String(call[0]).startsWith('[RAG Config]'));
    expect(lines).toHaveLength(1);
    expect(JSON.stringify(lines)).not.toContain(SEMANTIC_QUERY);
  });

  it('explicit v2 with the same error keeps backend_error and never calls legacy', async () => {
    const fake = install({ pipeline: 'v2', error: new RetrievalBackendError('hybrid_search_chunks', 'PGRST202') });
    const result = await run();
    expect(result).toMatchObject({ status: 'error', reason: 'backend_error' });
    expect(fallbackOf(result)).toEqual([]);
    expect(legacySearchCalls(fake.rpcCalls)).toBe(0);
    expect(isV2Available()).toBe(true);
    expect(isV2Pipeline()).toBe(true);
  });

  it('default v2 with any other backend error never falls back', async () => {
    setDefaultPipelineForTests('v2');
    const fake = install({ error: new RetrievalBackendError('hybrid_search_chunks', '57014') });
    const result = await run();
    expect(result).toMatchObject({ status: 'error', reason: 'backend_error' });
    expect(fallbackOf(result)).toEqual([]);
    expect(legacySearchCalls(fake.rpcCalls)).toBe(0);
    expect(isV2Available()).toBe(true);
  });

  it('default v2 with languages not configured serves legacy on every profile without calling hybrid_search_chunks', async () => {
    for (const profile of PROFILES) {
      const baseline = await legacyBaseline(profile);
      setDefaultPipelineForTests('v2');
      const fake = install({ languages: false });
      const error = vi.mocked(console.error);
      const warn = vi.mocked(console.warn);
      error.mockClear();
      warn.mockClear();
      const result = await run(profile);
      expect(comparable(result), profile).toEqual(comparable(baseline));
      expect(fallbackOf(result), profile).toEqual(['languages_not_configured']);
      expect(fake.backendCalls(), profile).toBe(0);
      expect([...error.mock.calls, ...warn.mock.calls].filter((call) => String(call[0]).startsWith('[RAG Config]')), profile).toEqual([]);
      expect(isV2Pipeline()).toBe(false);
      uninstallDeps();
      resetRetrievalBackendForTests();
      setDefaultPipelineForTests(null);
    }
  });

  it('default v2 with languages configured or no reader runs v2', async () => {
    for (const languages of [true, null]) {
      setDefaultPipelineForTests('v2');
      const fake = install({ languages });
      const result = await run();
      expect(fake.backendCalls()).toBe(1);
      expect(fallbackOf(result)).toEqual([]);
      expect(isV2Pipeline()).toBe(true);
      uninstallDeps();
      resetRetrievalBackendForTests();
    }
  });

  it('explicit v2 with languages not configured still dispatches to v2', async () => {
    const fake = install({ pipeline: 'v2', languages: false });
    await run();
    expect(fake.backendCalls()).toBe(1);
    expect(legacySearchCalls(fake.rpcCalls)).toBe(0);
  });

  it('legacy never calls hybrid_search_chunks', async () => {
    const fake = install({ pipeline: 'legacy' });
    for (const profile of PROFILES) await run(profile);
    expect(fake.backendCalls()).toBe(0);
  });

  it('verifyV2Startup is not_checked and silent when the resolver says legacy', async () => {
    setDefaultPipelineForTests('v2');
    install({ languages: false });
    const error = vi.mocked(console.error);
    const warn = vi.mocked(console.warn);
    error.mockClear();
    warn.mockClear();
    const verdict = await verifyV2Startup({ adminClient: () => null });
    expect(verdict.status).toBe('not_checked');
    expect([...error.mock.calls, ...warn.mock.calls]).toEqual([]);

    resetV2StartupForTests();
    uninstallDeps();
    install({ pipeline: 'v2' });
    expect((await verifyV2Startup({ adminClient: () => null })).status).not.toBe('not_checked');
  });
});
