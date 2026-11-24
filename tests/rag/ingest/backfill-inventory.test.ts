import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { RpcClient, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { mintScope, scopeKey } from '@/lib/rag/tenant/scope';

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const USER_B = '00000000-0000-4000-8000-0000000000b1';
const ORG_O = '00000000-0000-4000-8000-0000000000c1';

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
      from(table: string) {
        const chain = {
          select: () => chain,
          eq: (col: string, val: string) => {
            if (table === 'organizations' && col === 'id') {
              const found = val === ORG_O;
              return {
                abortSignal: () => ({
                  maybeSingle: async () => ({ data: found ? { id: ORG_O } : null, error: null }),
                }),
              };
            }
            return chain;
          },
          abortSignal: () => chain,
          maybeSingle: async () => ({ data: null, error: null }),
        };
        return chain;
      },
      auth: {
        admin: {
          getUserById: async (id: string) => ({
            data: { user: id === USER_A || id === USER_B ? { id } : null },
            error: null,
          }),
        },
      },
    },
    signal: AbortSignal.timeout(30_000),
  };
}

describe('backfill tenant and sources', () => {
  let root = '';
  let manifestPath = '';

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'backfill-root-'));
    await writeFile(path.join(root, 'a.txt'), 'alpha');
    await mkdir(path.join(root, 'nested'), { recursive: true });
    await writeFile(path.join(root, 'nested', 'b.txt'), 'bravo');
    const outside = path.join(os.tmpdir(), `backfill-out-${Date.now()}.secret`);
    await writeFile(outside, 'secret');
    try {
      await symlink(outside, path.join(root, 'escape.link'));
    } catch {
      await writeFile(path.join(root, 'escape.link'), 'fallback');
    }

    const dir = await mkdtemp(path.join(os.tmpdir(), 'backfill-manifest-'));
    await writeFile(path.join(dir, 'ok.pdf'), '%PDF-1.4');
    manifestPath = path.join(dir, 'manifest.jsonl');
    await writeFile(
      manifestPath,
      `${[
        JSON.stringify({ source_key: 'good-path', path: 'ok.pdf' }),
        JSON.stringify({ source_key: 'good-url', url: 'https://example.com/file.pdf' }),
      ].join('\n')}\n`,
    );
  });

  test('validates tenants and lists safe folder, manifest and bucket sources', async () => {
    const { backfillScope } = await import('@/lib/rag/tenant/backfill-scope');
    const { listSource } = await import('@/lib/rag/ingest/backfill/sources');

    expect(await backfillScope(`U:${USER_A}`, scopeDeps())).toEqual({ ok: true, scope: mintScope('personal', USER_A, null) });
    expect(await backfillScope(`u:00000000-0000-4000-8000-000000000099`, scopeDeps())).toMatchObject({
      ok: false,
      reason: 'unknown_tenant',
    });
    expect(await backfillScope('s:default', scopeDeps())).toMatchObject({ ok: false, reason: 'invalid_tenant' });
    expect(await backfillScope('s:default', scopeDeps('single-tenant'))).toEqual({
      ok: true,
      scope: mintScope('single', null, null),
    });

    const folderKeys: string[] = [];
    for await (const item of listSource({ kind: 'folder', ref: root })) folderKeys.push(item.sourceKey);
    expect(folderKeys.sort()).toEqual(['a.txt', 'nested/b.txt']);
    expect(folderKeys).not.toContain('escape.link');

    await writeFile(path.join(root, '..escape.txt'), 'y');
    await expect(async () => {
      for await (const _ of listSource({ kind: 'folder', ref: root })) {
        /* drain */
      }
    }).rejects.toThrow(/outside_root|refused|\.\./i);

    const badLine = JSON.stringify({ source_key: 'both', path: '/x', url: 'https://example.com/x' });
    const badFile = `${manifestPath}.bad.jsonl`;
    await writeFile(badFile, `${badLine}\n`);
    const reasons: string[] = [];
    for await (const _ of listSource({
      kind: 'manifest',
      ref: badFile,
      deps: {
        onManifestReject: (reason) => reasons.push(reason),
        resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
        fetch: async () => new Response('x', { status: 200 }),
      },
    })) {
      /* none */
    }
    expect(reasons.length).toBe(1);

    const manifestKeys: string[] = [];
    for await (const item of listSource({
      kind: 'manifest',
      ref: manifestPath,
      deps: {
        resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
        fetch: async () => new Response('%PDF', { status: 200, headers: { 'content-length': '4' } }),
      },
    })) {
      manifestKeys.push(item.sourceKey);
    }
    expect(manifestKeys).toEqual(['good-path', 'good-url']);

    const fetchSpy = vi.fn();
    const priv = path.join(path.dirname(manifestPath), 'private.jsonl');
    await writeFile(priv, `${JSON.stringify({ source_key: 'local', url: 'https://loopback.test/file.pdf' })}\n`);
    const privReasons: string[] = [];
    for await (const _ of listSource({
      kind: 'manifest',
      ref: priv,
      deps: {
        resolveHost: async () => [{ address: '127.0.0.1', family: 4 }],
        fetch: fetchSpy,
        onManifestReject: (r) => privReasons.push(r),
      },
    })) {
      /* none */
    }
    expect(privReasons).toContain('private_url');
    expect(fetchSpy).not.toHaveBeenCalled();

    const download = vi.fn();
    const bucketKeys: string[] = [];
    for await (const item of listSource({
      kind: 'bucket',
      ref: 'fixture-bucket',
      deps: {
        storage: {
          from: () => ({
            list: async () => ({ data: [{ name: 'one.pdf' }, { name: 'two.pdf' }], error: null }),
            download,
          }),
        },
      },
    })) {
      bucketKeys.push(item.sourceKey);
    }
    expect(bucketKeys).toEqual(['one.pdf', 'two.pdf']);
    expect(download).not.toHaveBeenCalled();
  });
});

describe('backfill inventory', () => {
  const BATCH_ID = '20000000-0000-4000-8000-0000000000b1';

  test('hashes, deduplicates within tenant and streams large files', async () => {
    const { inventory } = await import('@/lib/rag/ingest/backfill/inventory');

    const files: Record<string, string> = {};
    for (let i = 0; i < 9; i += 1) files[`file-${i}.pdf`] = `unique-${i}`;
    files['file-9.pdf'] = files['file-0.pdf'];
    files['file-10.pdf'] = files['file-1.pdf'];
    files['file-11.pdf'] = 'tenant-existing-only';

    async function* genFixture() {
      for (const [sourceKey, text] of Object.entries(files)) {
        const buf = Buffer.from(text);
        yield {
          sourceKey,
          size: buf.byteLength,
          ext: 'pdf',
          async open() {
            return Readable.from([buf]);
          },
        };
      }
    }

    const existingHash = createHash('sha256').update(Buffer.from('tenant-existing-only')).digest('hex');
    const enqueue: Record<string, unknown>[][] = [];
    const rpc = fakeRpc({
      rag_existing_file_hashes: (args) => {
        const hashes = (args.p_hashes as string[]) ?? [];
        if (hashes.includes(existingHash)) {
          return {
            data: [
              { id: 'doc-1', file_sha256: existingHash, tenant_key: scopeKey(mintScope('personal', USER_A, null)), source_key: 'old' },
            ],
            error: null,
          };
        }
        return { data: [], error: null };
      },
      rag_enqueue_backfill_jobs: (args) => {
        enqueue.push((Array.isArray(args.p_jobs) ? args.p_jobs : []) as Record<string, unknown>[]);
        return { data: 1, error: null };
      },
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const result = await inventory({ id: BATCH_ID, tenantKey: `u:${USER_A}` }, genFixture(), {
      rpc,
      signal: AbortSignal.timeout(30_000),
    });
    expect(result.totals).toMatchObject({ total: 12, uniqueNew: 9, inInventoryDuplicates: 2, existingDuplicates: 1 });
    expect(enqueue.flat().filter((j) => j.status === 'skipped_duplicate').length).toBe(3);
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('[Backfill]'))).toBe(true);
    logSpy.mockRestore();

    async function* otherTenant() {
      const buf = Buffer.from('tenant-b-only');
      yield {
        sourceKey: 'only.pdf',
        size: buf.length,
        ext: 'pdf',
        async open() {
          return Readable.from([buf]);
        },
      };
    }
    const otherHash = createHash('sha256').update('tenant-b-only').digest('hex');
    const other = await inventory(
      { id: BATCH_ID, tenantKey: `u:${USER_A}` },
      otherTenant(),
      {
        rpc: fakeRpc({
          rag_existing_file_hashes: () => ({
            data: [{ id: 'x', file_sha256: otherHash, tenant_key: `u:${USER_B}`, source_key: 'y' }],
            error: null,
          }),
          rag_enqueue_backfill_jobs: () => ({ data: 0, error: null }),
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    expect(other.totals.existingDuplicates).toBe(0);

    const chunk = Buffer.alloc(32 * 1024, 9);
    let readChunks = 0;
    async function* large() {
      yield {
        sourceKey: 'large.bin',
        size: chunk.length * 16,
        ext: 'bin',
        async open() {
          readChunks = 0;
          return Readable.from(
            (async function* () {
              for (let i = 0; i < 16; i += 1) {
                readChunks += 1;
                yield chunk;
              }
            })(),
          );
        },
      };
    }
    await inventory({
      id: BATCH_ID,
      tenantKey: `u:${USER_A}`,
    }, large(), {
      rpc: fakeRpc({
        rag_existing_file_hashes: () => ({ data: [], error: null }),
        rag_enqueue_backfill_jobs: () => ({ data: 0, error: null }),
      }),
      signal: AbortSignal.timeout(30_000),
    });
    expect(readChunks).toBe(16);
  });
});