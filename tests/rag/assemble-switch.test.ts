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
import { mintScope, scopeKey } from '@/lib/rag/tenant/scope';
import { loadRagConfig, resetRagConfigForTests, type RagEnvInput } from '@/lib/rag/config';
import type { FusedHit } from '@/lib/rag/fusion/rrf';
import { createTraceCollector } from '@/lib/rag/trace/collector';
import { effectiveRetrievalParams } from '@/lib/rag/v2/retrieval-params';
import { runContextStages } from '@/lib/rag/v2/stages/context';
import { hit } from './fusion/helpers';
import { resetVersionColumnsWarningForTests } from '@/lib/rag/context/fetch-rows';
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

interface DocumentRead {
  select: string;
  eq: Array<[string, string]>;
}

function versionAdmin(versionColumns: boolean, failVersionRead = false) {
  const reads: DocumentRead[] = [];
  const client = {
    from(table: string) {
      const read: DocumentRead = { select: '', eq: [] };
      let ids: string[] = [];
      const builder = {
        select(select: string) {
          read.select = select;
          return builder;
        },
        eq(column: string, value: string) {
          read.eq.push([column, value]);
          return builder;
        },
        in(_column: string, values: string[]) {
          ids = values;
          return builder;
        },
        abortSignal() {
          return builder;
        },
        then(onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
          if (table === 'documents') reads.push(read);
          if (failVersionRead && table === 'documents' && read.select.includes('version_label')) {
            return Promise.resolve({ data: null, error: { code: '42703', message: 'column documents.version_label does not exist' } }).then(
              onFulfilled,
              onRejected,
            );
          }
          const data =
            table === 'documents'
              ? ids.map((id, index) => ({
                  id,
                  filename: `${id}.md`,
                  created_at: null,
                  content: null,
                  metadata: null,
                  ...(versionColumns && read.select.includes('version_label')
                    ? { version: index + 1, doc_type: 'general', doc_date: null, effective_from: '2026-03-01', version_label: null }
                    : {}),
                }))
              : ids.map((id) => ({ id, metadata: null }));
          return Promise.resolve({ data, error: null }).then(onFulfilled, onRejected);
        },
      };
      return builder;
    },
  };
  return { admin: () => client as never, reads };
}

describe('RAG_VERSION_LABELS on the chat pipelines (D-48 to D-50)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('legacy: off reads the base columns and keeps the titles; on labels every block from the same batched read', async () => {
    for (const on of [false, true]) {
      uninstallDeps();
      if (on) vi.stubEnv('RAG_VERSION_LABELS', 'true');
      const rpc = fakeRpcClient({ rows: rows(2) });
      const fake = versionAdmin(true);
      installDeps({ embedder: fakeEmbedder().embedder, adminClient: adminWithRpc(rpc.client, fake.admin) });
      const result = await runRetrieval({ scope, query: SEMANTIC_QUERY, profile: 'chat', signal: new AbortController().signal });
      expect(fake.reads).toHaveLength(1);
      expect(fake.reads[0]!.select.includes('version_label')).toBe(on);
      const titles = (result.blocks ?? []).map((block) => block.title);
      expect(titles.length).toBeGreaterThan(0);
      for (const title of titles) expect(title.includes(' · Version ')).toBe(on);
      if (on) expect(result.blocks![0]).toMatchObject({ versionLabel: 'Version 1', effectiveFrom: '2026-03-01', documentVersion: 1 });
      else expect(result.blocks![0]).not.toHaveProperty('versionLabel');
    }
  });
});

describe('RAG_VERSION_LABELS on the v2 context stages (D-49)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function runV2() {
    resetRagConfigForTests();
    const cfg = loadRagConfig({ RAG_PIPELINE: 'v2' });
    const fused: FusedHit[] = ['doc-1', 'doc-2'].map((documentId, index) => ({
      hit: hit(`v2-chunk-${index + 1}`, {
        rank: index + 1,
        documentId,
        chunkIndex: 0,
        content: `synthetic widget passage ${index + 1}`,
        similarity: 0.9 - index * 0.05,
        document: { filename: `${documentId}.md`, createdAt: null, metadata: {}, contentPreview: '' },
      }),
      score: 1 / (61 + index),
      ranks: { 'dense:0': index + 1 },
    }));
    const signal = new AbortController().signal;
    return runContextStages({
      input: { scope, query: 'synthetic widget passage', profile: 'chat', signal },
      config: cfg,
      profile: 'chat',
      params: { ...effectiveRetrievalParams('chat', cfg, null), final_top_k: 20 },
      fusedHits: fused,
      referenced: null,
      signal,
      collector: createTraceCollector({ profile: 'chat', tenantKey: scopeKey(scope) }),
    });
  }

  test('off makes no document read; on reads the version columns once under the tenant key and labels the blocks', async () => {
    for (const on of [false, true]) {
      uninstallDeps();
      if (on) vi.stubEnv('RAG_VERSION_LABELS', 'true');
      const fake = versionAdmin(true);
      installDeps({ embedder: fakeEmbedder().embedder, adminClient: fake.admin });
      const output = await runV2();
      const titles = (output.assembly?.blocks ?? []).map((block) => block.title);
      expect(titles).toHaveLength(2);
      if (!on) {
        expect(fake.reads).toHaveLength(0);
        expect(titles).toEqual(['doc-1.md', 'doc-2.md']);
        continue;
      }
      expect(fake.reads).toHaveLength(1);
      expect(fake.reads[0]!.select).toBe('id, version, doc_type, doc_date, effective_from, version_label');
      expect(fake.reads[0]!.eq).toEqual([['tenant_key', scopeKey(scope)]]);
      expect(titles).toEqual(['doc-1.md · Version 1 · Effective from 2026-03-01', 'doc-2.md · Version 2 · Effective from 2026-03-01']);
    }
  });

  test('on: a version read that fails on a missing column leaves the v2 titles unchanged instead of failing assembly', async () => {
    vi.stubEnv('RAG_VERSION_LABELS', 'true');
    uninstallDeps();
    resetVersionColumnsWarningForTests();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fake = versionAdmin(true, true);
    installDeps({ embedder: fakeEmbedder().embedder, adminClient: fake.admin });
    const output = await runV2();
    expect(fake.reads).toHaveLength(1);
    expect(warn.mock.calls.some((call) => String(call[0]).startsWith('[Answer Rules]'))).toBe(true);
    expect((output.assembly?.blocks ?? []).map((block) => block.title)).toEqual(['doc-1.md', 'doc-2.md']);
  });
});
