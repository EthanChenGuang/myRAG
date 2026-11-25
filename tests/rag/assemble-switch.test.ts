import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const voiceModule = vi.hoisted(() => ({ assembleCalls: 0, assembleThrows: false, enrichThrows: false }));

vi.mock('@/lib/rag/context/voice', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rag/context/voice')>();
  return {
    ...actual,
    assembleVoiceResults: (input: Parameters<typeof actual.assembleVoiceResults>[0]) => {
      voiceModule.assembleCalls += 1;
      if (voiceModule.assembleThrows) throw new Error('assemble boom');
      return actual.assembleVoiceResults(input);
    },
    enrichVoiceCandidates: (chunks: Parameters<typeof actual.enrichVoiceCandidates>[0]) => {
      if (voiceModule.enrichThrows) throw new Error('enrich boom');
      return actual.enrichVoiceCandidates(chunks);
    },
  };
});

import { runRetrieval } from '@/lib/rag';
import { mintScope } from '@/lib/rag/tenant/scope';
import type { RagEnvInput } from '@/lib/rag/config';
import { SEMANTIC_QUERY, adminWithRpc, fakeAssemblyAdmin, fakeEmbedder, fakeRpcClient, installDeps, rows, uninstallDeps } from './helpers/pipeline-fakes';

const scope = mintScope('single', null, null);

function installVoice(env: RagEnvInput) {
  const rpc = fakeRpcClient({ rows: rows(3) });
  installDeps({
    embedder: fakeEmbedder().embedder,
    ragEnv: () => ({ RAG_DISABLED_STAGES: 'voice_keyword_fallback', ...env }),
    adminClient: adminWithRpc(rpc.client, fakeAssemblyAdmin()),
  });
}

function runVoice() {
  return runRetrieval({ scope, query: SEMANTIC_QUERY, profile: 'voice', signal: new AbortController().signal });
}

beforeEach(() => {
  uninstallDeps();
  voiceModule.assembleCalls = 0;
  voiceModule.assembleThrows = false;
  voiceModule.enrichThrows = false;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  uninstallDeps();
});

describe('assemble switch semantics in the voice pipeline', () => {
  test('an enabled assemble returns results as before', async () => {
    installVoice({});
    const result = await runVoice();
    expect(result.status).toBe('ok');
    expect(result.voice?.results.length).toBeGreaterThan(0);
  });

  test('a disabled assemble is degraded with no results and never runs the assembly outside the stage runner', async () => {
    installVoice({ RAG_DISABLED_STAGES: 'voice_keyword_fallback,assemble' });
    const result = await runVoice();
    expect(result.status).toBe('degraded');
    expect(result.reason).toBe('assemble_disabled');
    expect(result.voice?.results).toEqual([]);
    expect(voiceModule.assembleCalls).toBe(0);
  });

  test('an assemble that throws is a skipped stage, not a second throw out of runRetrieval', async () => {
    voiceModule.assembleThrows = true;
    installVoice({});
    const result = await runVoice();
    expect(result.status).toBe('degraded');
    expect(result.reason).toBe('assemble_failed');
    expect(result.voice?.results).toEqual([]);
    expect(voiceModule.assembleCalls).toBe(1);
  });

  test('an unexpected throw outside a stage becomes the error status instead of escaping runRetrieval', async () => {
    voiceModule.enrichThrows = true;
    installVoice({ RAG_DISABLED_STAGES: 'voice_keyword_fallback,local_rerank' });
    const result = await runVoice();
    expect(result.status).toBe('error');
    expect(result.reason).toBe('voice_pipeline_failed');
    expect(result.voice).toBeUndefined();
  });
});
