import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { inventory } from '@/lib/rag/ingest/backfill/inventory';
import { ORIGINALS_MAX_BYTES } from '@/lib/rag/ingest/object-store';
import {
  isBlockedAddress,
  listSource,
  type BackfillSourceDeps,
  type BackfillStorageBucket,
  type SourceItem,
} from '@/lib/rag/ingest/backfill/sources';
import { backfillScope, type BackfillScopeAdmin } from '@/lib/rag/tenant/backfill-scope';
import { mintScope, scopeKey } from '@/lib/rag/tenant/scope';

const hashEvents = vi.hoisted(() => ({ recording: false, log: [] as string[] }));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  const createHash: typeof actual.createHash = (...args: Parameters<typeof actual.createHash>) => {
    const hash = actual.createHash(...args);
    const update = hash.update.bind(hash) as (data: unknown, encoding?: unknown) => typeof hash;
    (hash as unknown as { update: typeof update }).update = (data, encoding) => {
      if (hashEvents.recording) hashEvents.log.push('update');
      return update(data, encoding);
    };
    return hash;
  };
  return { ...actual, default: { ...actual, createHash }, createHash };
});

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const USER_B = '00000000-0000-4000-8000-0000000000b1';
const ORG_O = '00000000-0000-4000-8000-0000000000c1';
const UNKNOWN = '00000000-0000-4000-8000-000000000099';

interface AdminCalls {
  users: string[];
  orgs: string[];
}

function fakeAdmin(): { admin: BackfillScopeAdmin; calls: AdminCalls } {
  const calls: AdminCalls = { users: [], orgs: [] };
  const admin = {
    from(table: string) {
      return {
        select: () => ({
          eq: (_column: string, value: string) => ({
            abortSignal: () => ({
              maybeSingle: async () => {
                if (table === 'organizations') calls.orgs.push(value);
                return { data: table === 'organizations' && value === ORG_O ? { id: ORG_O } : null, error: null };
              },
            }),
          }),
        }),
      };
    },
    auth: {
      admin: {
        getUserById: async (id: string) => {
          calls.users.push(id);
          return { data: { user: id === USER_A || id === USER_B ? { id } : null }, error: null };
        },
      },
    },
  };
  return { admin: admin as unknown as BackfillScopeAdmin, calls };
}

describe('backfillScope', () => {
  test('multi-tenant: mints a scope only for an existing user or organization, lower-casing the key once', async () => {
    const { admin, calls } = fakeAdmin();
    const deps = { deploymentMode: 'multi-tenant' as const, admin };

    expect(await backfillScope(`u:${USER_A}`, deps)).toEqual({ ok: true, scope: mintScope('personal', USER_A, null) });
    expect(await backfillScope(`U:${USER_A.toUpperCase()}`, deps)).toEqual({ ok: true, scope: mintScope('personal', USER_A, null) });
    expect(calls.users.every((id) => id === USER_A)).toBe(true);
    expect(await backfillScope(`o:${ORG_O}`, deps)).toEqual({ ok: true, scope: mintScope('org', null, ORG_O) });
    expect(await backfillScope(`u:${UNKNOWN}`, deps)).toEqual({ ok: false, reason: 'unknown_tenant' });
    expect(await backfillScope(`o:${UNKNOWN}`, deps)).toEqual({ ok: false, reason: 'unknown_tenant' });
    expect(await backfillScope(`o:${USER_A}`, deps)).toEqual({ ok: false, reason: 'unknown_tenant' });
    expect(await backfillScope(`u:${ORG_O}`, deps)).toEqual({ ok: false, reason: 'unknown_tenant' });
  });

  test('multi-tenant refuses s:default and garbage before any lookup', async () => {
    const { admin, calls } = fakeAdmin();
    const deps = { deploymentMode: 'multi-tenant' as const, admin };
    for (const key of ['s:default', '', 'default', 'u:not-a-uuid', `x:${USER_A}`, `u:${USER_A} extra`, `u:${USER_A},u:${USER_B}`, '../etc', `u:${USER_A}/../${USER_B}`]) {
      expect(await backfillScope(key, deps)).toEqual({ ok: false, reason: 'invalid_tenant' });
    }
    expect(calls.users).toEqual([]);
    expect(calls.orgs).toEqual([]);
    expect(await backfillScope(undefined as unknown as string, deps)).toEqual({ ok: false, reason: 'invalid_tenant' });
  });

  test('single-tenant accepts only s:default and never consults the database', async () => {
    const { admin, calls } = fakeAdmin();
    const deps = { deploymentMode: 'single-tenant' as const, admin };
    expect(await backfillScope('s:default', deps)).toEqual({ ok: true, scope: mintScope('single', null, null) });
    expect(await backfillScope('S:DEFAULT', deps)).toEqual({ ok: true, scope: mintScope('single', null, null) });
    expect(await backfillScope(`u:${USER_A}`, deps)).toEqual({ ok: false, reason: 'invalid_tenant' });
    expect(await backfillScope(`o:${ORG_O}`, deps)).toEqual({ ok: false, reason: 'invalid_tenant' });
    expect(calls.users).toEqual([]);
    expect(calls.orgs).toEqual([]);
  });

  test('two tenants never share a scope: each key yields its own scope key, in both modes', async () => {
    const { admin } = fakeAdmin();
    const multi = { deploymentMode: 'multi-tenant' as const, admin };
    const a = await backfillScope(`u:${USER_A}`, multi);
    const b = await backfillScope(`u:${USER_B}`, multi);
    const o = await backfillScope(`o:${ORG_O}`, multi);
    if (!a.ok || !b.ok || !o.ok) throw new Error('expected scopes');
    expect(new Set([scopeKey(a.scope), scopeKey(b.scope), scopeKey(o.scope)]).size).toBe(3);
    expect(scopeKey(a.scope)).toBe(`u:${USER_A}`);
    expect(scopeKey(b.scope)).toBe(`u:${USER_B}`);
    expect(scopeKey(o.scope)).toBe(`o:${ORG_O}`);

    const single = await backfillScope('s:default', { deploymentMode: 'single-tenant', admin });
    if (!single.ok) throw new Error('expected scope');
    expect(scopeKey(single.scope)).toBe('s:default');
    // Neither mode can be talked into the other's key shape.
    expect((await backfillScope('s:default', multi)).ok).toBe(false);
    expect((await backfillScope(`u:${USER_A}`, { deploymentMode: 'single-tenant', admin })).ok).toBe(false);
  });

  test('a failing lookup refuses as unavailable instead of minting', async () => {
    const throwing = {
      from: () => {
        throw new Error('db down');
      },
      auth: {
        admin: {
          getUserById: async () => {
            throw new Error('auth down');
          },
        },
      },
    } as unknown as BackfillScopeAdmin;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await backfillScope(`u:${USER_A}`, { deploymentMode: 'multi-tenant', admin: throwing })).toEqual({ ok: false, reason: 'unavailable' });
    expect(await backfillScope(`o:${ORG_O}`, { deploymentMode: 'multi-tenant', admin: throwing })).toEqual({ ok: false, reason: 'unavailable' });
    expect(await backfillScope(`u:${USER_A}`, { deploymentMode: 'multi-tenant', admin: null })).toEqual({ ok: false, reason: 'unavailable' });
    warn.mockRestore();
  });
});

async function drain(
  input: Parameters<typeof listSource>[0],
): Promise<{ items: SourceItem[]; reasons: string[] }> {
  const reasons: string[] = [];
  const items: SourceItem[] = [];
  for await (const item of listSource({ ...input, deps: { ...input.deps, onReject: (reason) => reasons.push(reason) } })) items.push(item);
  return { items, reasons };
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

describe('isBlockedAddress', () => {
  test.each([
    '127.0.0.1',
    '127.255.255.254',
    '10.0.0.1',
    '10.255.255.255',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:10.0.0.1',
    '64:ff9b::7f00:1',
    'not-an-ip',
    '',
  ])('%s is blocked', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  test.each(['93.184.216.34', '8.8.8.8', '172.15.0.1', '172.32.0.1', '100.63.255.255', '2606:4700:4700::1111', '::ffff:8.8.8.8'])(
    '%s is public',
    (address) => {
      expect(isBlockedAddress(address)).toBe(false);
    },
  );
});

describe('listSource folder', () => {
  let root = '';
  let outside = '';

  beforeEach(async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'backfill-folder-'));
    root = path.join(base, 'root');
    outside = path.join(base, 'outside');
    await mkdir(path.join(root, 'nested', 'deeper'), { recursive: true });
    await mkdir(outside);
    await writeFile(path.join(root, 'a.txt'), 'alpha');
    await writeFile(path.join(root, 'a..b.txt'), 'dots');
    await writeFile(path.join(root, 'nested', 'b.txt'), 'bravo');
    await writeFile(path.join(root, 'nested', 'deeper', 'c.txt'), 'charlie');
    await writeFile(path.join(outside, 'secret.txt'), 'secret');
    await mkdir(path.join(outside, 'dir'));
    await writeFile(path.join(outside, 'dir', 'inner.txt'), 'inner');
  });

  afterEach(async () => {
    await rm(path.dirname(root), { recursive: true, force: true });
  });

  test('lists every file recursively in a stable sorted order, keys relative to the root', async () => {
    const { items, reasons } = await drain({ kind: 'folder', ref: root });
    expect(items.map((i) => i.sourceKey)).toEqual(['a..b.txt', 'a.txt', 'nested/b.txt', 'nested/deeper/c.txt']);
    expect(items.map((i) => i.ext)).toEqual(['txt', 'txt', 'txt', 'txt']);
    expect(items.map((i) => i.size)).toEqual([4, 5, 5, 7]);
    expect(reasons).toEqual([]);
    expect(await readAll(await (items[1] as SourceItem).open())).toBe('alpha');
    const again = await drain({ kind: 'folder', ref: root });
    expect(again.items.map((i) => i.sourceKey)).toEqual(items.map((i) => i.sourceKey));
  });

  test('a symlink to a file or directory outside the root is refused with outside_root and never followed', async () => {
    await symlink(path.join(outside, 'secret.txt'), path.join(root, 'escape.link'));
    await symlink(outside, path.join(root, 'dirlink'));
    await symlink(path.join(outside, 'dir', 'inner.txt'), path.join(root, 'second.link'));
    const { items, reasons } = await drain({ kind: 'folder', ref: root });
    expect(items.map((i) => i.sourceKey)).toEqual(['a..b.txt', 'a.txt', 'nested/b.txt', 'nested/deeper/c.txt']);
    expect(reasons).toEqual(['outside_root', 'outside_root', 'outside_root']);
  });

  test('a symlink to a file inside the root is listed under its own name', async () => {
    await symlink(path.join(root, 'a.txt'), path.join(root, 'inner.link'));
    const { items, reasons } = await drain({ kind: 'folder', ref: root });
    expect(items.map((i) => i.sourceKey)).toContain('inner.link');
    expect(reasons).toEqual([]);
  });

  test('a file swapped for an outside symlink after listing is refused at open', async () => {
    const { items } = await drain({ kind: 'folder', ref: root });
    const target = items.find((i) => i.sourceKey === 'a.txt') as SourceItem;
    await rm(path.join(root, 'a.txt'));
    await symlink(path.join(outside, 'secret.txt'), path.join(root, 'a.txt'));
    await expect(target.open()).rejects.toMatchObject({ reason: 'outside_root' });
  });

  test('a file over the Phase 3 size limit is refused with too_large', async () => {
    await writeFile(path.join(root, 'big.bin'), '');
    await truncate(path.join(root, 'big.bin'), ORIGINALS_MAX_BYTES + 1);
    await writeFile(path.join(root, 'exact.bin'), '');
    await truncate(path.join(root, 'exact.bin'), ORIGINALS_MAX_BYTES);
    const { items, reasons } = await drain({ kind: 'folder', ref: root });
    expect(items.map((i) => i.sourceKey)).toContain('exact.bin');
    expect(items.map((i) => i.sourceKey)).not.toContain('big.bin');
    expect(reasons).toEqual(['too_large']);
  });

  test('refusals and listing log reason codes only, never a file name or path', async () => {
    await writeFile(path.join(outside, 'customer-secret-name.pdf'), 'x');
    await symlink(path.join(outside, 'customer-secret-name.pdf'), path.join(root, 'invoice-acme.pdf'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await drain({ kind: 'folder', ref: root });
    const logged = JSON.stringify([...warn.mock.calls, ...log.mock.calls]);
    expect(logged).toContain('[Backfill]');
    expect(logged).not.toContain('invoice-acme');
    expect(logged).not.toContain('customer-secret-name');
    expect(logged).not.toContain(root);
    warn.mockRestore();
    log.mockRestore();
  });

  test('an aborted signal stops the listing', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(drain({ kind: 'folder', ref: root, signal: controller.signal })).rejects.toThrow();
  });
});

describe('listSource manifest', () => {
  let dir = '';
  let outsideFile = '';
  const PUBLIC = [{ address: '93.184.216.34', family: 4 }];

  beforeEach(async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'backfill-manifest-'));
    dir = path.join(base, 'archive');
    await mkdir(dir);
    outsideFile = path.join(base, 'outside.pdf');
    await writeFile(outsideFile, 'outside');
    await writeFile(path.join(dir, 'ok.pdf'), '%PDF-1.4');
    await writeFile(path.join(dir, 'second.txt'), 'second');
  });

  afterEach(async () => {
    await rm(path.dirname(dir), { recursive: true, force: true });
  });

  async function manifest(lines: Array<unknown>): Promise<string> {
    const file = path.join(dir, 'manifest.jsonl');
    await writeFile(file, `${lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n')}\n`);
    return file;
  }

  function netDeps(overrides: Partial<BackfillSourceDeps> & { hosts?: Record<string, Array<{ address: string; family: number }>> } = {}) {
    const urls: string[] = [];
    const inits: RequestInit[] = [];
    const hostMap = overrides.hosts ?? { 'files.example.com': PUBLIC };
    const deps: BackfillSourceDeps = {
      lookupHost: async (host) => {
        const found = hostMap[host];
        if (!found) throw new Error('ENOTFOUND');
        return found;
      },
      fetch: async (input, init) => {
        urls.push(String(input));
        inits.push(init ?? {});
        return new Response('%PDF-body', { status: 200 });
      },
      ...overrides,
    };
    delete (deps as { hosts?: unknown }).hosts;
    return { deps, urls, inits };
  }

  test('valid path and url lines come back in file order with their doc type; urls are fetched with redirect manual', async () => {
    const ref = await manifest([
      { source_key: 'one', path: 'ok.pdf', doc_type: 'contract_legal' },
      { source_key: 'two', url: 'https://files.example.com/a/report.PDF?x=1' },
      { source_key: 'three', path: 'second.txt' },
    ]);
    const { deps, urls, inits } = netDeps();
    const { items, reasons } = await drain({ kind: 'manifest', ref, root: dir, deps });
    expect(items.map((i) => i.sourceKey)).toEqual(['one', 'two', 'three']);
    expect(items.map((i) => i.docType)).toEqual(['contract_legal', undefined, undefined]);
    expect(items.map((i) => i.ext)).toEqual(['pdf', 'pdf', 'txt']);
    expect(reasons).toEqual([]);
    expect(urls).toEqual(['https://files.example.com/a/report.PDF?x=1']);
    expect(inits[0]?.redirect).toBe('manual');
    expect(await readAll(await (items[1] as SourceItem).open())).toBe('%PDF-body');
    expect(await readAll(await (items[0] as SourceItem).open())).toBe('%PDF-1.4');
  });

  test('every invalid line is refused on its own with a reason and the valid lines around it survive', async () => {
    const ref = await manifest([
      { source_key: 'good-1', path: 'ok.pdf' },
      { source_key: 'both', path: 'ok.pdf', url: 'https://files.example.com/x.pdf' },
      { source_key: 'neither' },
      { source_key: 'extra-field', path: 'ok.pdf', note: 'strict schema' },
      { source_key: 'bad-type', path: 'ok.pdf', doc_type: 'spreadsheet' },
      { source_key: '', path: 'ok.pdf' },
      { source_key: 'http', url: 'http://files.example.com/x.pdf' },
      { source_key: 'ftp', url: 'ftp://files.example.com/x.pdf' },
      { source_key: 'not-a-url', url: 'files.example.com/x.pdf' },
      '{not json',
      '[]',
      '42',
      { source_key: 'good-1', path: 'second.txt' },
      { source_key: 'good-2', path: 'second.txt' },
    ]);
    const { deps, urls } = netDeps();
    const { items, reasons } = await drain({ kind: 'manifest', ref, root: dir, deps });
    expect(items.map((i) => i.sourceKey)).toEqual(['good-1', 'good-2']);
    expect(reasons).toEqual([
      'manifest_location',
      'manifest_location',
      'manifest_schema',
      'manifest_schema',
      'manifest_schema',
      'manifest_https',
      'manifest_https',
      'manifest_https',
      'manifest_json',
      'manifest_schema',
      'manifest_schema',
      'manifest_duplicate_key',
    ]);
    expect(urls).toEqual([]);
  });

  test('paths are confined to the explicit root: ../ segments, absolute paths, outside symlinks and missing files are refused', async () => {
    await symlink(outsideFile, path.join(dir, 'link.pdf'));
    await mkdir(path.join(dir, 'sub'));
    await writeFile(path.join(dir, 'sub', 'in.txt'), 'in');
    const ref = await manifest([
      { source_key: 'dotdot', path: '../outside.pdf' },
      { source_key: 'dotdot-inner', path: 'sub/../ok.pdf' },
      { source_key: 'absolute', path: outsideFile },
      { source_key: 'symlink', path: 'link.pdf' },
      { source_key: 'missing', path: 'nope.pdf' },
      { source_key: 'directory', path: 'sub' },
      { source_key: 'fine', path: 'sub/in.txt' },
    ]);
    const { items, reasons } = await drain({ kind: 'manifest', ref, root: dir, deps: netDeps().deps });
    expect(items.map((i) => i.sourceKey)).toEqual(['fine']);
    expect(reasons).toEqual(['outside_root', 'outside_root', 'path_absolute', 'outside_root', 'path_unreadable', 'path_unreadable']);
  });

  test('a url on a private address is refused before any request: literals, localhost, mapped IPv6 and DNS answers', async () => {
    const ref = await manifest([
      { source_key: 'loopback', url: 'https://127.0.0.1/x.pdf' },
      { source_key: 'v6-loopback', url: 'https://[::1]/x.pdf' },
      { source_key: 'mapped', url: 'https://[::ffff:127.0.0.1]/x.pdf' },
      { source_key: 'metadata', url: 'https://169.254.169.254/latest/meta-data' },
      { source_key: 'ten', url: 'https://10.1.2.3/x.pdf' },
      { source_key: 'localhost', url: 'https://localhost/x.pdf' },
      { source_key: 'dns-private', url: 'https://intranet.example.com/x.pdf' },
      { source_key: 'dns-loopback', url: 'https://loop.example.com/x.pdf' },
      { source_key: 'dns-mixed', url: 'https://mixed.example.com/x.pdf' },
      { source_key: 'dns-v6', url: 'https://six.example.com/x.pdf' },
      { source_key: 'dns-fail', url: 'https://missing.example.com/x.pdf' },
      { source_key: 'userinfo', url: 'https://user:pw@files.example.com/x.pdf' },
      { source_key: 'public', url: 'https://files.example.com/x.pdf' },
    ]);
    const { deps, urls } = netDeps({
      hosts: {
        'files.example.com': PUBLIC,
        'intranet.example.com': [{ address: '10.0.0.5', family: 4 }],
        'loop.example.com': [{ address: '127.0.0.1', family: 4 }],
        'mixed.example.com': [...PUBLIC, { address: '192.168.1.10', family: 4 }],
        'six.example.com': [{ address: 'fd00::1', family: 6 }],
      },
    });
    const { items, reasons } = await drain({ kind: 'manifest', ref, root: dir, deps });
    expect(items.map((i) => i.sourceKey)).toEqual(['public']);
    expect(reasons).toEqual([
      'private_url',
      'private_url',
      'private_url',
      'private_url',
      'private_url',
      'private_url',
      'private_url',
      'private_url',
      'private_url',
      'private_url',
      'manifest_dns',
      'manifest_https',
    ]);
    expect(urls).toEqual(['https://files.example.com/x.pdf']);
  });

  test('a redirect is followed manually and every hop is checked: a hop to a private address or to http is never requested', async () => {
    const ref = await manifest([
      { source_key: 'to-private-host', url: 'https://files.example.com/redir-private' },
      { source_key: 'to-literal', url: 'https://files.example.com/redir-literal' },
      { source_key: 'to-http', url: 'https://files.example.com/redir-http' },
      { source_key: 'relative-ok', url: 'https://files.example.com/redir-relative' },
      { source_key: 'loop', url: 'https://files.example.com/redir-loop' },
      { source_key: 'no-location', url: 'https://files.example.com/redir-none' },
    ]);
    const requested: string[] = [];
    const deps: BackfillSourceDeps = {
      lookupHost: async (host) => (host === 'files.example.com' ? PUBLIC : [{ address: '10.0.0.9', family: 4 }]),
      fetch: async (input) => {
        const url = String(input);
        requested.push(url);
        if (url.endsWith('/redir-private')) return new Response(null, { status: 302, headers: { location: 'https://internal.example.com/secret' } });
        if (url.endsWith('/redir-literal')) return new Response(null, { status: 301, headers: { location: 'https://169.254.169.254/latest' } });
        if (url.endsWith('/redir-http')) return new Response(null, { status: 307, headers: { location: 'http://files.example.com/plain' } });
        if (url.endsWith('/redir-relative')) return new Response(null, { status: 302, headers: { location: '/final.pdf' } });
        if (url.endsWith('/redir-loop')) return new Response(null, { status: 302, headers: { location: '/redir-loop' } });
        if (url.endsWith('/redir-none')) return new Response(null, { status: 302 });
        return new Response('final-bytes', { status: 200 });
      },
    };
    const { items, reasons } = await drain({ kind: 'manifest', ref, root: dir, deps });
    expect(items.map((i) => i.sourceKey)).toEqual(['relative-ok']);
    expect(await readAll(await (items[0] as SourceItem).open())).toBe('final-bytes');
    expect(reasons).toEqual(['private_url', 'private_url', 'manifest_https', 'manifest_redirect', 'manifest_redirect']);
    expect(requested).not.toContain('https://internal.example.com/secret');
    expect(requested.some((u) => u.includes('169.254.169.254'))).toBe(false);
    expect(requested.some((u) => u.startsWith('http://'))).toBe(false);
    expect(requested.filter((u) => u.endsWith('/redir-loop')).length).toBeLessThanOrEqual(6);
  });

  test('a url body over the size limit is refused, by content-length and by streamed bytes, and a failed fetch is refused', async () => {
    const ref = await manifest([
      { source_key: 'declared', url: 'https://files.example.com/declared' },
      { source_key: 'streamed', url: 'https://files.example.com/streamed' },
      { source_key: 'status', url: 'https://files.example.com/status' },
      { source_key: 'throws', url: 'https://files.example.com/throws' },
      { source_key: 'exact', url: 'https://files.example.com/exact' },
    ]);
    let cancelled = false;
    const deps: BackfillSourceDeps = {
      lookupHost: async () => PUBLIC,
      fetch: async (input) => {
        const url = String(input);
        if (url.endsWith('/declared')) return new Response('x', { status: 200, headers: { 'content-length': String(ORIGINALS_MAX_BYTES + 1) } });
        if (url.endsWith('/streamed')) {
          let sent = 0;
          const body = new ReadableStream<Uint8Array>({
            pull(controller) {
              sent += 1;
              controller.enqueue(new Uint8Array(1024 * 1024));
              if (sent > 30) controller.close();
            },
            cancel() {
              cancelled = true;
            },
          });
          return new Response(body, { status: 200 });
        }
        if (url.endsWith('/status')) return new Response('nope', { status: 404 });
        if (url.endsWith('/throws')) throw new Error('socket hang up with /private/path/detail');
        return new Response(new Uint8Array(ORIGINALS_MAX_BYTES), { status: 200 });
      },
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { items, reasons } = await drain({ kind: 'manifest', ref, root: dir, deps });
    expect(items.map((i) => i.sourceKey)).toEqual(['exact']);
    expect(items[0]?.size).toBe(ORIGINALS_MAX_BYTES);
    expect(reasons).toEqual(['too_large', 'too_large', 'manifest_fetch_failed', 'manifest_fetch_failed']);
    expect(cancelled).toBe(true);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('/private/path');
    warn.mockRestore();
  });
});

describe('listSource explicit root and hidden paths', () => {
  let base = '';
  let root = '';

  beforeEach(async () => {
    base = await mkdtemp(path.join(os.tmpdir(), 'backfill-root-'));
    root = path.join(base, 'root');
    await mkdir(path.join(root, '.git'), { recursive: true });
    await mkdir(path.join(root, 'sub', '.cache'), { recursive: true });
    await writeFile(path.join(root, 'ok.pdf'), '%PDF-1.4');
    await writeFile(path.join(root, 'sub', 'in.txt'), 'in');
    await writeFile(path.join(root, '.env.local'), 'SECRET=1');
    await writeFile(path.join(root, '.git', 'config'), 'cfg');
    await writeFile(path.join(root, 'sub', '.cache', 'x.txt'), 'x');
    await writeFile(path.join(root, 'sub', '.hidden.txt'), 'h');
    await writeFile(path.join(base, 'neighbor.txt'), 'next to the manifest, outside the root');
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  async function manifestAt(dir: string, lines: unknown[]): Promise<string> {
    const file = path.join(dir, 'manifest.jsonl');
    await writeFile(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    return file;
  }

  test('a manifest source needs an explicit root: none, empty and a missing directory are refused', async () => {
    const ref = await manifestAt(base, [{ source_key: 'one', path: 'root/ok.pdf' }]);
    await expect(drain({ kind: 'manifest', ref })).rejects.toMatchObject({ reason: 'manifest_root_required' });
    await expect(drain({ kind: 'manifest', ref, root: '' })).rejects.toMatchObject({ reason: 'manifest_root_required' });
    await expect(drain({ kind: 'manifest', ref, root: path.join(base, 'nope') })).rejects.toMatchObject({ reason: 'manifest_root_required' });
  });

  test('manifest paths resolve under the explicit root, not the manifest directory, and absolute paths are refused', async () => {
    const ref = await manifestAt(base, [
      { source_key: 'under-root', path: 'ok.pdf' },
      { source_key: 'next-to-manifest', path: 'neighbor.txt' },
      { source_key: 'up', path: '../neighbor.txt' },
      { source_key: 'absolute-inside', path: path.join(root, 'ok.pdf') },
      { source_key: 'absolute-outside', path: path.join(base, 'neighbor.txt') },
    ]);
    const { items, reasons } = await drain({ kind: 'manifest', ref, root });
    expect(items.map((i) => i.sourceKey)).toEqual(['under-root']);
    expect(reasons).toEqual(['path_unreadable', 'outside_root', 'path_absolute', 'path_absolute']);
  });

  test('manifest paths with a component starting with a dot are refused, also through a visible symlink and after open', async () => {
    await symlink(path.join(root, '.env.local'), path.join(root, 'innocent.txt'));
    const ref = await manifestAt(base, [
      { source_key: 'env', path: '.env.local' },
      { source_key: 'git', path: '.git/config' },
      { source_key: 'nested-dir', path: 'sub/.cache/x.txt' },
      { source_key: 'nested-file', path: 'sub/.hidden.txt' },
      { source_key: 'dot-segment', path: './ok.pdf' },
      { source_key: 'link', path: 'innocent.txt' },
      { source_key: 'fine', path: 'sub/in.txt' },
    ]);
    const { items, reasons } = await drain({ kind: 'manifest', ref, root });
    expect(items.map((i) => i.sourceKey)).toEqual(['fine']);
    expect(reasons).toEqual(['hidden_path', 'hidden_path', 'hidden_path', 'hidden_path', 'hidden_path', 'hidden_path']);
    await rm(path.join(root, 'sub', 'in.txt'));
    await symlink(path.join(root, '.env.local'), path.join(root, 'sub', 'in.txt'));
    await expect((items[0] as SourceItem).open()).rejects.toMatchObject({ reason: 'hidden_path' });
  });

  test('a manifest stored inside the root does not widen it: the root alone decides', async () => {
    const ref = await manifestAt(root, [{ source_key: 'env', path: '.env.local' }, { source_key: 'ok', path: 'ok.pdf' }]);
    const { items, reasons } = await drain({ kind: 'manifest', ref, root });
    expect(items.map((i) => i.sourceKey)).toEqual(['ok']);
    expect(reasons).toEqual(['hidden_path']);
  });

  test('a folder source skips dotfiles and dot directories (.env.local, .git/) and a symlink to one', async () => {
    await symlink(path.join(root, '.env.local'), path.join(root, 'innocent.txt'));
    const { items, reasons } = await drain({ kind: 'folder', ref: root });
    expect(items.map((i) => i.sourceKey)).toEqual(['ok.pdf', 'sub/in.txt']);
    expect(reasons.length).toBeGreaterThanOrEqual(4);
    expect(new Set(reasons)).toEqual(new Set(['hidden_path']));
  });
});

describe('listSource bucket', () => {
  const SCOPE_SINGLE = mintScope('single', null, null);
  const SCOPE_A = mintScope('personal', USER_A, null);
  const SCOPE_B = mintScope('personal', USER_B, null);
  const SCOPE_ORG = mintScope('org', null, ORG_O);
  const APP_BUCKETS = ['rag-originals', 'chat-images', 'chat-attachments', 'chat-videos', '3d-models', 'backgrounds'];

  function bucketOf(tree: Record<string, Array<{ name: string; id: string | null; size?: number | null }>>) {
    const lists: Array<{ prefix: string; offset: number }> = [];
    const download = vi.fn(async (objectPath: string) => ({ data: new Blob([`bytes of ${objectPath}`]), error: null }));
    const bucket: BackfillStorageBucket = {
      list: async (prefix, options) => {
        lists.push({ prefix, offset: options?.offset ?? 0 });
        const rows = tree[prefix] ?? [];
        const offset = options?.offset ?? 0;
        const limit = options?.limit ?? 100;
        return {
          data: rows.slice(offset, offset + limit).map((r) => ({
            name: r.name,
            id: r.id,
            metadata: r.id === null ? null : r.size === null ? {} : { size: r.size ?? 10 },
          })),
          error: null,
        };
      },
      download,
    };
    const from = vi.fn(() => bucket);
    return { deps: { storage: { from } } satisfies BackfillSourceDeps, lists, download, from };
  }

  const allow = (...names: string[]) => ({ allowedBuckets: names, scope: SCOPE_SINGLE });

  test('lists nested prefixes and every page without downloading anything', async () => {
    const many = Array.from({ length: 1_500 }, (_, i) => ({ name: `f${String(i).padStart(4, '0')}.pdf`, id: `id-${i}` }));
    const { deps, lists, download, from } = bucketOf({
      '': [{ name: 'folder', id: null }, ...many],
      folder: [{ name: 'inner.txt', id: 'id-inner' }, { name: 'deeper', id: null }],
      'folder/deeper': [{ name: 'leaf.md', id: 'id-leaf' }],
    });
    const { items } = await drain({ kind: 'bucket', ref: 'fixture-bucket', deps, ...allow('fixture-bucket') });
    expect(items).toHaveLength(1_500 + 2);
    expect(items.map((i) => i.sourceKey)).toContain('folder/inner.txt');
    expect(items.map((i) => i.sourceKey)).toContain('folder/deeper/leaf.md');
    expect(new Set(items.map((i) => i.sourceKey)).size).toBe(items.length);
    expect(lists.filter((l) => l.prefix === '').map((l) => l.offset)).toEqual([0, 1_000]);
    expect(from).toHaveBeenCalledWith('fixture-bucket');
    expect(download).not.toHaveBeenCalled();
    const leaf = items.find((i) => i.sourceKey === 'folder/deeper/leaf.md') as SourceItem;
    expect(await readAll(await leaf.open())).toBe('bytes of folder/deeper/leaf.md');
    expect(download).toHaveBeenCalledTimes(1);
  });

  test('refuses invalid names, a missing client and list errors', async () => {
    const { deps } = bucketOf({ '': [] });
    for (const ref of ['', 'UPPER', '../x', 'a/b', 'x']) {
      await expect(drain({ kind: 'bucket', ref, deps, ...allow(ref, 'fixture-bucket') })).rejects.toMatchObject({ name: 'SourceRejection' });
    }
    await expect(drain({ kind: 'bucket', ref: 'fixture-bucket', ...allow('fixture-bucket') })).rejects.toMatchObject({ reason: 'bucket_storage_unavailable' });
    const failing: BackfillSourceDeps = {
      storage: { from: () => ({ list: async () => ({ data: null, error: { message: 'boom' } }), download: vi.fn() }) },
    };
    await expect(drain({ kind: 'bucket', ref: 'fixture-bucket', deps: failing, ...allow('fixture-bucket') })).rejects.toMatchObject({ reason: 'bucket_list_failed' });
  });

  test('an object over the size limit is refused', async () => {
    const { deps } = bucketOf({
      '': [
        { name: 'small.pdf', id: 'a', size: 10 },
        { name: 'huge.pdf', id: 'b', size: ORIGINALS_MAX_BYTES + 1 },
      ],
    });
    const { items, reasons } = await drain({ kind: 'bucket', ref: 'fixture-bucket', deps, ...allow('fixture-bucket') });
    expect(items.map((i) => i.sourceKey)).toEqual(['small.pdf']);
    expect(reasons).toEqual(['too_large']);
  });

  test('every bucket the application owns is refused, even when the operator lists it, and nothing is listed or downloaded', async () => {
    const fromSetup = ['supabase/single-tenant-setup.sql', 'supabase/multi-tenant-setup.sql'].flatMap((file) =>
      [...readFileSync(path.join(process.cwd(), file), 'utf8').matchAll(/INSERT INTO storage\.buckets[^;]*?VALUES\s*\(\s*'([a-z0-9._-]+)'/g)].map((m) => m[1] as string),
    );
    expect(fromSetup.length).toBeGreaterThanOrEqual(5);
    for (const name of new Set([...APP_BUCKETS, ...fromSetup])) {
      const { deps, lists, download, from } = bucketOf({ '': [{ name: 'tenantB-user', id: null }], 'tenantB-user': [{ name: 'secret.pdf', id: 'x' }] });
      await expect(drain({ kind: 'bucket', ref: name, deps, ...allow(name) })).rejects.toMatchObject({ reason: 'bucket_internal' });
      expect(lists).toEqual([]);
      expect(download).not.toHaveBeenCalled();
      expect(from).not.toHaveBeenCalled();
    }
  });

  test('a bucket that is not on the allow-list is refused: absent, empty and different lists all deny', async () => {
    const { deps, lists, from } = bucketOf({ '': [{ name: 'a.pdf', id: 'x' }] });
    const base = { kind: 'bucket' as const, ref: 'fixture-bucket', deps, scope: SCOPE_SINGLE };
    await expect(drain(base)).rejects.toMatchObject({ reason: 'bucket_not_allowed' });
    await expect(drain({ ...base, allowedBuckets: [] })).rejects.toMatchObject({ reason: 'bucket_not_allowed' });
    await expect(drain({ ...base, allowedBuckets: ['other-bucket'] })).rejects.toMatchObject({ reason: 'bucket_not_allowed' });
    await expect(drain({ ...base, allowedBuckets: ['Fixture-Bucket', ' fixture-bucket'] })).rejects.toMatchObject({ reason: 'bucket_not_allowed' });
    expect(lists).toEqual([]);
    expect(from).not.toHaveBeenCalled();
  });

  test('a bucket source needs a minted tenant scope: none, a look-alike object and a string are refused', async () => {
    const { deps, lists } = bucketOf({ '': [{ name: 'a.pdf', id: 'x' }] });
    const base = { kind: 'bucket' as const, ref: 'fixture-bucket', deps, allowedBuckets: ['fixture-bucket'] };
    await expect(drain(base)).rejects.toMatchObject({ reason: 'bucket_scope_required' });
    await expect(drain({ ...base, scope: { kind: 'single', userId: null, organizationId: null } as never })).rejects.toMatchObject({ reason: 'bucket_scope_required' });
    await expect(drain({ ...base, scope: TENANT_A as never })).rejects.toMatchObject({ reason: 'bucket_scope_required' });
    expect(lists).toEqual([]);
  });

  test('two tenants: tenant A never lists or opens tenant B objects, and the other way round', async () => {
    const tree = {
      '': [{ name: 'u', id: null }, { name: 'o', id: null }],
      u: [{ name: USER_A, id: null }, { name: USER_B, id: null }],
      [`u/${USER_A}`]: [{ name: 'a1.pdf', id: 'a1' }, { name: 'sub', id: null }],
      [`u/${USER_A}/sub`]: [{ name: 'a2.pdf', id: 'a2' }],
      [`u/${USER_B}`]: [{ name: 'b1.pdf', id: 'b1' }, { name: 'sub', id: null }],
      [`u/${USER_B}/sub`]: [{ name: 'b2.pdf', id: 'b2' }],
      o: [{ name: ORG_O, id: null }],
      [`o/${ORG_O}`]: [{ name: 'org.pdf', id: 'o1' }],
    };
    for (const [scope, own, other] of [
      [SCOPE_A, USER_A, USER_B],
      [SCOPE_B, USER_B, USER_A],
    ] as const) {
      const { deps, lists, download } = bucketOf(tree);
      const { items } = await drain({ kind: 'bucket', ref: 'shared-bucket', deps, allowedBuckets: ['shared-bucket'], scope });
      expect(items.map((i) => i.sourceKey).sort()).toEqual([`u/${own}/${own === USER_A ? 'a1' : 'b1'}.pdf`, `u/${own}/sub/${own === USER_A ? 'a2' : 'b2'}.pdf`]);
      for (const entry of items) await readAll(await entry.open());
      const touched = [...lists.map((l) => l.prefix), ...download.mock.calls.map((c) => String(c[0]))];
      expect(touched.length).toBeGreaterThan(0);
      expect(touched.every((p) => p === `u/${own}` || p.startsWith(`u/${own}/`))).toBe(true);
      expect(touched.some((p) => p.includes(other))).toBe(false);
      expect(lists.some((l) => l.prefix === '' || l.prefix === 'u')).toBe(false);
    }
    const { deps, lists } = bucketOf(tree);
    const org = await drain({ kind: 'bucket', ref: 'shared-bucket', deps, allowedBuckets: ['shared-bucket'], scope: SCOPE_ORG });
    expect(org.items.map((i) => i.sourceKey)).toEqual([`o/${ORG_O}/org.pdf`]);
    expect(lists.every((l) => l.prefix === `o/${ORG_O}` || l.prefix.startsWith(`o/${ORG_O}/`))).toBe(true);
  });

  test('a storage answer that reaches outside the tenant prefix is refused row by row and never opened', async () => {
    const hostile = {
      [`u/${USER_A}`]: [
        { name: 'ok.pdf', id: 'ok' },
        { name: `../${USER_B}/b1.pdf`, id: 'x1' },
        { name: `/u/${USER_B}/b1.pdf`, id: 'x2' },
        { name: `u/${USER_B}/b1.pdf`, id: 'x3' },
        { name: '..', id: null },
        { name: '.', id: null },
        { name: `${USER_B}/b1.pdf`, id: 'x4' },
      ],
    };
    const { deps, lists, download } = bucketOf(hostile);
    const { items, reasons } = await drain({ kind: 'bucket', ref: 'shared-bucket', deps, allowedBuckets: ['shared-bucket'], scope: SCOPE_A });
    expect(items.map((i) => i.sourceKey)).toEqual([`u/${USER_A}/ok.pdf`]);
    expect(reasons).toEqual(Array.from({ length: 6 }, () => 'outside_prefix'));
    expect(lists.every((l) => l.prefix === `u/${USER_A}`)).toBe(true);
    expect(download).not.toHaveBeenCalled();
  });
});

function fakeRpc(handlers: Record<string, (args: Record<string, unknown>) => RpcResponse>): { rpc: RpcClient; calls: Array<{ fn: string; args: Record<string, unknown> }> } {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const rpc: RpcClient = {
    rpc(fn, args) {
      calls.push({ fn, args });
      const result = handlers[fn]?.(args) ?? { data: [], error: null };
      const request: RpcRequest = {
        abortSignal: () => request,
        then: (onFulfilled, onRejected) => Promise.resolve(result).then(onFulfilled, onRejected),
      };
      return request;
    },
  };
  return { rpc, calls };
}

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

function item(sourceKey: string, text: string, extra: Partial<SourceItem> = {}): SourceItem {
  const bytes = Buffer.from(text);
  return {
    sourceKey,
    size: bytes.byteLength,
    ext: sourceKey.includes('.') ? (sourceKey.split('.').pop() as string) : 'bin',
    async open() {
      return Readable.from([bytes]);
    },
    ...extra,
  };
}

async function* from<T>(values: T[]): AsyncGenerator<T> {
  for (const value of values) yield value;
}

const BATCH = '20000000-0000-4000-8000-0000000000b1';
const BATCH_B = '20000000-0000-4000-8000-0000000000b2';
const TENANT_A = `u:${USER_A}`;
const TENANT_B = `u:${USER_B}`;
const SCOPE_A = mintScope('personal', USER_A, null);
const SCOPE_B = mintScope('personal', USER_B, null);
/** The batch rows of the fake SQL: each belongs to one tenant. */
const batchRows = {
  rag_update_ingestion_batch: (args: Record<string, unknown>): RpcResponse => ({
    data: { id: args.p_batch_id, tenant_key: args.p_batch_id === BATCH_B ? TENANT_B : TENANT_A },
    error: null,
  }),
};

/** A fake of the tenant-scoped SQL: rag_existing_file_hashes answers from the hashes of the tenant it is asked about. */
function tenantLedger(existing: Record<string, string[]>) {
  const skipped: Array<Record<string, unknown>> = [];
  const fake = fakeRpc({
    ...batchRows,
    rag_existing_file_hashes: (args) => {
      const tenant = String(args.p_tenant_key);
      const known = new Set(existing[tenant] ?? []);
      const rows = (args.p_hashes as string[]).filter((h) => known.has(h)).map((h) => ({ id: `doc-${h.slice(0, 6)}`, file_sha256: h, tenant_key: tenant, source_key: 'old' }));
      return { data: rows, error: null };
    },
    rag_enqueue_backfill_jobs: (args) => {
      skipped.push(...((args.p_jobs as Array<Record<string, unknown>>) ?? []));
      return { data: [], error: null };
    },
  });
  return { ...fake, skipped };
}

describe('backfill inventory', () => {
  test('12 files with two identical pairs and one already ingested: 9 new, 3 skipped_duplicate rows, totals reconcile', async () => {
    const files: Array<[string, string]> = [];
    for (let i = 0; i < 9; i += 1) files.push([`file-${i}.pdf`, `unique-${i}`]);
    files.push(['file-9.pdf', 'unique-0'], ['file-10.pdf', 'unique-1'], ['file-11.pdf', 'tenant-existing-only']);
    const ledger = tenantLedger({ [TENANT_A]: [sha('tenant-existing-only')] });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const result = await inventory(
      { id: BATCH, scope: SCOPE_A },
      from(files.map(([key, text]) => item(key, text, key === 'file-3.pdf' ? { docType: 'contract_legal' } : {}))),
      { rpc: ledger.rpc, signal: new AbortController().signal },
    );

    expect(result.totals).toEqual({ total: 12, uniqueNew: 9, inInventoryDuplicates: 2, existingDuplicates: 1, unreadable: 0 });
    expect(result.duplicates).toEqual({ inInventory: 2, alreadyExisting: 1 });
    const { totals } = result;
    expect(totals.total).toBe(totals.uniqueNew + totals.inInventoryDuplicates + totals.existingDuplicates + totals.unreadable);
    expect(result.entries.map((e) => e.sourceKey)).toEqual(Array.from({ length: 9 }, (_, i) => `file-${i}.pdf`));
    expect(result.entries[3]).toMatchObject({ fileSha256: sha('unique-3'), docType: 'contract_legal', mimeType: 'application/pdf', filename: 'file-3.pdf', size: 8 });
    expect(result.entries[0]?.docType).toBeNull();

    expect(ledger.skipped).toHaveLength(3);
    expect(ledger.skipped.map((j) => j.source_key).sort()).toEqual(['file-10.pdf', 'file-11.pdf', 'file-9.pdf']);
    expect(ledger.skipped.every((j) => j.status === 'skipped_duplicate' && j.kind === 'ingest' && typeof j.file_sha256 === 'string')).toBe(true);
    expect(ledger.calls.filter((c) => c.fn === 'rag_enqueue_backfill_jobs').every((c) => c.args.p_batch_id === BATCH)).toBe(true);
    expect(log.mock.calls.some((c) => String(c[0]).startsWith('[Backfill]'))).toBe(true);
    log.mockRestore();
  });

  test('a file already ingested for another tenant is not a duplicate; the same file is a duplicate for the tenant that has it', async () => {
    const ledger = tenantLedger({ [TENANT_B]: [sha('shared-contract')], [`o:${ORG_O}`]: [sha('org-only')] });
    const signal = new AbortController().signal;

    const forA = await inventory({ id: BATCH, scope: SCOPE_A }, from([item('shared.pdf', 'shared-contract'), item('org.pdf', 'org-only')]), { rpc: ledger.rpc, signal });
    expect(forA.totals).toMatchObject({ uniqueNew: 2, existingDuplicates: 0 });
    expect(ledger.skipped).toEqual([]);

    const forB = await inventory({ id: BATCH_B, scope: SCOPE_B }, from([item('shared.pdf', 'shared-contract'), item('org.pdf', 'org-only')]), { rpc: ledger.rpc, signal });
    expect(forB.totals).toMatchObject({ uniqueNew: 1, existingDuplicates: 1 });
    expect(forB.entries.map((e) => e.sourceKey)).toEqual(['org.pdf']);

    const lookups = ledger.calls.filter((c) => c.fn === 'rag_existing_file_hashes');
    expect(lookups.map((c) => c.args.p_tenant_key)).toEqual([TENANT_A, TENANT_B]);
  });

  test('a row of another tenant in a lookup answer is ignored (second line of defence behind the SQL filter)', async () => {
    const leaky = fakeRpc({
      ...batchRows,
      rag_existing_file_hashes: (args) => ({
        data: (args.p_hashes as string[]).map((h) => ({ id: 'x', file_sha256: h, tenant_key: TENANT_B, source_key: 'y' })),
        error: null,
      }),
    });
    const result = await inventory({ id: BATCH, scope: SCOPE_A }, from([item('a.pdf', 'aaa')]), { rpc: leaky.rpc, signal: new AbortController().signal });
    expect(result.totals).toMatchObject({ uniqueNew: 1, existingDuplicates: 0 });
  });

  test('the kept copy of identical files is the first in source order, and entries keep that order', async () => {
    const ledger = tenantLedger({});
    const result = await inventory(
      { id: BATCH, scope: SCOPE_A },
      from([item('z-first.txt', 'same'), item('a-second.txt', 'same'), item('m-third.txt', 'other')]),
      { rpc: ledger.rpc, signal: new AbortController().signal },
    );
    expect(result.entries.map((e) => e.sourceKey)).toEqual(['z-first.txt', 'm-third.txt']);
    expect(ledger.skipped.map((j) => j.source_key)).toEqual(['a-second.txt']);
  });

  test('hashes are computed streaming: a 15 MB file is hashed in 64 KiB pieces as it is read, never gathered first', async () => {
    const CHUNK = 64 * 1024;
    const COUNT = 240;
    hashEvents.log = [];
    hashEvents.recording = true;
    const big: SourceItem = {
      sourceKey: 'big.bin',
      size: CHUNK * COUNT,
      ext: 'bin',
      async open() {
        return Readable.from(
          (async function* () {
            for (let i = 0; i < COUNT; i += 1) {
              hashEvents.log.push('produce');
              yield Buffer.alloc(CHUNK, i % 251);
            }
          })(),
        );
      },
    };
    const ledger = tenantLedger({});
    let result;
    try {
      result = await inventory({ id: BATCH, scope: SCOPE_A }, from([big]), { rpc: ledger.rpc, signal: new AbortController().signal });
    } finally {
      hashEvents.recording = false;
    }
    const expected = createHash('sha256');
    for (let i = 0; i < COUNT; i += 1) expected.update(Buffer.alloc(CHUNK, i % 251));
    expect(result.entries[0]?.fileSha256).toBe(expected.digest('hex'));

    const produced = hashEvents.log.filter((e) => e === 'produce').length;
    const updates = hashEvents.log.filter((e) => e === 'update').length;
    expect(produced).toBe(COUNT);
    expect(updates).toBe(COUNT);
    let producedSoFar = 0;
    let updatedSoFar = 0;
    let maxAhead = 0;
    for (const event of hashEvents.log) {
      if (event === 'produce') producedSoFar += 1;
      else updatedSoFar += 1;
      maxAhead = Math.max(maxAhead, producedSoFar - updatedSoFar);
    }
    expect(maxAhead).toBeLessThanOrEqual(4);
  });

  test('looks existing hashes up in chunks of 1,000 and records skipped rows in chunks of 1,000', async () => {
    const texts = Array.from({ length: 2_500 }, (_, i) => `doc-${i}`);
    const ledger = tenantLedger({ [TENANT_A]: texts.map(sha) });
    const result = await inventory({ id: BATCH, scope: SCOPE_A }, from(texts.map((t, i) => item(`f${i}.txt`, t))), {
      rpc: ledger.rpc,
      signal: new AbortController().signal,
    });
    expect(result.totals).toMatchObject({ total: 2_500, uniqueNew: 0, existingDuplicates: 2_500 });
    expect(ledger.calls.filter((c) => c.fn === 'rag_existing_file_hashes').map((c) => (c.args.p_hashes as string[]).length)).toEqual([1_000, 1_000, 500]);
    expect(ledger.calls.filter((c) => c.fn === 'rag_enqueue_backfill_jobs').map((c) => (c.args.p_jobs as unknown[]).length)).toEqual([1_000, 1_000, 500]);
    expect(ledger.skipped).toHaveLength(2_500);
  });

  test('an unreadable file is counted and skipped without stopping the inventory, and still reconciles', async () => {
    const failing: SourceItem = {
      ...item('broken.pdf', 'x'),
      async open() {
        throw new Error('EACCES /srv/customer-data/broken.pdf');
      },
    };
    const midStream: SourceItem = {
      ...item('cut.pdf', 'x'),
      async open() {
        return Readable.from(
          (async function* () {
            yield Buffer.from('partial');
            throw new Error('ECONNRESET /srv/customer-data/cut.pdf');
          })(),
        );
      },
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const ledger = tenantLedger({});
    const result = await inventory({ id: BATCH, scope: SCOPE_A }, from([item('ok.pdf', 'ok'), failing, midStream, item('ok2.pdf', 'ok2')]), {
      rpc: ledger.rpc,
      signal: new AbortController().signal,
    });
    expect(result.totals).toEqual({ total: 4, uniqueNew: 2, inInventoryDuplicates: 0, existingDuplicates: 0, unreadable: 2 });
    expect(result.entries.map((e) => e.sourceKey)).toEqual(['ok.pdf', 'ok2.pdf']);
    const logged = JSON.stringify([...warn.mock.calls, ...log.mock.calls]);
    expect(logged).not.toContain('customer-data');
    expect(logged).not.toContain('broken');
    warn.mockRestore();
    log.mockRestore();
  });

  test('logs carry counts and the [Backfill] prefix only, never a file name or content', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const ledger = tenantLedger({});
    await inventory(
      { id: BATCH, scope: SCOPE_A },
      from([item('confidential-contract.pdf', 'top secret clause'), item('copy-of-confidential-contract.pdf', 'top secret clause')]),
      { rpc: ledger.rpc, signal: new AbortController().signal },
    );
    const lines = [...warn.mock.calls, ...log.mock.calls];
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((c) => String(c[0]).startsWith('[Backfill]'))).toBe(true);
    const logged = JSON.stringify(lines);
    expect(logged).not.toContain('confidential');
    expect(logged).not.toContain('top secret');
    expect(logged).not.toContain(sha('top secret clause'));
    warn.mockRestore();
    log.mockRestore();
  });

  test('a failed lookup or enqueue rejects with a generic message; nothing is enqueued when the lookup fails', async () => {
    const failingLookup = fakeRpc({ ...batchRows, rag_existing_file_hashes: () => ({ data: null, error: { message: 'relation documents (tenant u:abc) exploded', code: 'XX000' } }) });
    await expect(
      inventory({ id: BATCH, scope: SCOPE_A }, from([item('a.pdf', 'a'), item('b.pdf', 'a')]), { rpc: failingLookup.rpc, signal: new AbortController().signal }),
    ).rejects.toThrow('[Backfill] existing hash lookup failed');
    expect(failingLookup.calls.some((c) => c.fn === 'rag_enqueue_backfill_jobs')).toBe(false);

    const failingEnqueue = fakeRpc({ ...batchRows, rag_enqueue_backfill_jobs: () => ({ data: null, error: { message: 'boom' } }) });
    await expect(
      inventory({ id: BATCH, scope: SCOPE_A }, from([item('a.pdf', 'a'), item('b.pdf', 'a')]), { rpc: failingEnqueue.rpc, signal: new AbortController().signal }),
    ).rejects.toThrow('[Backfill] skipped_duplicate enqueue failed');
  });

  test('an aborted signal stops the inventory before any lookup', async () => {
    const controller = new AbortController();
    const ledger = tenantLedger({});
    async function* aborting() {
      yield item('a.pdf', 'a');
      controller.abort();
      yield item('b.pdf', 'b');
    }
    await expect(inventory({ id: BATCH, scope: SCOPE_A }, aborting(), { rpc: ledger.rpc, signal: controller.signal })).rejects.toThrow();
    expect(ledger.calls.map((c) => c.fn)).toEqual(['rag_update_ingestion_batch']);
  });
});

describe('backfill inventory tenant binding', () => {
  /** The batch row lives in SQL with its own tenant; the lookup and the enqueue are answered per that tenant only. */
  function batchLedger(batchTenant: string | null, hashesByTenant: Record<string, string[]>) {
    const opened: string[] = [];
    const fake = fakeRpc({
      rag_update_ingestion_batch: () => (batchTenant === null ? { data: null, error: { message: 'backfill_refused: batch_not_found' } } : { data: { id: BATCH, tenant_key: batchTenant }, error: null }),
      rag_existing_file_hashes: (args) => {
        const known = new Set(hashesByTenant[String(args.p_tenant_key)] ?? []);
        return { data: (args.p_hashes as string[]).filter((h) => known.has(h)).map((h) => ({ file_sha256: h, tenant_key: args.p_tenant_key })), error: null };
      },
      rag_enqueue_backfill_jobs: () => ({ data: 1, error: null }),
    });
    const tracked = (key: string, text: string): SourceItem => {
      const base = item(key, text);
      return {
        ...base,
        async open(signal) {
          opened.push(key);
          return base.open(signal);
        },
      };
    };
    return { ...fake, opened, tracked };
  }

  test("a batch of tenant A run with tenant B's scope fails closed before any file is read, looked up or enqueued", async () => {
    const ledger = batchLedger(TENANT_A, { [TENANT_B]: [sha('shared-contract')] });
    await expect(
      inventory({ id: BATCH, scope: SCOPE_B }, from([ledger.tracked('shared.pdf', 'shared-contract')]), { rpc: ledger.rpc, signal: new AbortController().signal }),
    ).rejects.toThrow('[Backfill] batch tenant mismatch');
    expect(ledger.opened).toEqual([]);
    expect(ledger.calls.map((c) => c.fn)).not.toContain('rag_existing_file_hashes');
    expect(ledger.calls.map((c) => c.fn)).not.toContain('rag_enqueue_backfill_jobs');
  });

  test('the duplicate lookup carries the tenant stored on the batch row, never a caller string', async () => {
    const ledger = batchLedger(TENANT_A, { [TENANT_A]: [sha('mine')] });
    const result = await inventory({ id: BATCH, scope: SCOPE_A }, from([ledger.tracked('mine.pdf', 'mine'), ledger.tracked('new.pdf', 'new')]), {
      rpc: ledger.rpc,
      signal: new AbortController().signal,
    });
    expect(result.totals).toMatchObject({ uniqueNew: 1, existingDuplicates: 1 });
    const lookups = ledger.calls.filter((c) => c.fn === 'rag_existing_file_hashes');
    expect(lookups.length).toBeGreaterThan(0);
    expect(lookups.every((c) => c.args.p_tenant_key === TENANT_A)).toBe(true);
    expect(ledger.calls[0]?.fn).toBe('rag_update_ingestion_batch');
    expect(ledger.calls[0]?.args).toEqual({ p_batch_id: BATCH });
  });

  test('a missing batch, a failed batch lookup, an unminted scope and a case-variant tenant all fail closed', async () => {
    const signal = new AbortController().signal;
    const missing = batchLedger(null, {});
    await expect(inventory({ id: BATCH, scope: SCOPE_A }, from([missing.tracked('a.pdf', 'a')]), { rpc: missing.rpc, signal })).rejects.toThrow('[Backfill] batch lookup failed');
    expect(missing.opened).toEqual([]);

    const variant = batchLedger(TENANT_A.toUpperCase(), { [TENANT_A]: [sha('a')] });
    await expect(inventory({ id: BATCH, scope: SCOPE_A }, from([variant.tracked('a.pdf', 'a')]), { rpc: variant.rpc, signal })).rejects.toThrow('[Backfill] batch tenant mismatch');

    const fine = batchLedger(TENANT_A, {});
    await expect(
      inventory({ id: BATCH, scope: { kind: 'personal', userId: USER_A, organizationId: null } as never }, from([fine.tracked('a.pdf', 'a')]), { rpc: fine.rpc, signal }),
    ).rejects.toThrow('[Backfill] batch tenant mismatch');
    expect(fine.opened).toEqual([]);
    expect(fine.calls.filter((c) => c.fn !== 'rag_update_ingestion_batch')).toEqual([]);
  });
});

