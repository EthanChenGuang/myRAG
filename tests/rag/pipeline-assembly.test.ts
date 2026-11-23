import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { runRetrieval } from '@/lib/rag';
import { mintScope } from '@/lib/rag/tenant/scope';
import type { Profile, RunRetrievalInput } from '@/lib/rag/types';
import type { RagEnvInput } from '@/lib/rag/config';
import {
  SEMANTIC_QUERY,
  fakeAssemblyAdmin,
  fakeEmbedder,
  fakeRpcClient,
  installDeps,
  rows,
  uninstallDeps,
  type FakeRow,
} from './helpers/pipeline-fakes';

const scope = mintScope('single', null, null);

function install(options: { rows?: FakeRow[]; env?: RagEnvInput; adminClient?: () => never | null } = {}) {
  const rpc = fakeRpcClient({ rows: options.rows ?? rows(3) });
  installDeps({
    searchRpc: rpc.client,
    embedder: fakeEmbedder().embedder,
    ragEnv: () => options.env ?? {},
    ...(options.adminClient ? { adminClient: options.adminClient as never } : {}),
  });
}

function installVoice() {
  const rpc = fakeRpcClient({ rows: rows(3) });
  const assemblyAdmin = fakeAssemblyAdmin()() as unknown as { from: unknown };
  installDeps({
    embedder: fakeEmbedder().embedder,
    ragEnv: () => ({ RAG_DISABLED_STAGES: 'voice_keyword_fallback' }),
    adminClient: (() => ({ rpc: rpc.client.rpc.bind(rpc.client), from: assemblyAdmin.from })) as never,
  });
}

function run(profile: Profile = 'eval', extra: Partial<RunRetrievalInput> = {}) {
  return runRetrieval({ scope, query: SEMANTIC_QUERY, profile, signal: new AbortController().signal, ...extra });
}

beforeEach(() => {
  uninstallDeps();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  uninstallDeps();
});

describe('post_filter and assemble stages', () => {
  test.each<Profile>(['chat', 'embed', 'eval'])('profile %s returns context, used documents and kept chunks', async (profile) => {
    install();
    const result = await run(profile);
    expect(result.status).toBe('ok');
    expect(result.stages.map((stage) => stage.name)).toEqual(['analyze', 'embed', 'search', 'legacy_rank', 'post_filter', 'assemble']);
    expect(result.context).toContain('=== RELEVANT INFORMATION FROM DOCUMENTS ===');
    expect(result.context).toContain('fixture chunk body 1');
    expect(result.usedDocuments.map((doc) => doc.id)).toEqual(['doc-1', 'doc-2', 'doc-3']);
    expect(result.kept.map((chunk) => chunk.chunk_id)).toEqual(['chunk-1', 'chunk-2', 'chunk-3']);
    expect(result.relevantChunks).toHaveLength(3);
    expect(result.sourceImages).toEqual([]);
    expect(result.links).toEqual([]);
    expect(result.refusalCandidate).toBe(false);
    expect(result.queryTerms).toEqual(['tell', 'about', 'onboarding', 'process']);
    expect(result.stages.find((stage) => stage.name === 'post_filter')).toMatchObject({ candidates_in: 3, candidates_out: 3 });
    expect(result.stages.find((stage) => stage.name === 'assemble')).toMatchObject({ candidates_in: 3, candidates_out: 3 });
  });

  test('the voice profile runs its own stages and returns the voice payload instead of assembled context', async () => {
    installVoice();
    const result = await run('voice');
    expect(result.stages.map((stage) => stage.name)).toEqual(['embed', 'search', 'voice_keyword_fallback', 'local_rerank', 'assemble']);
    expect(result.status).toBe('ok');
    expect(result.context).toBe('');
    expect(result.candidates).toHaveLength(0);
    expect(result.voice?.results).toHaveLength(3);
  });

  test('the voice profile ignores request stage overrides', async () => {
    installVoice();
    const result = await run('voice', { stageOverrides: { disabledStages: ['local_rerank'] } });
    expect(result.stages.find((stage) => stage.name === 'local_rerank')).toMatchObject({ status: 'ok' });
  });

  test('zero survivors of the relevance filter is empty with reason no_relevant_context and a refusal candidate', async () => {
    install({ rows: rows(2).map((row) => ({ ...row, similarity: 0.3 })) });
    const result = await run('chat');
    expect(result.status).toBe('empty');
    expect(result.reason).toBe('no_relevant_context');
    expect(result.candidates).toHaveLength(2);
    expect(result.context).toBe('No relevant context found.');
    expect(result.refusalCandidate).toBe(true);
  });

  test('a disabled post_filter keeps every candidate whose document row exists', async () => {
    install({ rows: rows(2).map((row) => ({ ...row, similarity: 0.3 })), env: { RAG_DISABLED_STAGES: 'post_filter' } });
    const result = await run('chat');
    expect(result.status).toBe('ok');
    expect(result.stages.find((stage) => stage.name === 'post_filter')).toMatchObject({ status: 'disabled' });
    expect(result.stages.find((stage) => stage.name === 'assemble')).toMatchObject({ status: 'ok' });
    expect(result.usedDocuments.map((doc) => doc.id)).toEqual(['doc-1', 'doc-2']);
    expect(result.context).toContain('fixture chunk body 2');
  });

  test('a disabled assemble leaves candidates and an empty context, and is not degraded', async () => {
    install({ env: { RAG_DISABLED_STAGES: 'assemble' } });
    const result = await run('chat');
    expect(result.status).toBe('ok');
    expect(result.candidates).toHaveLength(3);
    expect(result.context).toBe('');
    expect(result.stages.find((stage) => stage.name === 'assemble')).toMatchObject({ status: 'disabled' });
  });

  test('a failing row lookup degrades the run but keeps the candidates', async () => {
    install({
      adminClient: (() => ({
        from: () => {
          throw new Error('rows unavailable');
        },
      })) as never,
    });
    const result = await run('chat');
    expect(result.status).toBe('degraded');
    expect(result.reason).toBe('post_filter_failed');
    expect(result.candidates).toHaveLength(3);
    expect(result.context).toBe('');
    expect(result.stages.filter((stage) => stage.status === 'skipped').map((stage) => stage.name)).toEqual(['post_filter', 'assemble']);
  });

  test('isGPTModel and ragMode reach the assembly', async () => {
    install({
      rows: rows(1).map((row) => ({ ...row, content: 'Document: doc-1.md. Chunk 1 of 2. Content: the body' })),
    });
    const gpt = await run('chat', { options: { isGPTModel: true } });
    expect(gpt.context).toContain('[Source: doc-1.md]\nthe body');

    install({ rows: rows(1).map((row) => ({ ...row, similarity: 0.1 })) });
    const balanced = await run('chat', { options: { ragMode: 'balanced' } });
    expect(balanced.refusalCandidate).toBe(false);
    const strictDefault = await run('chat');
    expect(strictDefault.refusalCandidate).toBe(true);
  });

  test('a caller-supplied trace is not finished by runRetrieval', async () => {
    install();
    const logSpy = vi.spyOn(console, 'log');
    const { createTraceCollector } = await import('@/lib/rag/trace/collector');
    const trace = createTraceCollector({ profile: 'chat', tenantKey: 's:default' });
    await run('chat', { trace });
    const traceLines = logSpy.mock.calls.filter((call) => call.map(String).join(' ').includes('[RAG Trace]'));
    expect(traceLines).toHaveLength(0);
    expect(trace.stages().map((stage) => stage.name)).toContain('assemble');
  });
});
