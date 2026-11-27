import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { RpcClient, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { resetRagConfigForTests } from '@/lib/rag/config';
import { resetRagDepsForTests, setRagDepsForTests } from '@/lib/rag/deps';
import { createCitationRecheck, recordSecurityEvent, visibleChunkIds, visibleDocumentIds } from '@/lib/rag/access/visibility';
import { mintAccessScope } from '@/lib/rag/tenant/access';
import { mintScope, withAccess, type TenantScope } from '@/lib/rag/tenant/scope';

const ORG_O = '00000000-0000-4000-8000-0000000000c1';
const USER_A = '00000000-0000-4000-8000-0000000000a1';
const GROUP_1 = 'g:00000000-0000-4000-8000-0000000000f1';
const ID_1 = '00000000-0000-4000-8000-000000000101';
const ID_2 = '00000000-0000-4000-8000-000000000102';
const ID_3 = '00000000-0000-4000-8000-000000000103';

interface Call {
  fn: string;
  args: Record<string, unknown>;
}

let calls: Call[];

function client(respond: (call: Call) => RpcResponse): RpcClient {
  return {
    rpc(fn, args) {
      const call = { fn, args };
      calls.push(call);
      const request = {
        abortSignal: () => request,
        then: (ok: (value: RpcResponse) => unknown, bad?: (reason: unknown) => unknown) =>
          Promise.resolve()
            .then(() => respond(call))
            .then(ok, bad),
      };
      return request as ReturnType<RpcClient['rpc']>;
    },
  };
}

const base = () => mintScope('org', USER_A, ORG_O);
const offScope = () => withAccess(base(), mintAccessScope('off', []));
const keysScope = () => withAccess(base(), mintAccessScope('keys', ['all', GROUP_1]));
const adminScope = () => withAccess(base(), mintAccessScope('admin_all', []));

beforeEach(() => {
  calls = [];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  resetRagDepsForTests();
  resetRagConfigForTests();
});

describe('visibleChunkIds and visibleDocumentIds', () => {
  test('mode off returns the input ids without a call', async () => {
    const admin = client(() => ({ data: [], error: null }));
    const chunks = await visibleChunkIds(offScope(), [ID_1, ID_2], { admin });
    const docs = await visibleDocumentIds(offScope(), [ID_3], { admin });
    expect(calls).toEqual([]);
    expect(chunks.ok && [...chunks.ids].sort()).toEqual([ID_1, ID_2]);
    expect(docs.ok && [...docs.ids]).toEqual([ID_3]);
  });

  test('keys mode makes one batched call with the access arguments and keeps only asked ids', async () => {
    const admin = client(() => ({ data: [ID_2, ID_3], error: null }));
    const out = await visibleChunkIds(keysScope(), [ID_1, ID_2], { admin });
    expect(calls).toEqual([
      {
        fn: 'rag_chunks_visible',
        args: { p_tenant_key: `o:${ORG_O}`, p_chunk_ids: [ID_1, ID_2], p_access_keys: ['all', GROUP_1], p_access_all: false },
      },
    ]);
    expect(out.ok && [...out.ids]).toEqual([ID_2]);
  });

  test('admin_all calls the document check with p_access_all', async () => {
    const admin = client(() => ({ data: [{ rag_documents_visible: ID_1 }], error: null }));
    const out = await visibleDocumentIds(adminScope(), [ID_1], { admin });
    expect(calls[0]).toEqual({
      fn: 'rag_documents_visible',
      args: { p_tenant_key: `o:${ORG_O}`, p_document_ids: [ID_1], p_access_keys: ['all'], p_access_all: true },
    });
    expect(out.ok && [...out.ids]).toEqual([ID_1]);
  });

  test('a database error is a failure result, never the input ids', async () => {
    const admin = client(() => ({ data: null, error: { message: 'boom' } }));
    expect(await visibleChunkIds(keysScope(), [ID_1], { admin })).toEqual({ ok: false, reason: 'visibility_lookup_failed' });
    expect(await visibleDocumentIds(keysScope(), [ID_1], { admin })).toEqual({ ok: false, reason: 'visibility_lookup_failed' });
    const thrown = client(() => {
      throw new Error('network');
    });
    expect(await visibleChunkIds(keysScope(), [ID_1], { admin: thrown })).toEqual({ ok: false, reason: 'visibility_lookup_failed' });
    expect(await visibleChunkIds(keysScope(), [ID_1], { admin: null })).toEqual({ ok: false, reason: 'visibility_unavailable' });
  });

  test('uses the admin client from the RAG deps unless injected', async () => {
    const admin = client(() => ({ data: [ID_1], error: null }));
    setRagDepsForTests({ adminClient: () => admin as never });
    const out = await visibleChunkIds(keysScope(), [ID_1]);
    expect(calls).toHaveLength(1);
    expect(out.ok && [...out.ids]).toEqual([ID_1]);
  });

  test('an unminted scope throws', async () => {
    await expect(visibleChunkIds({ kind: 'single' } as unknown as TenantScope, [ID_1])).rejects.toThrow();
  });
});

describe('createCitationRecheck', () => {
  test('is undefined for mode off', () => {
    expect(createCitationRecheck(offScope())).toBeUndefined();
  });

  test('returns the visible subset of the chunk ids', async () => {
    const recheck = createCitationRecheck(keysScope(), { admin: client(() => ({ data: [ID_1], error: null })) });
    expect(recheck).toBeTypeOf('function');
    expect([...(await recheck!([ID_1, ID_2]))]).toEqual([ID_1]);
  });

  test('rejects on a database error so the caller drops every citation', async () => {
    const recheck = createCitationRecheck(keysScope(), { admin: client(() => ({ data: null, error: { message: 'boom' } })) });
    await expect(recheck!([ID_1])).rejects.toThrow('[RAG Access] citation recheck failed');
  });
});

describe('recordSecurityEvent', () => {
  test('writes ids only through rag_security_event_record', async () => {
    const admin = client(() => ({ data: ID_3, error: null }));
    const ok = await recordSecurityEvent(
      keysScope(),
      { event: 'citation_access_violation', chunkIds: [ID_1], documentIds: [ID_2], requestId: 'req-1' },
      { admin },
    );
    expect(ok).toBe(true);
    expect(calls).toEqual([
      {
        fn: 'rag_security_event_record',
        args: {
          p_tenant_key: `o:${ORG_O}`,
          p_user_id: USER_A,
          p_event: 'citation_access_violation',
          p_chunk_ids: [ID_1],
          p_document_ids: [ID_2],
          p_request_id: 'req-1',
        },
      },
    ]);
  });

  test('a failed write returns false and does not throw', async () => {
    const admin = client(() => ({ data: null, error: { message: 'boom' } }));
    await expect(
      recordSecurityEvent(keysScope(), { event: 'citation_access_violation', chunkIds: [ID_1], documentIds: [] }, { admin }),
    ).resolves.toBe(false);
  });
});
