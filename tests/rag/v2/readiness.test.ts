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
    expect(unset.RAG_PIPELINE_SOURCE).toBe('default');
    expect(loadRagConfig({ ...unset, RAG_PIPELINE: 'legacy' })).toMatchObject({ pipeline: 'v2', pipelineSource: 'default' });

    setRagDepsForTests({ rawPipelineEnv: () => ({ RAG_PIPELINE: 'legacy', RAG_INGEST_PIPELINE: undefined }) });
    expect(getRagDeps().ragEnv().RAG_PIPELINE_SOURCE).toBe('explicit');
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
