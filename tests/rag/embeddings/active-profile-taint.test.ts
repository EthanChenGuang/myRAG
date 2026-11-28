import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '@/lib/env';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { resetRagDepsForTests, setRagDepsForTests } from '@/lib/rag/deps';
import { resetActiveProfileForTests, verifyActiveEmbeddingProfileAtStartup } from '@/lib/rag/embeddings/active-profile';
import { resetEmbeddingProvidersForTests, setEmbeddingProvidersForTests } from '@/lib/rag/embeddings/registry';
import type { EmbeddingProvider } from '@/lib/rag/embeddings/types';
import { resetIngestDepsForTests, setIngestDepsForTests } from '@/lib/rag/ingest/deps';

const VERSION = 'ft-neutral-active-v1';
const mutableEnv = env as unknown as Record<string, unknown>;
const saved = { url: mutableEnv.RAG_FT_SLOT_A_BASE_URL };

type Row = Record<string, unknown>;

function profileRow(over: Row = {}): Row {
  return {
    id: 'ft-a-1024',
    provider: 'ft_slot_a',
    model: VERSION,
    dims: 1024,
    storage: 'halfvec',
    status: 'active',
    query_instruction: null,
    score_calibration: {},
    activated_at: null,
    activated_by: null,
    previous_active_id: 'openai-3-small-1536',
    has_evidence: true,
    created_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

function request(response: RpcResponse): RpcRequest {
  const pending: RpcRequest = {
    abortSignal: () => pending,
    then: (onFulfilled, onRejected) => Promise.resolve(response).then(onFulfilled, onRejected),
  };
  return pending;
}

let calls: string[];

function installRegistry(profiles: Row[], versions: Row[]): void {
  const client: RpcClient = {
    rpc: (fn) => {
      calls.push(fn);
      if (fn === 'rag_list_embedding_profiles') return request({ data: profiles, error: null });
      if (fn === 'rag_finetune_list_models') return request({ data: versions, error: null });
      return request({ data: [], error: null });
    },
  };
  setRagDepsForTests({ adminClient: () => client as never, now: () => 1_000_000 });
}

function slotProvider(): EmbeddingProvider {
  const never = () => Promise.reject(new Error('not called'));
  return {
    id: 'ft_slot_a',
    model: VERSION,
    maxInputTokens: 8192,
    supportedDims: [1024],
    normalize: true,
    embedDocuments: never,
    embedQuery: never,
    embedQueries: never,
  };
}

function taintWarnings(warn: { mock: { calls: unknown[][] } }): string[] {
  return warn.mock.calls.map((args: unknown[]) => String(args[0])).filter((line: string) => line.includes('TAINTED'));
}

beforeEach(() => {
  calls = [];
  mutableEnv.RAG_FT_SLOT_A_BASE_URL = 'http://ft.invalid/v1';
  setIngestDepsForTests({ ingestEnv: () => ({ RAG_EMBEDDING_PROFILES: 'on' }) });
  setEmbeddingProvidersForTests({ ft_slot_a: slotProvider(), [`ft_slot_a:${VERSION}`]: slotProvider() });
});

afterEach(() => {
  mutableEnv.RAG_FT_SLOT_A_BASE_URL = saved.url;
  resetRagDepsForTests();
  resetIngestDepsForTests();
  resetEmbeddingProvidersForTests();
  resetActiveProfileForTests();
  vi.restoreAllMocks();
});

describe('startup check of an active fine-tune slot (06.1 IW-3)', () => {
  it('warns once, with ids only, when the active slot serves a tainted version', async () => {
    installRegistry([profileRow()], [{ id: VERSION, status: 'tainted', bound_slot: 'ft-a-1024', tenant_keys: ['u:00000000-0000-0000-0000-00000000000a'] }]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const verdict = await verifyActiveEmbeddingProfileAtStartup();
    expect(verdict.status).toBe('ok');
    const lines = taintWarnings(warn);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[Embedding Profile]');
    expect(lines[0]).toContain(VERSION);
    expect(lines[0]).toContain('ft-a-1024');
    expect(lines[0]).not.toContain('u:00000000');
  });

  it('stays quiet when the active slot version is not tainted', async () => {
    installRegistry([profileRow()], [{ id: VERSION, status: 'active', bound_slot: 'ft-a-1024' }]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await verifyActiveEmbeddingProfileAtStartup();
    expect(taintWarnings(warn)).toEqual([]);
  });

  it('never reads the fine-tune registry when the active profile is not a slot', async () => {
    installRegistry(
      [profileRow({ id: 'openai-3-small-1536', provider: 'openai', model: 'text-embedding-3-small', dims: 1536, storage: 'legacy_column' })],
      [],
    );
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await verifyActiveEmbeddingProfileAtStartup();
    expect(calls).not.toContain('rag_finetune_list_models');
  });
});
