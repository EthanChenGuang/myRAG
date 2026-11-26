import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

// Plan 03.2-45 (DATA-19, D-41): after publish, the rules-only detector raises pending supersession candidates through the 0806 SQL and
// never changes a document. Two tenants: organization O (userA owns it and is a deployment admin; MEMBER is a plain member) and userB's
// personal workspace. Every text is a neutral synthetic sample.

type Row = Record<string, unknown>;

const MEMBER = '00000000-0000-4000-8000-0000000045a2';
const ORG = TWO_TENANT_IDS.orgO;
const ORG_KEY = `o:${ORG}`;
const ON = { RAG_INGEST_PIPELINE: 'unified', RAG_SUPERSESSION_DETECT: 'on' };

function body(token: string, sentences: string[]): string {
  return `# Notes ${token}\n\n${sentences.join(' ')}\n\nThe ${token} reference is kept for lookup.\n`;
}

describe('supersession detection after publish (two tenants)', () => {
  let db: TwoTenantDatabase;
  let edge: FakeEdge;
  let ingestModule: typeof import('@/lib/rag/ingest');
  let depsModule: typeof import('@/lib/rag/ingest/deps');
  let objectStoreModule: typeof import('@/lib/rag/ingest/object-store');
  let fakeStoreModule: typeof import('../helpers/fake-object-store');
  let resolver: typeof import('@/lib/rag/tenant/resolve-chat');
  let supabaseModule: typeof import('@/lib/supabase');
  let postPublish: typeof import('@/lib/rag/ingest/post-publish');
  let detect: typeof import('@/lib/rag/ingest/versions/detect');
  const finished = new Map<string, () => void>();
  const waits = new Map<string, Promise<void>>();

  before(async () => {
    db = await createTwoTenantDatabase();
    await db.db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [MEMBER, 'member-45@example.invalid']);
    await db.db.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'member')", [ORG, MEMBER]);
    await db.db.query("UPDATE organization_members SET role = 'owner' WHERE organization_id = $1 AND user_id = $2", [ORG, TWO_TENANT_IDS.userA]);
    await db.db.query('INSERT INTO admin_users (id) VALUES ($1)', [TWO_TENANT_IDS.userA]);
    edge = await startFakeEdge({ db: db.db, documentFilenameFilter: true });
    Object.assign(process.env, fixtureProcessEnv(edge.url));
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    process.env.MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    ingestModule = await import('@/lib/rag/ingest');
    depsModule = await import('@/lib/rag/ingest/deps');
    objectStoreModule = await import('@/lib/rag/ingest/object-store');
    fakeStoreModule = await import('../helpers/fake-object-store');
    resolver = await import('@/lib/rag/tenant/resolve-chat');
    supabaseModule = await import('@/lib/supabase');
    postPublish = await import('@/lib/rag/ingest/post-publish');
    detect = await import('@/lib/rag/ingest/versions/detect');
  });

  after(async () => {
    await edge?.close();
    await db?.db.close();
  });

  beforeEach(() => {
    objectStoreModule.setObjectStoreForTests(fakeStoreModule.createFakeObjectStore());
    depsModule.setIngestDepsForTests({ ingestEnv: () => ON });
    // The detector first, then a probe that tells the test the post-publish work of a document has finished.
    postPublish.resetPostPublishHooksForTests();
    detect.registerSupersessionHook(postPublish.registerPostPublishHook);
    postPublish.registerPostPublishHook('test-probe', (event) => {
      finished.get(event.documentId)?.();
    });
  });

  afterEach(() => {
    objectStoreModule.resetObjectStoreForTests();
    depsModule.resetIngestDepsForTests();
    postPublish.resetPostPublishHooksForTests();
  });

  const scopeOf = async (userId: string, organizationId: string | null) => {
    const resolved = await resolver.resolveTenantScope({
      requestedOrganizationId: organizationId,
      deploymentMode: 'multi-tenant',
      getUser: async () => ({ id: userId }),
      admin: supabaseModule.getSupabaseAdmin(),
      signal: new AbortController().signal,
    });
    assert.ok(resolved.ok && resolved.scope, 'scope must resolve');
    return resolved.scope;
  };

  const rows = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await db.db.query<Row>(sql, params)).rows;

  /** Ingests one file and waits until its post-publish hooks have run (or a short grace period when it did not publish). */
  const upload = async (filename: string, text: string, userId: string, organizationId: string | null, extra: Record<string, unknown> = {}) => {
    const scope = await scopeOf(userId, organizationId);
    let release: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    const result = await ingestModule.ingest({
      scope,
      source: 'config_upload',
      sourceKey: `root/${filename}`,
      text,
      filename,
      mimeType: 'text/markdown',
      uploaderId: userId,
      signal: new AbortController().signal,
      ...extra,
    });
    if (result.documentId) {
      finished.set(result.documentId, release);
      waits.set(result.documentId, done);
      if (result.status === 'ready') {
        // The probe may already have run; afterPublish is idempotent for raises, so waiting on a bounded timer is enough.
        await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 1500))]);
      }
    }
    return result;
  };

  const candidatesOf = async (documentId: string) =>
    rows('SELECT * FROM rag_supersession_candidates WHERE document_id = $1 OR candidate_document_id = $1 ORDER BY created_at', [documentId]);

  test('two same-type files whose titles differ only by a year marker yield one pending candidate with a direction', async () => {
    const older = await upload('Widget Catalogue 2023.md', body('zqxolder', ['The blue widget is listed first.']), TWO_TENANT_IDS.userA, ORG);
    assert.equal(older.status, 'ready');
    assert.equal((await candidatesOf(older.documentId as string)).length, 0, 'the first document has nothing to compare with');
    const newer = await upload('Widget Catalogue 2024.md', body('zqxnewer', ['The green widget is listed first.']), TWO_TENANT_IDS.userA, ORG);
    assert.equal(newer.status, 'ready');

    const found = await candidatesOf(newer.documentId as string);
    assert.equal(found.length, 1);
    const candidate = found[0] as Row;
    assert.equal(candidate.status, 'pending');
    assert.equal(candidate.origin, 'detected');
    assert.equal(candidate.tenant_key, ORG_KEY);
    assert.equal(candidate.document_id, newer.documentId);
    assert.equal(candidate.candidate_document_id, older.documentId);
    assert.equal(candidate.direction, 'document_newer');
    assert.equal((candidate.signals as Row).title_match, true);

    for (const id of [older.documentId, newer.documentId]) {
      const document = (await rows('SELECT is_current, status, superseded_by FROM documents WHERE id = $1', [id]))[0] as Row;
      assert.equal(document.is_current, true, 'a candidate changes no document');
      assert.equal(document.status, 'ready');
      assert.equal(document.superseded_by, null);
      const chunks = await rows('SELECT is_current FROM document_chunks WHERE document_id = $1', [id]);
      assert.ok(chunks.length > 0 && chunks.every((chunk) => chunk.is_current === true), 'both documents stay retrievable');
    }
    assert.equal((await rows('SELECT count(*)::int AS n FROM rag_supersession_links'))[0]?.n, 0);
  });

  test('another doc type, another tenant or another normalized title raises nothing', async () => {
    const otherType = await upload('Widget Catalogue 2022.md', body('zqxtype', ['The red widget is listed first.']), TWO_TENANT_IDS.userA, ORG, {
      docType: 'product_technical',
    });
    assert.equal(otherType.status, 'ready');
    assert.equal((await candidatesOf(otherType.documentId as string)).length, 0);

    const otherTenant = await upload('Widget Catalogue 2021.md', body('zqxtenant', ['The grey widget is listed first.']), TWO_TENANT_IDS.userB, null);
    assert.equal(otherTenant.status, 'ready');
    assert.equal((await candidatesOf(otherTenant.documentId as string)).length, 0);

    const otherTitle = await upload('Gadget Catalogue 2025.md', body('zqxtitle', ['The white widget is listed first.']), TWO_TENANT_IDS.userA, ORG);
    assert.equal(otherTitle.status, 'ready');
    assert.equal((await candidatesOf(otherTitle.documentId as string)).length, 0);

    const crossTenant = await rows(
      `SELECT count(*)::int AS n FROM rag_supersession_candidates c
       JOIN documents a ON a.id = c.document_id JOIN documents b ON b.id = c.candidate_document_id
       WHERE a.tenant_key <> b.tenant_key OR a.tenant_key <> c.tenant_key OR a.doc_type <> b.doc_type`,
    );
    assert.equal(crossTenant[0]?.n, 0);
  });

  test('a failing detector does not change the ingest result', async () => {
    const real = depsModule.getIngestDeps().db;
    depsModule.setIngestDepsForTests({
      db: () => {
        const client = real();
        if (!client) return client;
        return {
          rpc(fn: string, args: Record<string, unknown>) {
            if (fn === 'rag_supersession_peers') throw new Error('detector down');
            return client.rpc(fn, args);
          },
        };
      },
    });
    const result = await upload('Widget Catalogue 2026.md', body('zqxfail', ['The black widget is listed first.']), TWO_TENANT_IDS.userA, ORG);
    assert.equal(result.status, 'ready');
    const document = (await rows('SELECT is_current, status FROM documents WHERE id = $1', [result.documentId]))[0] as Row;
    assert.equal(document.is_current, true);
    assert.equal((await candidatesOf(result.documentId as string)).length, 0);
  });

  test('with the switch off no detector runs and no candidate is written', async () => {
    depsModule.setIngestDepsForTests({ ingestEnv: () => ({ RAG_INGEST_PIPELINE: 'unified', RAG_SUPERSESSION_DETECT: 'off' }) });
    postPublish.resetPostPublishHooksForTests();
    const calls = edge.calls.length;
    const result = await upload('Widget Catalogue 2027.md', body('zqxoff', ['The silver widget is listed first.']), TWO_TENANT_IDS.userA, ORG);
    assert.equal(result.status, 'ready');
    await postPublish.afterPublish({ documentId: result.documentId as string, tenantKey: ORG_KEY });
    assert.equal(edge.calls.slice(calls).filter((call) => /rag_supersession_/.test(call.path)).length, 0);
    assert.equal((await candidatesOf(result.documentId as string)).length, 0);
  });
});
