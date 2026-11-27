import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const OWNER = '00000000-0000-4000-8000-0000000000a1';
const MEMBER_A = '00000000-0000-4000-8000-0000000000a2';
const OUTSIDER = '00000000-0000-4000-8000-0000000000a3';
const GROUP_A = '00000000-0000-4000-8000-0000000000f1';
const CHAT = '00000000-0000-4000-8000-0000000000c1';
const DOC_OPEN = '00000000-0000-4000-8000-00000000d001';
const DOC_RESTRICTED = '00000000-0000-4000-8000-00000000d002';
const DOC_OLD = '00000000-0000-4000-8000-00000000d003';
const DOC_NEW = '00000000-0000-4000-8000-00000000d004';
const DOC_IMAGE = '00000000-0000-4000-8000-00000000d005';
const SHARE_ID = '00000000-0000-4000-8000-0000000000e1';
const UNKNOWN_SHARE = '00000000-0000-4000-8000-0000000000e9';
const IMAGE_URL = 'https://storage.example.org/chat-images/image-a.png';
const MEMBER_TOKEN = 'member-token-placeholder';
const OUTSIDER_TOKEN = 'outsider-token-placeholder';
const env = process.env as Record<string, string | undefined>;
const ENV_NAMES = ['NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE', 'RAG_DOC_ACCESS_GROUPS'] as const;

type Row = Record<string, unknown>;
type Filter = [op: 'eq' | 'in' | 'is', column: string, value: unknown];

const h = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  memberships: new Map<string, string[]>(),
  tokens: new Map<string, string>(),
  cookieUser: null as string | null,
  shareUser: null as string | null,
  failTable: null as string | null,
  reads: [] as string[],
}));

function read(row: Row, column: string): unknown {
  if (column.includes('->>')) {
    const [base, key] = column.split('->>');
    const value = row[base];
    return value && typeof value === 'object' ? (value as Row)[key] : undefined;
  }
  return row[column];
}

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every(([op, column, value]) => {
    if (op === 'in') return (value as unknown[]).includes(read(row, column));
    if (op === 'is') return (read(row, column) ?? null) === value;
    return read(row, column) === value;
  });
}

function table(name: string) {
  h.tables[name] ??= [];
  const rows = h.tables[name];
  const filters: Filter[] = [];
  let update: Row | null = null;
  const run = () => {
    h.reads.push(name);
    if (h.failTable === name) return { data: null, error: { code: 'XX000', message: 'down' } };
    if (update) {
      rows.filter((row) => matches(row, filters)).forEach((row) => Object.assign(row, update));
      return { data: null, error: null };
    }
    return { data: rows.filter((row) => matches(row, filters)).map((row) => ({ ...row })), error: null };
  };
  const builder: Record<string, unknown> = {
    select: () => builder,
    abortSignal: () => builder,
    order: () => builder,
    update(next: Row) {
      update = next;
      return builder;
    },
    eq(column: string, value: unknown) {
      filters.push(['eq', column, value]);
      return builder;
    },
    in(column: string, value: unknown[]) {
      filters.push(['in', column, value]);
      return builder;
    },
    is(column: string, value: unknown) {
      filters.push(['is', column, value]);
      return builder;
    },
    single: async () => {
      const result = run();
      const data = Array.isArray(result.data) && result.data.length === 1 ? result.data[0] : null;
      return result.error ? result : data ? { data, error: null } : { data: null, error: { code: 'PGRST116', message: 'none' } };
    },
    maybeSingle: async () => {
      const result = run();
      return result.error ? result : { data: Array.isArray(result.data) ? (result.data[0] ?? null) : null, error: null };
    },
    then: (ok: (value: unknown) => unknown, bad?: (reason: unknown) => unknown) => Promise.resolve(run()).then(ok, bad),
  };
  return builder;
}

function rpcRequest(respond: () => unknown) {
  const request = {
    abortSignal: () => request,
    then: (ok: (value: unknown) => unknown, bad?: (reason: unknown) => unknown) => Promise.resolve().then(respond).then(ok, bad),
  };
  return request;
}

const admin = {
  from: (name: string) => table(name),
  rpc(fn: string, args: Row) {
    return rpcRequest(() => {
      if (fn === 'rag_resolve_access_scope') {
        const groups = h.memberships.get(String(args.p_user_id)) ?? [];
        return { data: [{ is_admin: false, group_ids: groups, effective_keys: ['all', ...groups.map((id) => `g:${id}`)] }], error: null };
      }
      if (fn === 'rag_documents_visible') {
        const keys = (args.p_access_keys as string[] | undefined) ?? [];
        const ids = (args.p_document_ids as string[]).map((id) => id.toLowerCase());
        const visible = (h.tables.documents ?? []).filter(
          (doc) =>
            ids.includes(String(doc.id)) &&
            doc.tenant_key === args.p_tenant_key &&
            (args.p_access_all === true || (doc.access_groups as string[]).some((key) => keys.includes(key))),
        );
        return { data: visible.map((doc) => doc.id), error: null };
      }
      return { data: [], error: null };
    });
  },
  auth: {
    getUser: async (token: string) => {
      const id = h.tokens.get(token);
      return id ? { data: { user: { id } }, error: null } : { data: { user: null }, error: { message: 'invalid token' } };
    },
  },
};

vi.mock('@/lib/supabase', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/supabase')>()),
  getSupabaseAdmin: () => admin,
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: h.cookieUser ? { id: h.cookieUser } : null }, error: null }) },
  }),
}));
vi.mock('@supabase/supabase-js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@supabase/supabase-js')>()),
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: h.shareUser ? { id: h.shareUser } : null }, error: h.shareUser ? null : { message: 'none' } }) },
    from: (name: string) => table(name),
  }),
}));
vi.mock('@/lib/rag/tenant/access-startup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rag/tenant/access-startup')>()),
  accessReadyForResolve: async () => true,
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('@/app/shared/[shareId]/shared-chat-content', () => ({ SharedChatContent: () => null }));

function doc(id: string, groups: string[], extra: Row = {}): Row {
  return { id, lineage_id: id, tenant_key: 's:default', access_groups: groups, is_current: true, status: 'ready', ...extra };
}

function citing(documentId: string): Row {
  return {
    id: 'm2',
    role: 'assistant',
    content: 'A synthetic answer.',
    metadata: { citations: [{ alias: 'S1', documentId, documentName: 'document-a.pdf', chunkIds: ['c1'] }] },
  };
}

function chatRow(messages: Row[], shared = false): Row {
  return {
    id: CHAT,
    user_id: OWNER,
    title: 'Synthetic chat title',
    messages: [{ id: 'm1', role: 'user', content: 'A synthetic question.' }, ...messages],
    shared,
    share_id: shared ? SHARE_ID : null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

function seed(messages: Row[], options: { shared?: boolean } = {}): void {
  h.tables.chats = [chatRow(messages, options.shared ?? false)];
}

async function share(): Promise<{ status: number; body: Row }> {
  const { POST } = await import('@/app/api/chats/share/route');
  const response = await POST(
    new Request('http://localhost/api/chats/share', {
      method: 'POST',
      headers: { authorization: 'Bearer owner-token-placeholder', 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: CHAT }),
    }),
  );
  return { status: response.status, body: (await response.json()) as Row };
}

async function readShared(shareId = SHARE_ID, headers: Record<string, string> = {}): Promise<{ status: number; body: Row }> {
  const { GET } = await import('@/app/api/chats/[shareId]/route');
  const response = await GET(new NextRequest(`http://localhost/api/chats/${shareId}`, { headers }));
  return { status: response.status, body: (await response.json()) as Row };
}

async function renderPage(shareId = SHARE_ID): Promise<{ notFound: boolean; title: unknown; chatTitle: unknown }> {
  const page = await import('@/app/shared/[shareId]/page');
  const metadata = await page.generateMetadata({ params: Promise.resolve({ shareId }) });
  try {
    const element = (await page.default({ params: Promise.resolve({ shareId }) })) as { props: { chat: { title: string } } };
    return { notFound: false, title: metadata.title, chatTitle: element.props.chat.title };
  } catch (error) {
    if (error instanceof Error && error.message === 'NEXT_NOT_FOUND') return { notFound: true, title: metadata.title, chatTitle: null };
    throw error;
  }
}

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_NAMES.map((name) => [name, env[name]]));
  env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'single-tenant';
  env.RAG_DOC_ACCESS_GROUPS = 'on';
  h.tables = {
    documents: [
      doc(DOC_OPEN, ['all']),
      doc(DOC_RESTRICTED, [`g:${GROUP_A}`]),
      doc(DOC_OLD, [`g:${GROUP_A}`], { lineage_id: DOC_OLD, is_current: false }),
      doc(DOC_NEW, ['all'], { lineage_id: DOC_OLD }),
      doc(DOC_IMAGE, [`g:${GROUP_A}`]),
    ],
    document_chunks: [{ id: 'chunk-image', document_id: DOC_IMAGE, metadata: { image_url: IMAGE_URL } }],
    rag_answer_records: [],
  };
  h.memberships = new Map([[MEMBER_A, [GROUP_A]]]);
  h.tokens = new Map([
    [MEMBER_TOKEN, MEMBER_A],
    [OUTSIDER_TOKEN, OUTSIDER],
  ]);
  h.cookieUser = null;
  h.shareUser = OWNER;
  h.failTable = null;
  h.reads = [];
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  for (const name of ENV_NAMES) {
    if (saved[name] === undefined) delete env[name];
    else env[name] = saved[name];
  }
  vi.restoreAllMocks();
});

describe('citedDocumentIds', () => {
  it('collects citation metadata, used documents, document references, source images and answer-record citations', async () => {
    const { citedDocumentIds } = await import('@/lib/chat-share-access');
    const refs = citedDocumentIds(
      [
        citing(DOC_OPEN),
        { id: 'm3', role: 'assistant', content: [{ type: 'metadata', usedDocuments: [{ id: DOC_RESTRICTED.toUpperCase(), name: 'a' }] }] },
        { id: 'm4', role: 'assistant', content: [{ type: 'document_reference', documents: [{ id: DOC_OLD, name: 'b' }] }] },
        { id: 'm5', role: 'assistant', content: [{ type: 'source_images', source_images: [{ name: 'i', size: 1, type: 'image/png', url: IMAGE_URL }] }] },
        { id: 'm6', role: 'assistant', content: 'no metadata', metadata: { usedDocuments: [{ id: 'not-a-uuid' }] } },
      ],
      [[{ documentId: DOC_NEW, alsoIn: [{ documentId: DOC_IMAGE }] }]],
    );
    expect(new Set(refs.documentIds)).toEqual(new Set([DOC_OPEN, DOC_RESTRICTED, DOC_OLD, DOC_NEW, DOC_IMAGE]));
    expect(refs.imageUrls).toEqual([IMAGE_URL]);
  });
});

describe('share link creation (D-27)', () => {
  it('refuses a chat that cites a restricted document with 403 restricted_content and writes no share id', async () => {
    seed([citing(DOC_RESTRICTED)]);
    const result = await share();
    expect(result).toEqual({ status: 403, body: { error: 'restricted_content' } });
    expect(h.tables.chats[0].share_id).toBeNull();
    expect(h.tables.chats[0].shared).toBe(false);
  });

  it('refuses when an older version of a cited lineage is restricted', async () => {
    seed([citing(DOC_NEW)]);
    expect((await share()).body).toEqual({ error: 'restricted_content' });
  });

  it('refuses when the restricted document is named only by a source image or by an answer record', async () => {
    seed([{ id: 'm2', role: 'assistant', content: [{ type: 'source_images', source_images: [{ url: IMAGE_URL }] }] }]);
    expect((await share()).status).toBe(403);
    seed([{ id: 'm2', role: 'assistant', content: 'A synthetic answer.' }]);
    h.tables.rag_answer_records = [{ id: 'r1', chat_id: CHAT, citations: [{ documentId: DOC_RESTRICTED }] }];
    expect((await share()).status).toBe(403);
  });

  it('refuses an already shared restricted chat instead of handing out its link again', async () => {
    seed([citing(DOC_RESTRICTED)], { shared: true });
    expect(await share()).toEqual({ status: 403, body: { error: 'restricted_content' } });
  });

  it('shares a chat citing only documents labelled all as today', async () => {
    seed([citing(DOC_OPEN)]);
    const result = await share();
    expect(result.status).toBe(200);
    expect(typeof result.body.shareId).toBe('string');
    expect(h.tables.chats[0].share_id).toBe(result.body.shareId);
  });

  it('fails closed when the label lookup fails: no share id', async () => {
    seed([citing(DOC_OPEN)]);
    h.failTable = 'documents';
    const result = await share();
    expect(result).toEqual({ status: 503, body: { error: 'access_groups_unavailable' } });
    expect(h.tables.chats[0].share_id).toBeNull();
  });

  it('switch off: a restricted chat shares exactly as today and no label is read', async () => {
    env.RAG_DOC_ACCESS_GROUPS = 'off';
    seed([citing(DOC_RESTRICTED)]);
    const result = await share();
    expect(result.status).toBe(200);
    expect(Object.keys(result.body)).toEqual(['shareId']);
    expect(h.reads).not.toContain('documents');
  });
});

describe('shared chat read route (D-27, A-13)', () => {
  let unknown: { status: number; body: Row };

  beforeEach(async () => {
    seed([citing(DOC_RESTRICTED)], { shared: true });
    unknown = await readShared(UNKNOWN_SHARE);
  });

  it('answers an anonymous viewer and a signed-in outsider exactly like an unknown share id', async () => {
    expect(unknown.status).toBe(404);
    expect(await readShared()).toEqual(unknown);
    h.cookieUser = OUTSIDER;
    expect(await readShared()).toEqual(unknown);
    expect(await readShared(SHARE_ID, { authorization: `Bearer ${OUTSIDER_TOKEN}` })).toEqual(unknown);
  });

  it('returns the chat to a member of the group signed in by cookie session or by Bearer token', async () => {
    h.cookieUser = MEMBER_A;
    const byCookie = await readShared();
    expect(byCookie.status).toBe(200);
    expect((byCookie.body.chat as Row).title).toBe('Synthetic chat title');
    h.cookieUser = null;
    const byBearer = await readShared(SHARE_ID, { authorization: `Bearer ${MEMBER_TOKEN}` });
    expect(byBearer.status).toBe(200);
  });

  it('treats an invalid Bearer token as anonymous (not found, not 401), even with a member cookie', async () => {
    h.cookieUser = MEMBER_A;
    expect(await readShared(SHARE_ID, { authorization: 'Bearer not-a-real-token' })).toEqual(unknown);
    expect(await readShared(SHARE_ID, { authorization: 'Basic abc' })).toEqual(unknown);
  });

  it('re-checks current labels: a chat whose cited document is now labelled all reads as today', async () => {
    h.tables.documents.find((row) => row.id === DOC_RESTRICTED)!.access_groups = ['all'];
    expect((await readShared()).status).toBe(200);
  });

  it('fails closed when the lookup fails', async () => {
    h.cookieUser = MEMBER_A;
    h.failTable = 'rag_answer_records';
    expect(await readShared()).toEqual(unknown);
  });

  it('switch off: anyone reads the shared chat as today', async () => {
    env.RAG_DOC_ACCESS_GROUPS = 'off';
    const result = await readShared();
    expect(result.status).toBe(200);
    expect(Object.keys(result.body.chat as Row)).toEqual(['title', 'messages', 'createdAt', 'updatedAt']);
    expect(h.reads).not.toContain('documents');
  });
});

describe('shared page and generateMetadata (D-27, UI-SPEC 6.13)', () => {
  beforeEach(() => seed([citing(DOC_RESTRICTED)], { shared: true }));

  it('renders the chat and its own title for a member signed in by cookie session', async () => {
    h.cookieUser = MEMBER_A;
    expect(await renderPage()).toEqual({ notFound: false, title: 'Synthetic chat title - Shared Chat', chatTitle: 'Synthetic chat title' });
  });

  it('answers not found with the generic title for an outsider, an anonymous viewer and an unknown link', async () => {
    const generic = { notFound: true, title: 'Shared Chat', chatTitle: null };
    h.cookieUser = OUTSIDER;
    expect(await renderPage()).toEqual(generic);
    h.cookieUser = null;
    expect(await renderPage()).toEqual(generic);
    expect(await renderPage(UNKNOWN_SHARE)).toEqual(generic);
  });

  it('switch off: renders for anyone with the chat title, as today', async () => {
    env.RAG_DOC_ACCESS_GROUPS = 'off';
    expect(await renderPage()).toEqual({ notFound: false, title: 'Synthetic chat title - Shared Chat', chatTitle: 'Synthetic chat title' });
    expect(h.reads).not.toContain('documents');
  });

  it('a chat citing only documents labelled all renders for an anonymous viewer with the switch on', async () => {
    seed([citing(DOC_OPEN)], { shared: true });
    expect((await renderPage()).notFound).toBe(false);
  });
});
