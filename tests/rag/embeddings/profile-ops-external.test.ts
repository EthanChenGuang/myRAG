import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetRagDepsForTests, setRagDepsForTests } from '@/lib/rag/deps';
import { ProfileUnavailableError, resetActiveProfileForTests } from '@/lib/rag/embeddings/active-profile';
import { activateEmbeddingProfile } from '@/lib/rag/embeddings/profile-ops';
import { resetIngestDepsForTests, setIngestDepsForTests } from '@/lib/rag/ingest/deps';
import type { RpcClient, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import type { SupabaseClient } from '@supabase/supabase-js';

function install(response: RpcResponse): void {
  const client: RpcClient = {
    rpc() {
      const request = {
        abortSignal: () => request,
        then: (onFulfilled: (value: RpcResponse) => unknown, onRejected?: (reason: unknown) => unknown) =>
          Promise.resolve(response).then(onFulfilled, onRejected),
      };
      return request as ReturnType<RpcClient['rpc']>;
    },
  };
  setRagDepsForTests({ adminClient: () => client as unknown as SupabaseClient, now: () => 1_000_000 });
}

beforeEach(() => {
  setIngestDepsForTests({ ingestEnv: () => ({ RAG_EMBEDDING_PROFILES: 'on' }) });
});

afterEach(() => {
  resetRagDepsForTests();
  resetIngestDepsForTests();
  resetActiveProfileForTests();
});

describe('profile-ops maps the external readiness refusal', () => {
  it.each(['weaviate', 'qdrant'] as const)('external_not_ready:%s becomes a named refusal that keeps the backend', async (backend) => {
    const message = `external_not_ready:${backend} (1 tenants with current documents have no ready ${backend} index for profile voyage-4-large-1024)`;
    install({ data: null, error: { message, code: '55000' } });
    expect(await activateEmbeddingProfile('voyage-4-large-1024', 'operator-1')).toEqual({
      ok: false,
      reason: `external_not_ready:${backend}`,
      code: 'external_not_ready',
      backend,
      detail: message,
    });
  });

  it('a Phase 3 refusal keeps its existing shape, with no code or backend', async () => {
    const message = 'activation_refused: incomplete (3 current ready chunks have no vector for profile voyage-4-large-1024)';
    install({ data: null, error: { message, code: '55000' } });
    expect(await activateEmbeddingProfile('voyage-4-large-1024', 'operator-1')).toEqual({ ok: false, reason: 'activation_refused: incomplete', detail: message });
  });

  it('an unknown backend name is not a named refusal', async () => {
    install({ data: null, error: { message: 'external_not_ready:other', code: '55000' } });
    await expect(activateEmbeddingProfile('voyage-4-large-1024', 'operator-1')).rejects.toBeInstanceOf(ProfileUnavailableError);
  });
});
