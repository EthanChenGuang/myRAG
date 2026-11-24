import { mkdtemp, mkdir, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
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
    await writeFile(path.join(root, '..dots.txt'), 'dots');
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
    expect(items.map((i) => i.sourceKey)).toEqual(['..dots.txt', 'a.txt', 'nested/b.txt', 'nested/deeper/c.txt']);
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
    expect(items.map((i) => i.sourceKey)).toEqual(['..dots.txt', 'a.txt', 'nested/b.txt', 'nested/deeper/c.txt']);
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
    const { items, reasons } = await drain({ kind: 'manifest', ref, deps });
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
    const { items, reasons } = await drain({ kind: 'manifest', ref, deps });
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

  test('paths are confined to the manifest directory: ../ segments, absolute paths, outside symlinks and missing files are refused', async () => {
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
    const { items, reasons } = await drain({ kind: 'manifest', ref, deps: netDeps().deps });
    expect(items.map((i) => i.sourceKey)).toEqual(['fine']);
    expect(reasons).toEqual(['outside_root', 'outside_root', 'outside_root', 'outside_root', 'path_unreadable', 'path_unreadable']);
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
    const { items, reasons } = await drain({ kind: 'manifest', ref, deps });
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
    const { items, reasons } = await drain({ kind: 'manifest', ref, deps });
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
    const { items, reasons } = await drain({ kind: 'manifest', ref, deps });
    expect(items.map((i) => i.sourceKey)).toEqual(['exact']);
    expect(items[0]?.size).toBe(ORIGINALS_MAX_BYTES);
    expect(reasons).toEqual(['too_large', 'too_large', 'manifest_fetch_failed', 'manifest_fetch_failed']);
    expect(cancelled).toBe(true);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('/private/path');
    warn.mockRestore();
  });
});

describe('listSource bucket', () => {
  function bucketOf(tree: Record<string, Array<{ name: string; id: string | null; size?: number }>>) {
    const lists: Array<{ prefix: string; offset: number }> = [];
    const download = vi.fn(async (objectPath: string) => ({ data: new Blob([`bytes of ${objectPath}`]), error: null }));
    const bucket: BackfillStorageBucket = {
      list: async (prefix, options) => {
        lists.push({ prefix, offset: options?.offset ?? 0 });
        const rows = tree[prefix] ?? [];
        const offset = options?.offset ?? 0;
        const limit = options?.limit ?? 100;
        return {
          data: rows.slice(offset, offset + limit).map((r) => ({ name: r.name, id: r.id, metadata: r.id === null ? null : { size: r.size ?? 10 } })),
          error: null,
        };
      },
      download,
    };
    const from = vi.fn(() => bucket);
    return { deps: { storage: { from } } satisfies BackfillSourceDeps, lists, download, from };
  }

  test('lists nested prefixes and every page without downloading anything', async () => {
    const many = Array.from({ length: 1_500 }, (_, i) => ({ name: `f${String(i).padStart(4, '0')}.pdf`, id: `id-${i}` }));
    const { deps, lists, download, from } = bucketOf({
      '': [{ name: 'folder', id: null }, ...many],
      folder: [{ name: 'inner.txt', id: 'id-inner' }, { name: 'deeper', id: null }],
      'folder/deeper': [{ name: 'leaf.md', id: 'id-leaf' }],
    });
    const { items } = await drain({ kind: 'bucket', ref: 'fixture-bucket', deps });
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

  test('refuses buckets that hold other tenants\' files, invalid names, a missing client and list errors', async () => {
    const { deps } = bucketOf({ '': [] });
    for (const ref of ['rag-originals', 'chat-images', '', 'UPPER', '../x', 'a/b', 'x']) {
      await expect(drain({ kind: 'bucket', ref, deps })).rejects.toMatchObject({ name: 'SourceRejection' });
    }
    await expect(drain({ kind: 'bucket', ref: 'fixture-bucket' })).rejects.toMatchObject({ reason: 'bucket_storage_unavailable' });
    const failing: BackfillSourceDeps = {
      storage: { from: () => ({ list: async () => ({ data: null, error: { message: 'boom' } }), download: vi.fn() }) },
    };
    await expect(drain({ kind: 'bucket', ref: 'fixture-bucket', deps: failing })).rejects.toMatchObject({ reason: 'bucket_list_failed' });
  });

  test('an object over the size limit is refused', async () => {
    const { deps } = bucketOf({
      '': [
        { name: 'small.pdf', id: 'a', size: 10 },
        { name: 'huge.pdf', id: 'b', size: ORIGINALS_MAX_BYTES + 1 },
      ],
    });
    const { items, reasons } = await drain({ kind: 'bucket', ref: 'fixture-bucket', deps });
    expect(items.map((i) => i.sourceKey)).toEqual(['small.pdf']);
    expect(reasons).toEqual(['too_large']);
  });
});
