import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, test } from 'vitest';
import type { RpcClient, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { mintScope } from '@/lib/rag/tenant/scope';
import type { BackfillScopeDeps } from '@/lib/rag/tenant/backfill-scope';

const USER_A = '00000000-0000-4000-8000-0000000000a1';

function fakeRpc(handlers: Record<string, (args: Record<string, unknown>) => RpcResponse>): RpcClient {
  const client: RpcClient = {
    rpc(fn, args) {
      const result = handlers[fn]?.(args) ?? { data: null, error: null };
      const request: import('@/lib/rag/backend/supabase-rpc').RpcRequest = {
        abortSignal: () => request,
        then: (onFulfilled, onRejected) => Promise.resolve(result).then(onFulfilled, onRejected),
      };
      return request;
    },
  };
  return client;
}

function scopeDeps(deploymentMode: 'single-tenant' | 'multi-tenant' = 'multi-tenant'): BackfillScopeDeps {
  return {
    deploymentMode,
    admin: {
      from() {
        const chain = { select: () => chain, eq: () => chain, abortSignal: () => chain, maybeSingle: async () => ({ data: null, error: null }) };
        return chain;
      },
      auth: { admin: { getUserById: async (id: string) => ({ data: { user: id === USER_A ? { id } : null }, error: null }) } },
    },
    signal: AbortSignal.timeout(30_000),
  } as unknown as BackfillScopeDeps;
}

describe('backfill scope', () => {
  test('validates tenant keys', async () => {
    const { backfillScope } = await import('@/lib/rag/tenant/backfill-scope');
    expect(await backfillScope(`U:${USER_A}`, scopeDeps())).toEqual({ ok: true, scope: mintScope('personal', USER_A, null) });
    expect(await backfillScope('s:default', scopeDeps('single-tenant'))).toEqual({ ok: true, scope: mintScope('single', null, null) });
    expect(await backfillScope('garbage', scopeDeps())).toMatchObject({ ok: false, reason: 'invalid_tenant' });
  });
});

describe('backfill inventory', () => {
  test('hashes and reconciles tenant-scoped duplicates', async () => {
    const { inventory } = await import('@/lib/rag/ingest/backfill/inventory');
    const BATCH_ID = '20000000-0000-4000-8000-0000000000b1';
    const files: Record<string, string> = {};
    for (let i = 0; i < 9; i += 1) files[`f-${i}.pdf`] = `u-${i}`;
    files['f-9.pdf'] = files['f-0.pdf'];
    files['f-10.pdf'] = files['f-1.pdf'];
    files['f-11.pdf'] = 'existing';

    async function* gen() {
      for (const [sourceKey, text] of Object.entries(files)) {
        const buf = Buffer.from(text);
        yield { sourceKey, size: buf.length, ext: 'pdf', async open() { return Readable.from([buf]); } };
      }
    }

    const existingHash = createHash('sha256').update('existing').digest('hex');
    const result = await inventory(
      { id: BATCH_ID, tenantKey: `u:${USER_A}` },
      gen(),
      {
        rpc: fakeRpc({
          rag_existing_file_hashes: (args) => ({
            data: (args.p_hashes as string[]).includes(existingHash)
              ? [{ id: 'd1', file_sha256: existingHash, tenant_key: `u:${USER_A}`, source_key: 'old' }]
              : [],
            error: null,
          }),
          rag_enqueue_backfill_jobs: () => ({ data: [{ ok: true }], error: null }),
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    expect(result.totals).toMatchObject({ total: 12, uniqueNew: 9, inInventoryDuplicates: 2, existingDuplicates: 1 });
  });
});