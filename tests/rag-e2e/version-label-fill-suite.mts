import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { createEmptyFixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

// Plan 05.2-21 (GEN-14, D-49): when the Phase 3.2 supersession detector parses a version marker from a published document's title and the
// document has no version label, the label is filled with that marker; an admin-set label is never overwritten; a title without a marker
// leaves it null. Shared by the multi-tenant and the single-tenant entry files. Every text is a neutral synthetic sample.

type Row = Record<string, unknown>;
type Mode = 'multi-tenant' | 'single-tenant';

const ON = { RAG_INGEST_PIPELINE: 'unified', RAG_SUPERSESSION_DETECT: 'on' };
const SINGLE_ADMIN = '00000000-0000-4000-8000-0000000521f1';

function body(token: string): string {
  return `# Notes ${token}\n\nThe ${token} widget rests on the lower shelf beside the copper rail.\n`;
}

export function defineVersionLabelFillSuite(mode: Mode): void {
  describe(`version label filled from the title marker after publish (${mode})`, () => {
    let pg: import('@electric-sql/pglite').PGlite;
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
    const uploader = mode === 'multi-tenant' ? TWO_TENANT_IDS.userA : SINGLE_ADMIN;
    const organizationId = mode === 'multi-tenant' ? TWO_TENANT_IDS.orgO : null;
    const tenantKey = mode === 'multi-tenant' ? `o:${TWO_TENANT_IDS.orgO}` : 's:default';

    before(async () => {
      if (mode === 'multi-tenant') {
        pg = (await createTwoTenantDatabase()).db;
      } else {
        pg = (await createEmptyFixtureDatabase({ deploymentMode: 'single-tenant' })).db;
        await pg.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [SINGLE_ADMIN, 'admin-521@example.invalid']);
      }
      await pg.query('INSERT INTO admin_users (id) VALUES ($1) ON CONFLICT DO NOTHING', [uploader]);
      edge = await startFakeEdge({ db: pg, documentFilenameFilter: true });
      Object.assign(process.env, fixtureProcessEnv(edge.url));
      process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = mode;
      process.env.MYRAG_DEPLOYMENT_MODE = mode;
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
      await pg?.close();
    });

    beforeEach(() => {
      objectStoreModule.setObjectStoreForTests(fakeStoreModule.createFakeObjectStore());
      depsModule.setIngestDepsForTests({ ingestEnv: () => ON });
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

    const rows = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await pg.query<Row>(sql, params)).rows;
    const labelOf = async (id: string) => (await rows('SELECT version_label FROM documents WHERE id = $1', [id]))[0]?.version_label ?? null;

    const upload = async (filename: string, token: string) => {
      const resolved = await resolver.resolveTenantScope({
        requestedOrganizationId: organizationId,
        deploymentMode: mode,
        getUser: async () => ({ id: uploader }),
        admin: supabaseModule.getSupabaseAdmin(),
        signal: new AbortController().signal,
      });
      assert.ok(resolved.ok && resolved.scope, 'scope must resolve');
      let release: () => void = () => {};
      const done = new Promise<void>((resolve) => {
        release = resolve;
      });
      const result = await ingestModule.ingest({
        scope: resolved.scope,
        source: 'config_upload',
        sourceKey: `root/${filename}`,
        text: body(token),
        filename,
        mimeType: 'text/markdown',
        uploaderId: uploader,
        signal: new AbortController().signal,
      });
      assert.equal(result.status, 'ready');
      const documentId = result.documentId as string;
      finished.set(documentId, release);
      await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 1500))]);
      return documentId;
    };

    test('a title with a version marker and no label gets the marker as its label', async () => {
      const id = await upload('Widget Catalogue v2.md', 'zqxlabelv');
      assert.equal(await labelOf(id), 'v2');
      assert.equal((await rows('SELECT tenant_key FROM documents WHERE id = $1', [id]))[0]?.tenant_key, tenantKey);
    });

    test('a title with two markers keeps both in title order', async () => {
      const id = await upload('Gadget_Sheet_2024_v3.1.md', 'zqxlabeltwo');
      assert.equal(await labelOf(id), '2024 v3.1');
    });

    test('a title without a marker leaves the label null', async () => {
      const id = await upload('Widget Handbook.md', 'zqxlabelnone');
      assert.equal(await labelOf(id), null);
    });

    test('an admin-set label is never overwritten by the detector', async () => {
      const id = await upload('Sprocket Guide v5.md', 'zqxlabeladmin');
      assert.equal(await labelOf(id), 'v5');
      await rows('SELECT public.rag_set_document_version_label($1, $2::uuid, $3)', [tenantKey, id, 'Admin B-2']);
      await detect.runSupersessionDetection({ documentId: id, tenantKey }, new AbortController().signal);
      assert.equal(await labelOf(id), 'Admin B-2');
    });

    test('with the detector off nothing is filled', async () => {
      depsModule.setIngestDepsForTests({ ingestEnv: () => ({ ...ON, RAG_SUPERSESSION_DETECT: 'off' }) });
      postPublish.resetPostPublishHooksForTests();
      postPublish.registerPostPublishHook('test-probe', (event) => {
        finished.get(event.documentId)?.();
      });
      const id = await upload('Bracket Notes v9.md', 'zqxlabeloff');
      assert.equal(await labelOf(id), null);
    });
  });
}
