import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { register } from '@/instrumentation';
import { env } from '@/lib/env';
import type { RpcClient, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { resetRagDepsForTests, setRagDepsForTests } from '@/lib/rag/deps';
import { getStartupVerdict, resetActiveProfileForTests } from '@/lib/rag/embeddings/active-profile';
import { resetEmbeddingProvidersForTests, setEmbeddingProvidersForTests } from '@/lib/rag/embeddings/registry';
import type { EmbeddingProvider } from '@/lib/rag/embeddings/types';
import { resetIngestDepsForTests, setIngestDepsForTests } from '@/lib/rag/ingest/deps';

const VOYAGE_KEY = 'test-voyage-key-placeholder-0123456789';
const DEEPINFRA_KEY = 'test-deepinfra-key-placeholder-0123';
const OPENAI_KEY = 'test-openai-key-placeholder-0123';

const mutableEnv = env as unknown as Record<string, unknown>;
const KEY_NAMES = ['VOYAGE_API_KEY', 'DEEPINFRA_API_KEY', 'OPENAI_API_KEY'] as const;
const savedKeys: Record<string, unknown> = {};
const savedRuntime = process.env.NEXT_RUNTIME;

let mode: string | undefined;
let rpcCalls: string[];
let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

function row(id: string, status: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    provider: 'voyage',
    model: 'voyage-4-large',
    dims: 1024,
    storage: 'halfvec',
    status,
    query_instruction: null,
    score_calibration: {},
    activated_at: null,
    activated_by: null,
    previous_active_id: null,
    has_evidence: false,
    created_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

function installRegistry(respond: () => Promise<RpcResponse> | RpcResponse): void {
  const client: RpcClient = {
    rpc(fn) {
      rpcCalls.push(fn);
      const request = {
        abortSignal: () => request,
        then: (onFulfilled: (value: RpcResponse) => unknown, onRejected?: (reason: unknown) => unknown) => {
          try {
            return Promise.resolve(respond()).then(onFulfilled, onRejected);
          } catch (error) {
            return Promise.reject(error).then(onFulfilled, onRejected);
          }
        },
      };
      return request as ReturnType<RpcClient['rpc']>;
    },
  };
  setRagDepsForTests({ adminClient: () => client as unknown as SupabaseClient });
}

function loggedText(): string {
  return [...errorSpy.mock.calls, ...warnSpy.mock.calls].map((call) => call.map((arg) => String(arg)).join(' ')).join('\n');
}

function fakeProvider(over: Partial<EmbeddingProvider>): EmbeddingProvider {
  return {
    id: 'voyage',
    model: 'voyage-4-large',
    maxInputTokens: 32_000,
    supportedDims: [256, 512, 1024, 2048],
    normalize: true,
    embedDocuments: async () => {
      throw new Error('not used');
    },
    embedQuery: async () => {
      throw new Error('not used');
    },
    ...over,
  };
}

beforeEach(() => {
  mode = 'on';
  rpcCalls = [];
  process.env.NEXT_RUNTIME = 'nodejs';
  for (const name of KEY_NAMES) savedKeys[name] = mutableEnv[name];
  mutableEnv.VOYAGE_API_KEY = VOYAGE_KEY;
  mutableEnv.DEEPINFRA_API_KEY = DEEPINFRA_KEY;
  mutableEnv.OPENAI_API_KEY = OPENAI_KEY;
  setIngestDepsForTests({ ingestEnv: () => ({ RAG_EMBEDDING_PROFILES: mode }) });
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const name of KEY_NAMES) mutableEnv[name] = savedKeys[name];
  if (savedRuntime === undefined) delete process.env.NEXT_RUNTIME;
  else process.env.NEXT_RUNTIME = savedRuntime;
  resetRagDepsForTests();
  resetIngestDepsForTests();
  resetEmbeddingProvidersForTests();
  resetActiveProfileForTests();
});

describe('register (startup embedding profile check)', () => {
  it('does nothing outside the nodejs runtime', async () => {
    process.env.NEXT_RUNTIME = 'edge';
    installRegistry(() => ({ data: [row('voyage-4-large-1024', 'active')], error: null }));
    await register();
    expect(rpcCalls).toEqual([]);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(getStartupVerdict()).toMatchObject({ status: 'unknown', reason: 'not_checked' });
  });

  it('with the switch off reads nothing, logs nothing and records a skipped verdict', async () => {
    mode = 'off';
    installRegistry(() => ({ data: [row('voyage-4-large-1024', 'active')], error: null }));
    await register();
    expect(rpcCalls).toEqual([]);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(getStartupVerdict().status).toBe('skipped');
  });

  it('logs one MISMATCH error line when the active voyage profile has no key, and stores the verdict', async () => {
    mutableEnv.VOYAGE_API_KEY = '';
    installRegistry(() => ({ data: [row('voyage-4-large-1024', 'active')], error: null }));
    await register();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const args = errorSpy.mock.calls[0];
    expect(args).toHaveLength(1);
    const line = String(args[0]);
    expect(line.startsWith('[Embedding Profile] MISMATCH ')).toBe(true);
    expect(JSON.parse(line.slice('[Embedding Profile] MISMATCH '.length))).toEqual({
      profile: 'voyage-4-large-1024',
      model: 'voyage-4-large',
      dims: 1024,
      reason: 'provider_unconfigured',
    });
    expect(warnSpy).not.toHaveBeenCalled();
    for (const secret of [VOYAGE_KEY, DEEPINFRA_KEY, OPENAI_KEY]) expect(loggedText()).not.toContain(secret);

    const verdict = getStartupVerdict();
    expect(verdict).toMatchObject({
      status: 'mismatch',
      reason: 'provider_unconfigured',
      profile: 'voyage-4-large-1024',
      model: 'voyage-4-large',
      dims: 1024,
    });
    expect(typeof (verdict as { checkedAt: number }).checkedAt).toBe('number');
  });

  it('logs once per instance when register runs again', async () => {
    mutableEnv.VOYAGE_API_KEY = '';
    installRegistry(() => ({ data: [row('voyage-4-large-1024', 'active')], error: null }));
    await register();
    await register();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(rpcCalls).toHaveLength(1);
  });

  it('reports model_mismatch when the provider serves a different model than the profile', async () => {
    setEmbeddingProvidersForTests({ voyage: fakeProvider({ model: 'voyage-3-other' }) });
    installRegistry(() => ({ data: [row('voyage-4-large-1024', 'active')], error: null }));
    await register();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(errorSpy.mock.calls[0][0]).slice('[Embedding Profile] MISMATCH '.length))).toMatchObject({
      profile: 'voyage-4-large-1024',
      reason: 'model_mismatch',
    });
    expect(getStartupVerdict()).toMatchObject({ status: 'mismatch', reason: 'model_mismatch' });
    for (const secret of [VOYAGE_KEY, DEEPINFRA_KEY, OPENAI_KEY]) expect(loggedText()).not.toContain(secret);
  });

  it('reports dims_unsupported when the profile dims are not in the provider supported dims', async () => {
    installRegistry(() => ({ data: [row('voyage-4-large-3000', 'active', { dims: 3000 })], error: null }));
    await register();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(errorSpy.mock.calls[0][0]).slice('[Embedding Profile] MISMATCH '.length))).toMatchObject({
      profile: 'voyage-4-large-3000',
      dims: 3000,
      reason: 'dims_unsupported',
    });
    expect(getStartupVerdict()).toMatchObject({ status: 'mismatch', reason: 'dims_unsupported', dims: 3000 });
  });

  it('records ok and logs nothing for a consistent profile', async () => {
    installRegistry(() => ({
      data: [
        row('openai-3-small-1536', 'active', { provider: 'openai', model: env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small', dims: 1536, storage: 'legacy_column' }),
      ],
      error: null,
    }));
    await register();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(getStartupVerdict()).toMatchObject({ status: 'ok', profile: 'openai-3-small-1536', dims: 1536 });
  });

  it('resolves within 3 seconds when the database read hangs, warns once and leaves the verdict unknown', async () => {
    vi.useFakeTimers();
    installRegistry(() => new Promise<RpcResponse>(() => {}));
    const done = register();
    let settled = false;
    void done.then(() => {
      settled = true;
    });
    for (let i = 0; i < 20; i += 1) await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(3000);
    await done;

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0]).startsWith('[Embedding Profile] STARTUP CHECK TIMEOUT')).toBe(true);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(getStartupVerdict()).toMatchObject({ status: 'unknown', reason: 'timeout' });
  });

  it('never rejects, also when the registry read throws', async () => {
    installRegistry(() => {
      throw new Error('registry exploded');
    });
    await expect(register()).resolves.toBeUndefined();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(getStartupVerdict()).toMatchObject({ status: 'unknown', reason: 'profile_unavailable' });
    expect(loggedText()).not.toContain('registry exploded');
  });
});
