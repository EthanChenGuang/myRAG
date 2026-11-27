import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkUploadAccess, parseUploadAccessField } from '@/lib/rag/access/upload';
import { mintAccessScope } from '@/lib/rag/tenant/access';
import { mintScope, withAccess, type TenantScope } from '@/lib/rag/tenant/scope';
import { queuedInputRecordOf } from '@/lib/rag/ingest/enqueue';
import { decodeQueuedInput, encodeQueuedInput } from '@/lib/rag/ingest/queued-context';
import { buildJobSettings } from '@/lib/rag/ingest/routing/settings-snapshot';
import { loadRoutingConfig } from '@/lib/rag/ingest/routing/config';
import { loadQueueConfig } from '@/lib/rag/ingest/queue-config';
import { profileFor } from '@/lib/rag/ingest/profiles/load';
import { emptyIngestState, type IngestInput, type StageContext } from '@/lib/rag/ingest/types';
import { main as backfillMain, parseBackfillArgs } from '@/lib/rag/ingest/backfill/cli';

// Phase 4.3 plan 23 (SEC-12, D-16): the upload access field, its route checks, the queued record, the backfill flag and the Config UI
// proxy forwarding. Neutral placeholder ids only.

const USER = '00000000-0000-4000-8000-0000000231a1';
const GROUP_A = '00000000-0000-4000-8000-0000000231f1';
const GROUP_B = '00000000-0000-4000-8000-0000000231f2';

const base = (): TenantScope => mintScope('single', null, null);
const memberOf = (...groups: string[]): TenantScope =>
  withAccess(base(), mintAccessScope('keys', ['all', `u:${USER}`, ...groups.map((id) => `g:${id}`)]));

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseUploadAccessField', () => {
  it('reads absent, null and empty as untouched', () => {
    for (const raw of [undefined, null, '']) expect(parseUploadAccessField(raw)).toEqual({ ok: true, choice: null });
  });

  it('reads everyone and group ids from a form string or a JSON body object', () => {
    expect(parseUploadAccessField('{"everyone":true}')).toEqual({ ok: true, choice: { everyone: true } });
    expect(parseUploadAccessField({ groupIds: [GROUP_A.toUpperCase()] })).toEqual({ ok: true, choice: { groupIds: [GROUP_A] } });
  });

  it('never accepts principal keys, other properties, too many groups or a file', () => {
    for (const raw of [
      '{"groupIds":["g:00000000-0000-4000-8000-0000000231f1"]}',
      '{"groupIds":["all"]}',
      '{"keys":["all"]}',
      '{"everyone":true,"groupIds":[]}',
      '{"everyone":false}',
      '{"groupIds":[]}',
      JSON.stringify({ groupIds: Array.from({ length: 51 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`) }),
      'not json',
      '["all"]',
      new Blob(['{"everyone":true}']),
    ]) {
      expect(parseUploadAccessField(raw)).toEqual({ ok: false });
    }
  });
});

describe('checkUploadAccess', () => {
  const resolveAs = (scope: TenantScope | null) =>
    vi.fn(async () => (scope ? { ok: true as const, scope } : { ok: false as const, status: 503 as const, reason: 'access_lookup_failed' as const }));

  it('untouched and everyone need no lookup', async () => {
    const resolve = resolveAs(memberOf());
    const signal = new AbortController().signal;
    expect(await checkUploadAccess({ scope: base(), raw: null, uploaderId: USER, signal, resolve })).toEqual({ ok: true, keys: null });
    expect(await checkUploadAccess({ scope: base(), raw: '{"everyone":true}', uploaderId: USER, signal, resolve })).toEqual({ ok: true, keys: ['all'] });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('a member may name only their own groups; an admin any group', async () => {
    const signal = new AbortController().signal;
    const raw = JSON.stringify({ groupIds: [GROUP_B, GROUP_A] });
    const member = resolveAs(memberOf(GROUP_A));
    expect(await checkUploadAccess({ scope: base(), raw, uploaderId: USER, signal, resolve: member })).toEqual({
      ok: false,
      status: 400,
      error: 'group_not_allowed',
    });
    expect(member).toHaveBeenCalledWith(expect.objectContaining({ identity: { kind: 'user', userId: USER } }));
    const both = resolveAs(memberOf(GROUP_A, GROUP_B));
    expect(await checkUploadAccess({ scope: base(), raw, uploaderId: USER, signal, resolve: both })).toEqual({
      ok: true,
      keys: [`g:${GROUP_A}`, `g:${GROUP_B}`],
    });
    const admin = resolveAs(withAccess(base(), mintAccessScope('admin_all', [])));
    expect(await checkUploadAccess({ scope: base(), raw, uploaderId: USER, signal, resolve: admin })).toEqual({
      ok: true,
      keys: [`g:${GROUP_A}`, `g:${GROUP_B}`],
    });
  });

  it('with the switch off a group choice is refused; a malformed field is invalid_access; a failed lookup is 503', async () => {
    const signal = new AbortController().signal;
    const raw = JSON.stringify({ groupIds: [GROUP_A] });
    const off = resolveAs(withAccess(base(), mintAccessScope('off', [])));
    expect(await checkUploadAccess({ scope: base(), raw, uploaderId: USER, signal, resolve: off })).toMatchObject({ error: 'group_not_allowed' });
    expect(await checkUploadAccess({ scope: base(), raw: '{"keys":["all"]}', uploaderId: USER, signal, resolve: off })).toEqual({
      ok: false,
      status: 400,
      error: 'invalid_access',
    });
    expect(await checkUploadAccess({ scope: base(), raw, uploaderId: USER, signal, resolve: resolveAs(null) })).toEqual({
      ok: false,
      status: 503,
      error: 'access_unavailable',
    });
  });
});

describe('queued path keeps the label', () => {
  const input = (accessKeys?: string[]): IngestInput => ({
    scope: base(),
    source: 'chat_upload',
    sourceKey: 'chat_upload/neutral.md',
    filename: 'neutral.md',
    mimeType: 'text/markdown',
    text: 'A neutral synthetic sentence.',
    signal: new AbortController().signal,
    ...(accessKeys ? { accessKeys } : {}),
  });
  const ctx = { state: emptyIngestState() } as unknown as StageContext;

  it('the queued-input record carries accessKeys and decodes them; untouched carries none', () => {
    const record = queuedInputRecordOf(input([`g:${GROUP_A}`]), ctx);
    expect(record.accessKeys).toEqual([`g:${GROUP_A}`]);
    expect(decodeQueuedInput(encodeQueuedInput(record))?.accessKeys).toEqual([`g:${GROUP_A}`]);
    expect('accessKeys' in queuedInputRecordOf(input(), ctx)).toBe(false);
  });

  it('a record with a malformed key is not decoded', () => {
    const record = { ...queuedInputRecordOf(input(), ctx), accessKeys: ['g:not-a-group'] };
    expect(decodeQueuedInput(encodeQueuedInput(record))).toBeNull();
  });

  it('a backfill job snapshot carries the batch label only when one is given', () => {
    const common = {
      queueConfig: loadQueueConfig({}),
      profile: profileFor('config_upload', 'general'),
      bounds: { min_tier: null, max_tier: null },
      routingConfig: loadRoutingConfig(),
      isBackfill: true,
    } as unknown as Parameters<typeof buildJobSettings>[0];
    expect(buildJobSettings({ ...common, accessKeys: [`g:${GROUP_A}`] }).access_keys).toEqual([`g:${GROUP_A}`]);
    expect('access_keys' in buildJobSettings(common)).toBe(false);
  });
});

describe('npm run rag:backfill -- --access-groups', () => {
  it('parses group keys for a new batch and refuses them on resume or when malformed', () => {
    const parsed = parseBackfillArgs(['--tenant', 's:default', '--source', 'folder:docs', '--access-groups', 'group-b, group-a']);
    expect(parsed).toMatchObject({ ok: true, accessGroups: ['group-a', 'group-b'] });
    expect(parseBackfillArgs(['--tenant', 's:default', '--source', 'folder:docs'])).toMatchObject({ ok: true, accessGroups: null });
    expect(parseBackfillArgs(['--tenant', 's:default', '--resume', GROUP_A, '--access-groups', 'group-a'])).toMatchObject({ ok: false });
    expect(parseBackfillArgs(['--tenant', 's:default', '--source', 'folder:docs', '--access-groups', 'g:abc'])).toMatchObject({ ok: false });
    expect(parseBackfillArgs(['--tenant', 's:default', '--source', 'folder:docs', '--access-groups', 'all'])).toMatchObject({ ok: false });
  });

  it('an unknown group key ends with exit 2 naming the key, before any batch', async () => {
    const rpcCalls: string[] = [];
    const rpc = {
      rpc: (fn: string, args: Record<string, unknown>) => {
        rpcCalls.push(fn);
        const rows = fn === 'rag_access_group_by_key' && args.p_key === 'group-a' ? [{ id: GROUP_A, name: 'Group A', labels_current: false }] : [];
        return { abortSignal: async () => ({ data: rows, error: null }) };
      },
    };
    const err: string[] = [];
    const io = { out: () => undefined, err: (line: string) => err.push(line) };
    const code = await backfillMain(
      ['--tenant', 's:default', '--source', 'folder:docs', '--access-groups', 'group-a,group-missing'],
      io,
      new AbortController().signal,
      { rpc: rpc as never, resolveScope: async () => ({ ok: true, scope: base() }) as never },
    );
    expect(code).toBe(2);
    expect(err.join('\n')).toContain('group-missing');
    expect(rpcCalls.every((fn) => fn === 'rag_access_group_by_key')).toBe(true);
  });
});

describe('upload route refuses a group the caller may not assign before storing anything', () => {
  const uploads: string[] = [];
  const submitted: IngestInput[] = [];

  function admin() {
    return {
      from: () => {
        const query = {
          select: () => query,
          order: () => query,
          limit: () => query,
          abortSignal: () => query,
          eq: () => query,
          maybeSingle: async () => ({ data: { read_only_doc_dashboard: false }, error: null }),
        };
        return query;
      },
      storage: { from: () => ({ upload: async (p: string) => (uploads.push(p), { data: { path: p }, error: null }) }) },
    };
  }

  async function post(fields: Record<string, string>) {
    vi.resetModules();
    vi.stubEnv('RAG_INGEST_PIPELINE', 'unified');
    vi.stubEnv('RAG_INGEST_ASYNC', 'on');
    vi.stubEnv('RAG_DOC_ACCESS_GROUPS', 'off');
    vi.doMock('@/lib/deployment-mode', () => ({ isSingleTenant: () => true, isMultiTenant: () => false, getDeploymentMode: () => 'single-tenant' }));
    vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: USER } } }) } }) }));
    vi.doMock('@/lib/supabase', () => ({ supabaseAdmin: admin(), getSupabaseAdmin: () => admin() }));
    vi.doMock('@/lib/document-processor', () => ({ processImageDocument: async () => undefined }));
    vi.doMock('@/lib/rag', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/lib/rag')>();
      return {
        ...actual,
        currentIngestConfig: () => ({ pipeline: 'unified' }),
        queueConfigFromProcessEnv: () => ({ ...actual.queueConfigFromProcessEnv(), ingestAsync: true }),
        scheduleIngestWake: () => undefined,
        submitIngest: async (input: IngestInput) => {
          submitted.push(input);
          return { jobId: GROUP_B, documentId: GROUP_B, status: 'queued' };
        },
        // Minted by the freshly loaded scope module, which is the one the route checks scopes against.
        resolveTenantScope: async () => ({ ok: true, scope: (await import('@/lib/rag/tenant/scope')).mintScope('single', null, null) }),
        repairOwnerMembership: async () => undefined,
      };
    });
    const { POST } = await import('@/app/api/upload/route');
    const { NextRequest } = await import('next/server');
    const form = new FormData();
    form.append('files', new File([new Uint8Array([137, 80, 78, 71, 1, 2])], 'picture.png', { type: 'image/png' }));
    form.append('process_rag', 'true');
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    return POST(new NextRequest('http://localhost/api/upload', { method: 'POST', body: form }));
  }

  beforeEach(() => {
    uploads.length = 0;
    submitted.length = 0;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const id of ['@/lib/deployment-mode', '@/lib/supabase/server', '@/lib/supabase', '@/lib/document-processor', '@/lib/rag']) vi.doUnmock(id);
  });

  it('a group choice with the switch off answers 400 group_not_allowed and stores nothing', async () => {
    const res = await post({ access: JSON.stringify({ groupIds: [GROUP_A] }) });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'group_not_allowed' });
    expect(uploads).toEqual([]);
    expect(submitted).toEqual([]);
  });

  it('a principal key in the field answers 400 invalid_access', async () => {
    const res = await post({ access: JSON.stringify({ groupIds: [`g:${GROUP_A}`] }) });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_access' });
    expect(uploads).toEqual([]);
  });

  it('everyone reaches the queued ingest as accessKeys all; no field leaves the input untouched', async () => {
    expect((await post({ access: '{"everyone":true}' })).status).toBe(202);
    expect(submitted[0]?.accessKeys).toEqual(['all']);
    expect((await post({})).status).toBe(202);
    expect(submitted[1] && 'accessKeys' in submitted[1]).toBe(false);
  });
});

describe('Config UI proxies forward the access field unchanged', () => {
  const require = createRequire(import.meta.url);
  let root: string;
  let server: http.Server;
  let fake: http.Server;
  let port: number;
  const seen: Array<{ url: string; body: string }> = [];

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'myrag-config-access-'));
    fs.mkdirSync(path.join(root, 'public'), { recursive: true });
    fs.writeFileSync(path.join(root, '.env.local'), 'NEXT_PUBLIC_APP_NAME=Demo\n');
    fake = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        seen.push({ url: req.url ?? '', body: Buffer.concat(chunks).toString('utf8') });
        res.setHeader('Content-Type', 'application/json');
        res.end('{"success":true}');
      });
    });
    await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
    process.env.MYRAG_CONFIG_ROOT = root;
    process.env.MYRAG_APP_URL = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
    server = (require('../../../scripts/config-server.js') as { server: http.Server }).server;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => fake.close(resolve));
    delete process.env.MYRAG_CONFIG_ROOT;
    delete process.env.MYRAG_APP_URL;
  });

  async function send(route: string, fileField: string, access?: string) {
    const form = new FormData();
    form.append(fileField, new Blob(['A neutral synthetic sentence.'], { type: 'text/plain' }), 'neutral.txt');
    if (access !== undefined) form.append('access', access);
    const origin = `http://127.0.0.1:${port}`;
    return fetch(`${origin}${route}`, { method: 'POST', body: form, headers: { Origin: origin, 'X-Config-UI': '1' } });
  }

  const accessPart = (body: string): string | null => {
    const match = /name="access"\r\n\r\n([^\r]*)\r\n/.exec(body);
    return match ? match[1]! : null;
  };

  for (const [route, fileField] of [
    ['/api/upload', 'files'],
    ['/api/process-document', 'file'],
  ] as const) {
    it(`${route}: the field is forwarded as sent, and nothing is added without it`, async () => {
      const value = JSON.stringify({ groupIds: [GROUP_A] });
      seen.length = 0;
      expect((await send(route, fileField, value)).status).toBe(200);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.url).toBe(route);
      expect(accessPart(seen[0]!.body)).toBe(value);
      seen.length = 0;
      expect((await send(route, fileField)).status).toBe(200);
      expect(seen[0]!.body).not.toContain('name="access"');
    });
  }
});

describe('legacy writers take the label in their insert (RESEARCH Pitfall 7)', () => {
  type Row = Record<string, unknown>;
  const inserts: Array<{ table: string; rows: Row[] }> = [];
  const legacy = { allowGroups: false, parses: 0 };

  function writeAdmin() {
    return {
      storage: { from: () => ({ upload: async () => ({ data: null, error: null }), getPublicUrl: () => ({ data: { publicUrl: '' } }) }) },
      from(table: string) {
        const builder = {
          eq: () => builder,
          order: () => builder,
          limit: () => builder,
          abortSignal: () => builder,
          maybeSingle: () =>
            Promise.resolve({ data: table === 'admin_settings' ? { read_only_doc_dashboard: false } : table === 'admin_users' ? { id: USER } : null, error: null }),
          insert(rows: Row[] | Row) {
            inserts.push({ table, rows: Array.isArray(rows) ? rows : [rows] });
            return builder;
          },
          select: () => builder,
          single: () => Promise.resolve({ data: inserts.at(-1)?.rows[0] ?? null, error: null }),
          then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
            Promise.resolve({ data: null, error: null }).then(onFulfilled, onRejected),
        };
        return builder;
      },
    };
  }

  async function mockCommon() {
    vi.resetModules();
    vi.stubEnv('RAG_INGEST_PIPELINE', 'legacy');
    vi.stubEnv('RAG_DOC_ACCESS_GROUPS', 'off');
    vi.doMock('@/lib/deployment-mode', () => ({ isSingleTenant: () => true, isMultiTenant: () => false, getDeploymentMode: () => 'single-tenant' }));
    vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) } }) }));
    vi.doMock('@supabase/supabase-js', () => ({ createClient: () => writeAdmin() }));
    vi.doMock('@/lib/supabase', () => ({ supabaseAdmin: writeAdmin(), getSupabaseAdmin: () => writeAdmin() }));
    vi.doMock('openai', () => ({
      default: class FakeOpenAI {
        chat = { completions: { create: async () => ({ choices: [{ message: { content: 'Neutral Title' } }] }) } };
      },
    }));
    vi.doMock('@/lib/rag', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/lib/rag')>();
      return {
        ...actual,
        embedText: async () => Array.from({ length: 1536 }, () => 0.01),
        resolveTenantScope: async () => ({ ok: true, scope: (await import('@/lib/rag/tenant/scope')).mintScope('single', null, null) }),
        repairOwnerMembership: async () => undefined,
        assertCloudAllowed: () => {
          legacy.parses += 1;
          return { ok: false };
        },
        // A member of GROUP_A, as resolveAccessScope would report with the switch on.
        checkUploadAccess: async (input: Parameters<typeof actual.checkUploadAccess>[0]) => {
          if (!legacy.allowGroups) return actual.checkUploadAccess(input);
          const { mintAccessScope: mintAccess } = await import('@/lib/rag/tenant/access');
          const { withAccess: attach } = await import('@/lib/rag/tenant/scope');
          return actual.checkUploadAccess({
            ...input,
            resolve: async () => ({ ok: true, scope: attach(input.scope, mintAccess('keys', ['all', `u:${USER}`, `g:${GROUP_A}`])) }),
          });
        },
      };
    });
  }

  beforeEach(() => {
    inserts.length = 0;
    legacy.allowGroups = false;
    legacy.parses = 0;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const id of ['@/lib/deployment-mode', '@/lib/supabase/server', '@supabase/supabase-js', '@/lib/supabase', 'openai', '@/lib/rag']) vi.doUnmock(id);
  });

  const aiToRag = async (body: Record<string, unknown>) => {
    await mockCommon();
    const { POST } = await import('@/app/api/ai-to-rag/route');
    return POST(
      new Request('http://localhost/api/ai-to-rag', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'A neutral synthetic paragraph.\n\nAnother neutral paragraph.', messageId: 'message-1', chatId: 'chat-1', ...body }),
      }),
    );
  };

  const documentInserts = () => inserts.filter((insert) => insert.table === 'documents').flatMap((insert) => insert.rows);

  it('ai-to-rag: a group label is in the document insert itself', async () => {
    legacy.allowGroups = true;
    const res = await aiToRag({ access: { groupIds: [GROUP_A] } });
    expect(res.status).toBe(200);
    expect(documentInserts()).toHaveLength(1);
    expect(documentInserts()[0]?.access_groups).toEqual([`g:${GROUP_A}`]);
  });

  it('ai-to-rag: a group the caller may not assign answers 400 and inserts nothing; no field inserts no label', async () => {
    const refused = await aiToRag({ access: { groupIds: [GROUP_A] } });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: 'group_not_allowed' });
    expect(inserts).toEqual([]);
    const plain = await aiToRag({});
    expect(plain.status).toBe(200);
    expect(documentInserts()).toHaveLength(1);
    expect('access_groups' in (documentInserts()[0] ?? {})).toBe(false);
  });

  it('storeDocument: the label goes in the document insert as a column, never into metadata; a malformed one inserts nothing', async () => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:1');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'placeholder-anon');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'placeholder-service');
    vi.doMock('@supabase/supabase-js', () => ({ createClient: () => writeAdmin() }));
    const { storeDocument } = await vi.importActual<typeof import('@/lib/supabase')>('@/lib/supabase');
    const chunk = { content: 'A neutral synthetic sentence.', embedding: [0.1, 0.2] };
    await storeDocument('neutral.md', 'A neutral synthetic sentence.', [chunk], { user_id: USER, access_groups: [`u:${USER}`] });
    const doc = documentInserts()[0]!;
    expect(doc.access_groups).toEqual([`u:${USER}`]);
    expect((doc.metadata as Row).access_groups).toBeUndefined();
    const chunkRow = inserts.find((insert) => insert.table === 'document_chunks')!.rows[0]!;
    expect((chunkRow.metadata as Row).access_groups).toBeUndefined();
    inserts.length = 0;
    await storeDocument('plain.md', 'A neutral synthetic sentence.', [chunk], { user_id: USER });
    expect('access_groups' in documentInserts()[0]!).toBe(false);
    inserts.length = 0;
    await expect(storeDocument('bad.md', 'x', [chunk], { user_id: USER, access_groups: ['g:not-a-group'] })).rejects.toThrow();
    expect(inserts).toEqual([]);
  });

  it('process-document legacy: a refused group answers 400 before any parse or insert', async () => {
    await mockCommon();
    const { POST } = await import('@/app/api/process-document/route');
    const form = new FormData();
    form.append('file', new File(['A neutral synthetic sentence.'], 'neutral.pdf', { type: 'application/pdf' }));
    form.append('access', JSON.stringify({ groupIds: [GROUP_A] }));
    const res = await POST(new Request('http://localhost/api/process-document', { method: 'POST', body: form }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'group_not_allowed' });
    expect(legacy.parses).toBe(0);
    expect(inserts).toEqual([]);
  });
});
