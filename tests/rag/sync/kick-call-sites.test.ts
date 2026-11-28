import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { RpcClient, RpcResponse } from '@/lib/rag/backend/supabase-rpc';

const kickMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/rag/sync/kick', () => ({ kickVectorSync: kickMock }));

import { resetRagDepsForTests, setRagDepsForTests } from '@/lib/rag/deps';
import { resetActiveProfileForTests } from '@/lib/rag/embeddings/active-profile';
import { activateEmbeddingProfile } from '@/lib/rag/embeddings/profile-ops';
import { resetIngestDepsForTests, setIngestDepsForTests } from '@/lib/rag/ingest/deps';
import { purgeLineage, resetPurgeDepsForTests, setPurgeDepsForTests } from '@/lib/rag/ingest/purge';
import { softDeleteLineage } from '@/lib/rag/ingest/soft-delete';
import { createIngestWriter } from '@/lib/rag/ingest/writer';
import { mintScope } from '@/lib/rag/tenant/scope';

const USER = '0f0e0d0c-0b0a-4908-8706-050403020100';
const DOC = '11111111-2222-4333-8444-555555555555';
const LINEAGE = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const AUDIT = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';

function client(responder: (fn: string) => RpcResponse): RpcClient {
  return {
    rpc(fn: string) {
      const request = {
        abortSignal: () => request,
        then: (onFulfilled: (value: RpcResponse) => unknown, onRejected?: (reason: unknown) => unknown) =>
          Promise.resolve(responder(fn)).then(onFulfilled, onRejected),
      };
      return request as ReturnType<RpcClient['rpc']>;
    },
  };
}

beforeEach(() => {
  kickMock.mockReset();
  setIngestDepsForTests({ ingestEnv: () => ({ RAG_EMBEDDING_PROFILES: 'on' }) });
});

afterEach(() => {
  resetRagDepsForTests();
  resetIngestDepsForTests();
  resetActiveProfileForTests();
  resetPurgeDepsForTests();
  vi.restoreAllMocks();
});

describe('kickVectorSync call sites', () => {
  const scope = mintScope('personal', USER, null);

  test('a successful publish kicks exactly once', async () => {
    const db = client(() => ({ data: [{ outcome: 'published', document_id: DOC, version: 1, superseded_document_id: null }], error: null }));
    const writer = createIngestWriter({ db, scope, signal: new AbortController().signal });
    await writer.publish(DOC);
    expect(kickMock).toHaveBeenCalledTimes(1);
  });

  test('a failed publish kicks zero times', async () => {
    const failing = client(() => ({ data: null, error: { message: 'ingest_refused: tenant_mismatch', code: '22023' } }));
    await expect(createIngestWriter({ db: failing, scope, signal: new AbortController().signal }).publish(DOC)).rejects.toThrow();
    const malformed = client(() => ({ data: [{ outcome: 'bogus', document_id: DOC }], error: null }));
    await expect(createIngestWriter({ db: malformed, scope, signal: new AbortController().signal }).publish(DOC)).rejects.toThrow();
    expect(kickMock).not.toHaveBeenCalled();
  });

  test('a soft delete kicks exactly once; a refused one kicks zero times', async () => {
    const ok = client(() => ({ data: [{ outcome: 'deleted', lineage_id: LINEAGE, job_id: null }], error: null }));
    const result = await softDeleteLineage(scope, LINEAGE, 'config_upload', { signal: new AbortController().signal, deps: { db: () => ok } });
    expect(result.ok).toBe(true);
    expect(kickMock).toHaveBeenCalledTimes(1);
    kickMock.mockReset();
    const refused = client(() => ({ data: null, error: { message: 'tenant_mismatch', code: '22023' } }));
    const failed = await softDeleteLineage(scope, LINEAGE, 'config_upload', { signal: new AbortController().signal, deps: { db: () => refused } });
    expect(failed.ok).toBe(false);
    expect(kickMock).not.toHaveBeenCalled();
  });

  test('a successful activation kicks exactly once; a refused one kicks zero times', async () => {
    const install = (response: RpcResponse) =>
      setRagDepsForTests({ adminClient: () => client(() => response) as unknown as SupabaseClient, now: () => 1_000_000 });
    install({ data: null, error: { message: 'activation_refused: incomplete (3)', code: '55000' } });
    expect((await activateEmbeddingProfile('voyage-4-large-1024', 'operator-1')).ok).toBe(false);
    expect(kickMock).not.toHaveBeenCalled();
    install({ data: [{ activated_profile: 'voyage-4-large-1024', previous_profile: 'openai-3-small-1536' }], error: null });
    const result = await activateEmbeddingProfile('voyage-4-large-1024', 'operator-1');
    expect(result.ok).toBe(true);
    expect(kickMock).toHaveBeenCalledTimes(1);
  });
  test('a committed purge kicks exactly once; a refused one kicks zero times', async () => {
    for (const method of ['log', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
    const reason = { code: 'source_deleted' as const, note: null };
    const actor = { kind: 'source_sync' as const, id: USER };
    const install = (responder: (fn: string) => RpcResponse) =>
      setPurgeDepsForTests({
        db: () => client(responder),
        lineageDocuments: async () => [],
        cacheTarget: () => null,
        scopeOf: async () => scope,
      });
    install((fn) =>
      fn === 'rag_purge_lineage'
        ? { data: [{ audit_id: AUDIT, counts: {}, object_keys: [], parse_cache_prefixes: [], image_prefixes: [] }], error: null }
        : { data: [], error: null },
    );
    const result = await purgeLineage(scope, LINEAGE, actor, reason, { signal: new AbortController().signal });
    expect(result.ok).toBe(true);
    expect(kickMock).toHaveBeenCalledTimes(1);
    kickMock.mockReset();
    install(() => ({ data: null, error: { message: 'tenant_mismatch', code: '22023' } }));
    const refused = await purgeLineage(scope, LINEAGE, actor, reason, { signal: new AbortController().signal });
    expect(refused.ok).toBe(false);
    expect(kickMock).not.toHaveBeenCalled();
  });
});
