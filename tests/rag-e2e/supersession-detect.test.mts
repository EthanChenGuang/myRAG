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

  const REVISION_A = [
    'The blue widget weighs 12 grams and ships in boxes of 40 units.',
    'Each grey panel holds 6 brass screws spaced 15 millimetres apart.',
    'The copper rail is 120 centimetres long and rests on 3 brackets.',
    'Assembly takes about 25 minutes with two people working together.',
    'Store the finished frame in a dry room below 30 degrees.',
  ];
  const REVISION_B = [
    'The blue widget weighs 14 grams and ships in boxes of 40 units.',
    'Each grey panel holds 8 brass screws spaced 15 millimetres apart.',
    'The copper rail is 150 centimetres long and rests on 3 brackets.',
    'Assembly takes about 25 minutes with two people working together.',
    'Store the finished frame in a dry room below 30 degrees.',
  ];
  const plain = (sentences: string[]) => `${sentences.join(' ')}\n`;

  test('different titles whose stored contents overlap while numbers differ raise a candidate; identical content raises nothing', async () => {
    const first = await upload('Workshop handout.md', plain(REVISION_A), TWO_TENANT_IDS.userA, ORG, { docType: 'contract_legal' });
    const second = await upload('Assembly sheet.md', plain(REVISION_B), TWO_TENANT_IDS.userA, ORG, { docType: 'contract_legal' });
    assert.equal(second.status, 'ready');
    const found = await candidatesOf(second.documentId as string);
    assert.equal(found.length, 1);
    const candidate = found[0] as Row;
    assert.equal(candidate.origin, 'detected');
    assert.equal(candidate.candidate_document_id, first.documentId);
    const signals = candidate.signals as Row;
    assert.equal(signals.title_match, false);
    assert.ok((signals.content_overlap_percent as number) >= detect.supersessionRules().content_overlap_min_percent);
    assert.ok((signals.conflicting_numbers as number) >= detect.supersessionRules().min_conflicting_numbers);
    assert.equal(candidate.direction, null, 'no year marker and no dates: the admin chooses');

    const copy = await upload('Assembly sheet copy.md', plain(REVISION_B), TWO_TENANT_IDS.userA, ORG, { docType: 'contract_legal' });
    assert.notEqual(copy.status, 'ready', 'identical content is a duplicate, not a version');
    assert.equal((await candidatesOf(second.documentId as string)).length, 1);
  });

  const replacesTarget = async (token: string) => {
    const target = await upload(`Bracket guide ${token}.md`, body(token, ['The steel bracket holds the upper shelf.']), TWO_TENANT_IDS.userA, ORG, {
      docType: 'financial_report',
    });
    assert.equal(target.status, 'ready');
    return target.documentId as string;
  };

  test("an admin's Replaces… is confirmed right after publish", async () => {
    const older = await replacesTarget('zqxrepadm');
    const newer = await upload('Shelf layout.md', body('zqxrepadmnew', ['The steel bracket now holds two shelves.']), TWO_TENANT_IDS.userA, ORG, {
      replacesDocumentId: older,
    });
    assert.equal(newer.status, 'ready');
    const found = (await candidatesOf(older)).filter((row) => row.origin === 'uploader');
    assert.equal(found.length, 1);
    assert.equal(found[0]?.status, 'confirmed');
    assert.equal(found[0]?.document_id, newer.documentId);
    assert.equal(found[0]?.older_document_id, older);
    assert.equal(found[0]?.decided_by, TWO_TENANT_IDS.userA);
    const retired = (await rows('SELECT is_current, superseded_by FROM documents WHERE id = $1', [older]))[0] as Row;
    assert.equal(retired.is_current, false);
    assert.equal(retired.superseded_by, newer.documentId);
    const current = (await rows('SELECT is_current FROM documents WHERE id = $1', [newer.documentId]))[0] as Row;
    assert.equal(current.is_current, true);
  });

  test("a member's Replaces… stays a pending candidate and supersedes nothing", async () => {
    const older = await replacesTarget('zqxrepmem');
    const newer = await upload('Rack layout.md', body('zqxrepmemnew', ['The steel bracket now holds three shelves.']), MEMBER, ORG, {
      replacesDocumentId: older,
    });
    assert.equal(newer.status, 'ready');
    const found = (await candidatesOf(older)).filter((row) => row.origin === 'uploader');
    assert.equal(found.length, 1);
    assert.equal(found[0]?.status, 'pending');
    assert.equal(found[0]?.direction, 'document_newer');
    const document = (await rows('SELECT is_current FROM documents WHERE id = $1', [older]))[0] as Row;
    assert.equal(document.is_current, true);
  });

  test('a held upload raises its Replaces… candidate only after approval publishes it', async () => {
    const older = await replacesTarget('zqxrepheld');
    depsModule.setIngestDepsForTests({ ingestEnv: () => ({ ...ON, RAG_UPLOAD_APPROVAL: 'members' }) });
    const held = await upload('Cabinet layout.md', body('zqxrepheldnew', ['The steel bracket now holds four shelves.']), MEMBER, ORG, {
      replacesDocumentId: older,
    });
    assert.equal(held.status, 'pending_review');
    assert.equal((await candidatesOf(older)).length, 0, 'nothing is raised while the upload waits');

    let release: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    finished.set(held.documentId as string, release);
    const approval = await import('@/lib/rag/ingest/approval/admin');
    const approved = await approval.approveUpload({
      documentId: held.documentId as string,
      actorUserId: TWO_TENANT_IDS.userA,
      tenantKey: ORG_KEY,
      signal: new AbortController().signal,
    });
    assert.ok(approved.ok, JSON.stringify(approved));
    await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 3000))]);
    const found = (await candidatesOf(older)).filter((row) => row.origin === 'uploader');
    assert.equal(found.length, 1);
    assert.equal(found[0]?.status, 'pending', "the member's choice waits for an admin");
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
