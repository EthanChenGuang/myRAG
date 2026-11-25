import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

// Plan 03.2-15 (D-37, D-56, D-57, SEC-09): upload approval holds on every ingestion source, inline and queued, through the real
// entry points (route handlers in a Next.js request scope, the scraper routes, the Nango adapter); under the legacy pipeline every
// knowledge-base write entry refuses with 503 upload_approval_requires_unified_pipeline and writes nothing; with the switch off
// nothing changes. Organization O: userA owns it and is a deployment admin, MEMBER is a plain member.

// Next.js creates its request stores from a global AsyncLocalStorage when its modules load; every Next import below is dynamic.
(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage ??= AsyncLocalStorage;

type Row = Record<string, unknown>;
type Switches = { pipeline: 'legacy' | 'unified'; approval: 'off' | 'members' | 'all'; async?: 'off' | 'on' };
type Handler = (request: Request) => Promise<Response>;

const REFUSAL = 'upload_approval_requires_unified_pipeline';
const MEMBER = '00000000-0000-4000-8000-0000000015a2';
const ADMIN = TWO_TENANT_IDS.userA;
const ORG = TWO_TENANT_IDS.orgO;
const CONNECTION = 'conn-approval-paths-1';
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** One row per ingestion source (INGEST_SOURCES); tests/rag/approval-gate-boundary.test.ts checks that every source has one. */
export const PATH_MATRIX = [
  { source: 'chat_upload', entry: 'POST /api/process-document' },
  { source: 'config_upload', entry: 'POST /api/process-document (upload_source=config_upload)' },
  { source: 'image_upload', entry: 'POST /api/upload (process_rag=true)' },
  { source: 'ai_to_rag', entry: 'POST /api/ai-to-rag' },
  { source: 'scraper', entry: 'POST /api/scrapers/scrape and /api/scrapers/crawl' },
  { source: 'nango', entry: 'processDocumentWithMetadata (connection owner)' },
] as const;

function base64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function note(token: string): string {
  return `# Widget Notes ${token}\n\nThe ${token} widget is fastened to the grey panel with four brass screws beside the oak frame.\n`;
}

interface NextScope {
  workAsyncStorage: { run<T>(store: unknown, fn: () => T): T };
  workUnitAsyncStorage: { run<T>(store: unknown, fn: () => T): T };
  RequestCookies: new (headers: Headers) => unknown;
}

describe('upload approval on every ingestion path (D-37, D-56, D-57)', () => {
  let db: TwoTenantDatabase;
  let edge: FakeEdge;
  let next: NextScope;
  let envObject: Record<string, string>;
  let queueConfig: typeof import('@/lib/rag/ingest/queue-config');
  let objectStoreModule: typeof import('@/lib/rag/ingest/object-store');
  let fakeStoreModule: typeof import('../helpers/fake-object-store');
  let captioner: typeof import('@/lib/rag/ingest/captioner');
  let nango: typeof import('@/lib/nango/document-adapter');
  let routes: { processDocument: Handler; upload: Handler; aiToRag: Handler; scrape: Handler; crawl: Handler };
  const originalFetch = globalThis.fetch;
  const tokens = new Map<string, string>();
  const cookieName = { value: '' };
  const saved = new Map<string, string | undefined>();
  const SWITCH_NAMES = ['RAG_INGEST_PIPELINE', 'RAG_UPLOAD_APPROVAL', 'RAG_INGEST_ASYNC'] as const;

  before(async () => {
    db = await createTwoTenantDatabase();
    await db.db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [MEMBER, 'member-15@example.invalid']);
    await db.db.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'member')", [ORG, MEMBER]);
    await db.db.query("UPDATE organization_members SET role = 'owner' WHERE organization_id = $1 AND user_id = $2", [ORG, ADMIN]);
    await db.db.query('INSERT INTO admin_users (id) VALUES ($1)', [ADMIN]);
    edge = await startFakeEdge({ db: db.db, documentFilenameFilter: true });

    const fixtureEnv = {
      ...fixtureProcessEnv(edge.url),
      NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE: 'multi-tenant',
      MYRAG_DEPLOYMENT_MODE: 'multi-tenant',
      FIRECRAWL_API_KEY: 'fc-placeholder-key-0000000000',
      NEXT_PUBLIC_FIRECRAWL_ENABLED: 'true',
      LLAMA_CLOUD_API_KEY: 'llx-placeholder-key-0000000000',
      // The legacy parsers call LlamaCloud with their own HTTP client; with cloud parsing off no request leaves the machine.
      RAG_PARSER_ALLOW_CLOUD: 'false',
    };
    for (const name of [...Object.keys(fixtureEnv), ...SWITCH_NAMES]) saved.set(name, process.env[name]);
    Object.assign(process.env, fixtureEnv);

    for (const [user, token] of [
      [ADMIN, 'token-approval-admin'],
      [MEMBER, 'token-approval-member'],
    ] as const) {
      tokens.set(token, user);
    }
    const userUrl = `${edge.url}/auth/v1/user`;
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.split('?')[0] === userUrl) {
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        const user = tokens.get((headers.get('authorization') ?? '').replace(/^Bearer /, ''));
        if (!user) return Response.json({ code: 401, msg: 'invalid token' }, { status: 401 });
        return Response.json({ id: user, aud: 'authenticated', role: 'authenticated', email: `${user.slice(-4)}@example.invalid` });
      }
      if (/llamaindex\.ai/i.test(url)) return Response.json({ detail: 'fixture' }, { status: 500 });
      // The organization check reads select=*; the fake edge serves named columns only.
      const parsed = new URL(url);
      // The admin guard reads admin_users, which the fake edge does not serve; answer it from the fixture database.
      if (parsed.pathname === '/rest/v1/admin_users') {
        const id = (parsed.searchParams.get('id') ?? '').replace(/^eq\./, '');
        const found = (await db.db.query('SELECT id FROM admin_users WHERE id::text = $1', [id])).rows;
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        if ((headers.get('accept') ?? '').includes('vnd.pgrst.object')) {
          return found[0] ? Response.json(found[0]) : Response.json({ code: 'PGRST116', message: 'no rows' }, { status: 406 });
        }
        return Response.json(found);
      }
      if (parsed.pathname === '/rest/v1/organizations' && parsed.searchParams.get('select') === '*') {
        parsed.searchParams.set('select', 'id,name,slug,owner_id,is_personal,subscription_tier,created_at');
        return originalFetch(parsed.href, init ?? (input instanceof Request ? input : undefined));
      }
      return originalFetch(input, init);
    };
    cookieName.value = `sb-${new URL(edge.url).hostname.split('.')[0]}-auth-token`;

    const workStorage = (await import('next/dist/server/app-render/work-async-storage.external.js')) as unknown as Pick<NextScope, 'workAsyncStorage'>;
    const unitStorage = (await import('next/dist/server/app-render/work-unit-async-storage.external.js')) as unknown as Pick<NextScope, 'workUnitAsyncStorage'>;
    const cookies = (await import('next/dist/server/web/spec-extension/cookies.js')) as unknown as Pick<NextScope, 'RequestCookies'>;
    next = { ...workStorage, ...unitStorage, ...cookies };

    envObject = (await import('@/lib/env')).env as unknown as Record<string, string>;
    queueConfig = await import('@/lib/rag/ingest/queue-config');
    objectStoreModule = await import('@/lib/rag/ingest/object-store');
    fakeStoreModule = await import('../helpers/fake-object-store');
    captioner = await import('@/lib/rag/ingest/captioner');
    nango = await import('@/lib/nango/document-adapter');
    const firecrawl = await import('@/lib/scrapers/firecrawl-client');
    const client = firecrawl.getFirecrawl() as unknown as Record<string, unknown>;
    const page = (url: string) => ({
      url,
      markdown: note(new URL(url).pathname.replace(/\W/g, '')),
      html: `<html><body><p>${note(new URL(url).pathname.replace(/\W/g, ''))}</p></body></html>`,
      metadata: { title: `Page ${new URL(url).pathname.replace(/\W/g, '')}`, sourceURL: url },
    });
    client.scrape = async (url: string) => page(url);
    client.crawl = async (url: string) => ({ status: 'completed', data: [page(`${url.replace(/\/$/, '')}/first`)] });

    routes = {
      processDocument: ((await import('@/app/api/process-document/route')) as unknown as { POST: Handler }).POST,
      upload: ((await import('@/app/api/upload/route')) as unknown as { POST: Handler }).POST,
      aiToRag: ((await import('@/app/api/ai-to-rag/route')) as unknown as { POST: Handler }).POST,
      scrape: ((await import('@/app/api/scrapers/scrape/route')) as unknown as { POST: Handler }).POST,
      crawl: ((await import('@/app/api/scrapers/crawl/route')) as unknown as { POST: Handler }).POST,
    };
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await edge?.close();
    await db?.db.close();
  });

  beforeEach(() => {
    objectStoreModule.setObjectStoreForTests(fakeStoreModule.createFakeObjectStore());
    captioner.setCaptionerForTests(async () => 'A small square widget photo on a plain background.');
  });

  afterEach(() => {
    objectStoreModule.resetObjectStoreForTests();
    captioner.resetCaptionerForTests();
  });

  const useSwitches = ({ pipeline, approval, async = 'off' }: Switches) => {
    const values = { RAG_INGEST_PIPELINE: pipeline, RAG_UPLOAD_APPROVAL: approval, RAG_INGEST_ASYNC: async };
    for (const [name, value] of Object.entries(values)) {
      process.env[name] = value;
      envObject[name] = value;
    }
    queueConfig.resetQueueConfigForTests();
  };

  const tokenOf = (user: string) => [...tokens.entries()].find(([, id]) => id === user)?.[0] ?? '';

  const sessionCookie = (user: string) => {
    const token = tokenOf(user);
    const session = {
      access_token: token,
      refresh_token: `refresh-${token}`,
      token_type: 'bearer',
      expires_in: 86_400,
      expires_at: Math.floor(Date.now() / 1000) + 86_400,
      user: { id: user, aud: 'authenticated', role: 'authenticated', email: `${user.slice(-4)}@example.invalid` },
    };
    return `${cookieName.value}=base64-${base64Url(JSON.stringify(session))}`;
  };

  /** Runs a route handler as `user` in a request scope; after() tasks run to completion before this returns. */
  const call = async (user: string, handler: Handler, request: Request): Promise<{ status: number; body: Row }> => {
    const tasks: Array<() => unknown> = [];
    const workStore = {
      route: '/api/upload-approval-paths-test',
      afterContext: {
        after(task: unknown) {
          tasks.push(typeof task === 'function' ? (task as () => unknown) : () => task);
        },
      },
    };
    const requestStore = { type: 'request', phase: 'render', cookies: new next.RequestCookies(new Headers({ cookie: sessionCookie(user) })) };
    const response = await next.workAsyncStorage.run(workStore, () => next.workUnitAsyncStorage.run(requestStore, () => handler(request)));
    for (const task of tasks) await Promise.resolve().then(task);
    const text = await response.text();
    return { status: response.status, body: text === '' ? {} : (JSON.parse(text) as Row) };
  };

  const processDocument = (user: string, token: string, fields: Record<string, string> = {}, headers: Record<string, string> = {}) => {
    const form = new FormData();
    form.set('file', new File([note(token)], `notes-${token}.md`, { type: 'text/markdown' }));
    form.set('organization_id', ORG);
    for (const [name, value] of Object.entries(fields)) form.set(name, value);
    return call(user, routes.processDocument, new Request('http://localhost/api/process-document', { method: 'POST', body: form, headers }));
  };

  const uploadImage = (user: string, token: string, processRag = true) => {
    const form = new FormData();
    form.append('files', new File([PNG_1X1, Buffer.from(token)], `image-${token}.png`, { type: 'image/png' }));
    form.set('organization_id', ORG);
    if (processRag) form.set('process_rag', 'true');
    return call(user, routes.upload, new Request('http://localhost/api/upload', { method: 'POST', body: form }));
  };

  const aiToRag = (user: string, token: string) =>
    call(
      user,
      routes.aiToRag,
      new Request('http://localhost/api/ai-to-rag', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: note(token), messageId: `message-${token}`, chatId: `chat-${token}`, organizationId: ORG }),
      }),
    );

  const scrape = (user: string, token: string, route: 'scrape' | 'crawl' = 'scrape') =>
    call(
      user,
      routes[route],
      new Request(`http://localhost/api/scrapers/${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: `https://example.invalid/${token}`, organizationId: ORG, maxPages: 1 }),
      }),
    );

  const syncNango = (owner: string, token: string) =>
    nango.processDocumentWithMetadata(`drive-${token}.md`, Buffer.from(note(token)), {
      userId: owner,
      sourceProvider: 'google-drive',
      sourceFileId: `file-${token}`,
      sourceConnectionId: CONNECTION,
      nangoConnectionId: CONNECTION,
      mimeType: 'text/markdown',
    });

  const rows = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await db.db.query<Row>(sql, params)).rows;
  const documentById = async (id: unknown) => (await rows('SELECT status, is_current, tenant_key, processing_state FROM documents WHERE id = $1', [id]))[0] as Row;
  const documentByFilename = async (filename: string) =>
    (await rows('SELECT id, status, is_current, tenant_key, processing_state FROM documents WHERE filename = $1 ORDER BY created_at DESC LIMIT 1', [filename]))[0] as Row | undefined;
  const documentCount = async () => Number(((await rows('SELECT count(*)::int AS n FROM documents'))[0] as Row).n);
  const approvalOf = (document: Row) => ((document.processing_state as Row | null)?.approval ?? null) as Row | null;
  const jobOf = async (documentId: unknown) =>
    (await rows('SELECT status, settings FROM ingestion_jobs WHERE document_id = $1 ORDER BY created_at DESC LIMIT 1', [documentId]))[0] as Row;

  describe('unified pipeline, inline, RAG_UPLOAD_APPROVAL=members', () => {
    beforeEach(() => useSwitches({ pipeline: 'unified', approval: 'members' }));

    test("chat_upload: a member's upload answers 200 with pending_review and is held; an admin's is ready", async () => {
      const held = await processDocument(MEMBER, 'zqxchat');
      assert.equal(held.status, 200, JSON.stringify(held.body));
      assert.equal(held.body.status, 'pending_review');
      const document = await documentById(held.body.documentId);
      assert.equal(document.status, 'pending_review');
      assert.equal(document.is_current, false);
      assert.equal(approvalOf(document)?.uploader_id, MEMBER);

      const ready = await processDocument(ADMIN, 'zqxchatadmin');
      assert.equal(ready.status, 200, JSON.stringify(ready.body));
      assert.equal(ready.body.status, 'ready');
      assert.equal((await documentById(ready.body.documentId)).status, 'ready');
    });

    test('config_upload: an admin upload through the Config UI source is not held under members and is held under all', async () => {
      const admin = { upload_source: 'config_upload' };
      const ready = await processDocument(ADMIN, 'zqxconfig', admin);
      assert.equal(ready.status, 200, JSON.stringify(ready.body));
      assert.equal(ready.body.status, 'ready');

      useSwitches({ pipeline: 'unified', approval: 'all' });
      const held = await processDocument(ADMIN, 'zqxconfigall', admin);
      assert.equal(held.status, 200, JSON.stringify(held.body));
      assert.equal(held.body.status, 'pending_review');
      const document = await documentById(held.body.documentId);
      assert.equal(document.status, 'pending_review');
      assert.equal(approvalOf(document)?.reason, 'all_uploads');
    });

    test("image_upload: a member's image upload is ingested after the response and held", async () => {
      const response = await uploadImage(MEMBER, 'zqximage');
      assert.equal(response.status, 200, JSON.stringify(response.body));
      const document = await documentByFilename('image-zqximage.png');
      assert.ok(document, 'the image was ingested');
      assert.equal(document.status, 'pending_review');
      assert.equal(approvalOf(document)?.uploader_id, MEMBER);
    });

    test("ai_to_rag: a member's saved answer answers 200 with pending_review and is held", async () => {
      const response = await aiToRag(MEMBER, 'zqxanswer');
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.body.success, true);
      assert.equal(response.body.status, 'pending_review');
      assert.equal((await documentById(response.body.documentId)).status, 'pending_review');
    });

    test("scraper: a member's scrape and crawl answer success with pending_review and are held", async () => {
      const scraped = await scrape(MEMBER, 'zqxscrape');
      assert.equal(scraped.status, 200, JSON.stringify(scraped.body));
      assert.equal(scraped.body.status, 'pending_review');
      assert.equal((await documentById(scraped.body.documentId)).status, 'pending_review');

      const crawled = await scrape(MEMBER, 'zqxcrawl', 'crawl');
      assert.equal(crawled.status, 200, JSON.stringify(crawled.body));
      const pages = (crawled.body.documents ?? []) as Row[];
      assert.equal(pages.length, 1, JSON.stringify(crawled.body));
      assert.equal(pages[0]?.status, 'pending_review');
      assert.equal((await documentById(pages[0]?.documentId)).status, 'pending_review');
    });

    test('nango: the connection owner is the uploader; a pending_review sync finishes without throwing', async () => {
      // Multi-tenant: a connection syncs into its owner's personal workspace, whose own uploads are not held under members.
      const own = await syncNango(MEMBER, 'zqxdriveown');
      const ownDocument = await documentById(own);
      assert.equal(ownDocument.status, 'ready');
      assert.equal(approvalOf(ownDocument)?.uploader_id, MEMBER);
      assert.equal(approvalOf(ownDocument)?.reason, 'personal_workspace');

      useSwitches({ pipeline: 'unified', approval: 'all' });
      const held = await syncNango(MEMBER, 'zqxdriveheld');
      const heldDocument = await documentById(held);
      assert.equal(heldDocument.status, 'pending_review');
      assert.equal(approvalOf(heldDocument)?.uploader_id, MEMBER);
    });

    test('nango: an exempt connector is not held', async () => {
      useSwitches({ pipeline: 'unified', approval: 'all' });
      await db.db.query("INSERT INTO rag_upload_approval_exemptions (tenant_key, kind, ref, created_by) VALUES ($1, 'connector', $2, $3)", [
        `u:${MEMBER}`,
        CONNECTION,
        ADMIN,
      ]);
      try {
        const id = await syncNango(MEMBER, 'zqxdriveexempt');
        const document = await documentById(id);
        assert.equal(document.status, 'ready');
        assert.equal(approvalOf(document)?.reason, 'exempt_connector');
      } finally {
        await db.db.query('DELETE FROM rag_upload_approval_exemptions WHERE ref = $1', [CONNECTION]);
      }
    });
  });

  describe('unified pipeline, queued (RAG_INGEST_ASYNC=on), RAG_UPLOAD_APPROVAL=members', () => {
    beforeEach(() => useSwitches({ pipeline: 'unified', approval: 'members', async: 'on' }));

    const assertHeldJob = async (documentId: unknown, uploader: string) => {
      const job = await jobOf(documentId);
      assert.ok(job, 'a job was enqueued');
      assert.equal(job.status, 'queued');
      const approval = (job.settings as Row).approval as Row;
      assert.equal(approval.required, true);
      assert.equal(approval.uploader_id, uploader);
    };

    test("chat_upload, image_upload, ai_to_rag and scraper: a member's upload is queued with the hold frozen in its snapshot", async () => {
      const chat = await processDocument(MEMBER, 'zqxqchat');
      assert.equal(chat.status, 202, JSON.stringify(chat.body));
      assert.equal(chat.body.status, 'queued');
      await assertHeldJob(chat.body.documentId, MEMBER);

      const image = await uploadImage(MEMBER, 'zqxqimage');
      assert.ok([200, 202].includes(image.status), JSON.stringify(image.body));
      assert.equal(image.body.status, 'queued');
      await assertHeldJob(image.body.documentId, MEMBER);

      const answer = await aiToRag(MEMBER, 'zqxqanswer');
      assert.equal(answer.status, 202, JSON.stringify(answer.body));
      await assertHeldJob(answer.body.documentId, MEMBER);

      const scraped = await scrape(MEMBER, 'zqxqscrape');
      assert.equal(scraped.status, 200, JSON.stringify(scraped.body));
      assert.equal(scraped.body.status, 'queued');
      await assertHeldJob(scraped.body.documentId, MEMBER);
    });

    test("chat_upload: an admin's queued upload carries no hold", async () => {
      const ready = await processDocument(ADMIN, 'zqxqadmin');
      assert.equal(ready.status, 202, JSON.stringify(ready.body));
      const job = await jobOf(ready.body.documentId);
      assert.equal('approval' in (job.settings as Row), false);
    });

    test('nango: a queued sync under all is held for its connection owner', async () => {
      useSwitches({ pipeline: 'unified', approval: 'all', async: 'on' });
      const id = await syncNango(MEMBER, 'zqxqdrive');
      await assertHeldJob(id, MEMBER);
    });
  });

  describe('legacy pipeline with RAG_UPLOAD_APPROVAL on: every knowledge-base write entry refuses and writes nothing', () => {
    for (const approval of ['members', 'all'] as const) {
      test(`${approval}: process-document, upload, ai-to-rag, scrape and crawl answer 503 ${REFUSAL}`, async () => {
        useSwitches({ pipeline: 'legacy', approval });
        const before = await documentCount();
        const llamaCallsBefore = edge.calls.length;
        for (const [label, response] of [
          ['process-document', await processDocument(MEMBER, `zqxlegacy${approval}`)],
          ['process-document (admin)', await processDocument(ADMIN, `zqxlegacyadmin${approval}`)],
          ['upload', await uploadImage(MEMBER, `zqxlegacyimage${approval}`)],
          ['ai-to-rag', await aiToRag(MEMBER, `zqxlegacyanswer${approval}`)],
          ['scrape', await scrape(MEMBER, `zqxlegacyscrape${approval}`)],
          ['crawl', await scrape(MEMBER, `zqxlegacycrawl${approval}`, 'crawl')],
        ] as const) {
          assert.equal(response.status, 503, `${label}: ${JSON.stringify(response.body)}`);
          assert.deepEqual(response.body, { error: REFUSAL }, label);
        }
        assert.equal(await documentCount(), before, 'no document row was written');
        assert.equal(edge.calls.slice(llamaCallsBefore).filter((c) => /storage\/v1\/object\/chat-images/.test(c.path)).length, 0, 'no file was stored');
      });
    }

    test(`nango: a legacy sync throws a typed error carrying ${REFUSAL} and writes nothing`, async () => {
      useSwitches({ pipeline: 'legacy', approval: 'members' });
      const before = await documentCount();
      await assert.rejects(syncNango(MEMBER, 'zqxlegacydrive'), (error: unknown) => {
        assert.equal((error as { code?: string }).code, REFUSAL);
        assert.equal((error as { status?: number }).status, 503);
        return true;
      });
      assert.equal(await documentCount(), before);
    });

    test('temporary attachments that are not written to the knowledge base are not refused', async () => {
      useSwitches({ pipeline: 'legacy', approval: 'members' });
      const temporary = await processDocument(MEMBER, 'zqxlegacytemp', { isTemporary: 'true' });
      assert.notDeepEqual(temporary.body, { error: REFUSAL });
      const plain = await uploadImage(MEMBER, 'zqxlegacyplain', false);
      assert.equal(plain.status, 200, JSON.stringify(plain.body));
    });
  });

  describe('RAG_UPLOAD_APPROVAL=off: both pipelines behave as today', () => {
    test("unified: a member's upload is ready and carries no approval", async () => {
      useSwitches({ pipeline: 'unified', approval: 'off' });
      const response = await processDocument(MEMBER, 'zqxoffunified');
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.body.status, 'ready');
      assert.equal(approvalOf(await documentById(response.body.documentId)), null);
    });

    test('legacy: no entry refuses; each goes on to its legacy writer as today', async () => {
      useSwitches({ pipeline: 'legacy', approval: 'off' });
      // The fixture serves none of the legacy writers' calls (LlamaCloud, direct table inserts), so only the refusal is asserted here;
      // the legacy write paths themselves are covered by the route tests under tests/rag/.
      for (const [label, response] of [
        ['process-document', await processDocument(MEMBER, 'zqxofflegacydoc')],
        ['ai-to-rag', await aiToRag(MEMBER, 'zqxofflegacy')],
        ['scrape', await scrape(MEMBER, 'zqxofflegacyscrape')],
      ] as const) {
        assert.notDeepEqual(response.body, { error: REFUSAL }, label);
      }
      const image = await uploadImage(MEMBER, 'zqxofflegacyimage');
      assert.equal(image.status, 200, JSON.stringify(image.body));
      await assert.doesNotReject(
        syncNango(MEMBER, 'zqxofflegacydrive').catch((error: unknown) => {
          if ((error as { code?: string }).code === REFUSAL) throw error;
        }),
      );
    });
  });
});
