import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, test } from 'vitest';
import type { RpcClient, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { mintScope } from '@/lib/rag/tenant/scope';

const USER_A = '00000000-0000-4000-8000-0000000000a1';

function fakeRpc(handlers: Record<string, (args: Record<string, unknown>) => RpcResponse>): RpcClient {
  return {
    rpc(fn, args) {
      const result = handlers[fn]?.(args) ?? { data: null, error: null };
      const request = {
        abortSignal: () => request,
        then: (onFulfilled: (v: RpcResponse) => unknown, onRejected?: (e: unknown) => unknown) =>
          Promise.resolve(result).then(onFulfilled, onRejected),
      };
      return request;
    },
  };
}

function scopeDeps(deploymentMode: 'single-tenant' | 'multi-tenant' = 'multi-tenant') {
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
  };
}

describe('backfill scope', () => {
  test('validates tenant keys', async () => {
    const { backfillScope } = await import('@/lib/rag/tenant/backfill-scope');
    expect(await backfillScope(`U:${USER_A}`, scopeDeps())).toEqual({ ok: true, scope: mintScope('personal', USER_A, null) });
    expect(await backfillScope('s:default', scopeDeps('single-tenant'))).toEqual({ ok: true, scope: mintScope('single', null, null) });
    expect(await backfillScope('garbage', scopeDeps())).toMatchObject({ ok: false, reason: 'invalid_tenant' });
  });
});

describe('backfill sources', () => {
  test('lists folder and bucket refs and rejects unsafe manifest lines', async () => {
    const { listSource } = await import('@/lib/rag/ingest/backfill/sources');
    const root = await mkdtemp(path.join(os.tmpdir(), 'bf-src-'));
    await writeFile(path.join(root, 'a.txt'), 'alpha');
    const folder: string[] = [];
    for await (const item of listSource({ kind: 'folder', ref: root })) folder.push(item.sourceKey);
    expect(folder).toEqual(['a.txt']);

    const buckets: string[] = [];
    for await (const item of listSource({
      kind: 'bucket',
      ref: 'bf-fixture',
      deps: {
        storage: {
          from: () => ({
            list: async () => ({ data: [{ name: 'one.pdf' }], error: null }),
            download: async () => ({ data: null, error: null }),
          }),
        },
      },
    })) {
      buckets.push(item.sourceKey);
    }
    expect(buckets).toEqual(['one.pdf']);

    const rejected: string[] = [];
    const manifest = path.join(root, 'bad.jsonl');
    await writeFile(manifest, `${JSON.stringify({ source_key: 'x', path: '/a', url: 'https://a.test' })}\n`);
    for await (const _ of listSource({
      kind: 'manifest',
      ref: manifest,
      deps: { onManifestReject: (reason) => rejected.push(reason) },
    })) {
      /* none */
    }
    expect(rejected).toHaveLength(1);
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
          rag_enqueue_backfill_jobs: () => ({ data: 1, error: null }),
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    expect(result.totals).toMatchObject({ total: 12, uniqueNew: 9, inInventoryDuplicates: 2, existingDuplicates: 1 });
  });
});