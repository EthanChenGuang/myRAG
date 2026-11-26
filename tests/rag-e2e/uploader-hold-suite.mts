import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { createEmptyFixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

// Shared suite of plan 05.2-17 (D-46), run once per deployment mode by uploader-hold.test.mts and uploader-hold-single.test.mts:: an upload whose uploader has an active hold takes the Phase 3.2 pending_review path whatever RAG_UPLOAD_APPROVAL
// is; a run that passed identify before the hold is held at publish; a release approves nothing; RAG_UPLOADER_HOLD=off changes nothing.

type Row = Record<string, unknown>;
type Query = <T = Row>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;

interface ModeSetup {
  name: string;
  deploymentMode: 'single-tenant' | 'multi-tenant';
  tenantKey: string;
  organizationId: string | null;
  admin: string;
  held: string;
  other: string;
  open: () => Promise<{ query: Query; close: () => Promise<void> }>;
}

const SINGLE_ADMIN = '00000000-0000-4000-8000-0000000017b1';
const SINGLE_HELD = '00000000-0000-4000-8000-0000000017b2';
const SINGLE_OTHER = '00000000-0000-4000-8000-0000000017b3';
const MULTI_HELD = '00000000-0000-4000-8000-0000000017c2';
const MULTI_OTHER = '00000000-0000-4000-8000-0000000017c3';

export const UPLOADER_HOLD_MODES: Record<'single' | 'multi', ModeSetup> = {
  single:
  {
    name: 'single-tenant',
    deploymentMode: 'single-tenant',
    tenantKey: 's:default',
    organizationId: null,
    admin: SINGLE_ADMIN,
    held: SINGLE_HELD,
    other: SINGLE_OTHER,
    open: async () => {
      const fixture = await createEmptyFixtureDatabase({ deploymentMode: 'single-tenant' });
      const query = fixture.db.query.bind(fixture.db) as Query;
      await query('INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4), ($5, $6)', [
        SINGLE_ADMIN,
        'admin-17@example.invalid',
        SINGLE_HELD,
        'held-17@example.invalid',
        SINGLE_OTHER,
        'other-17@example.invalid',
      ]);
      await query('INSERT INTO admin_users (id) VALUES ($1)', [SINGLE_ADMIN]);
      return { query, close: () => fixture.db.close(), db: fixture.db } as never;
    },
  },
  multi: {
    name: 'multi-tenant',
    deploymentMode: 'multi-tenant',
    tenantKey: `o:${TWO_TENANT_IDS.orgO}`,
    organizationId: TWO_TENANT_IDS.orgO,
    admin: TWO_TENANT_IDS.userA,
    held: MULTI_HELD,
    other: MULTI_OTHER,
    open: async () => {
      const fixture = await createTwoTenantDatabase();
      const query = fixture.db.query.bind(fixture.db) as Query;
      await query('INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4)', [MULTI_HELD, 'held-17@example.invalid', MULTI_OTHER, 'other-17@example.invalid']);
      await query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member')", [
        TWO_TENANT_IDS.orgO,
        MULTI_HELD,
        MULTI_OTHER,
      ]);
      await query("UPDATE organization_members SET role = 'owner' WHERE organization_id = $1 AND user_id = $2", [TWO_TENANT_IDS.orgO, TWO_TENANT_IDS.userA]);
      await query('INSERT INTO admin_users (id) VALUES ($1)', [TWO_TENANT_IDS.userA]);
      return { query, close: () => fixture.db.close(), db: fixture.db } as never;
    },
  },
};

function note(token: string): { filename: string; text: string } {
  return { filename: `notes-${token}.md`, text: `# Notes ${token}\n\nThe ${token} widget rests on the lower shelf beside the copper rail and the oak frame.\n` };
}

export function runUploaderHoldSuite(mode: ModeSetup): void {
  describe(`uploader hold on the unified path (${mode.name})`, () => {
    let query: Query;
    let close: () => Promise<void>;
    let edge: FakeEdge;
    let ingestModule: typeof import('@/lib/rag/ingest');
    let depsModule: typeof import('@/lib/rag/ingest/deps');
    let objectStoreModule: typeof import('@/lib/rag/ingest/object-store');
    let fakeStoreModule: typeof import('../helpers/fake-object-store');
    let resolver: typeof import('@/lib/rag/tenant/resolve-chat');
    let supabaseModule: typeof import('@/lib/supabase');
    let approvalAdmin: typeof import('@/lib/rag/ingest/approval/admin');
    const saved = new Map<string, string | undefined>();
    const heldDocuments: string[] = [];

    before(async () => {
      const opened = (await mode.open()) as unknown as { query: Query; close: () => Promise<void>; db: Parameters<typeof startFakeEdge>[0]['db'] };
      query = opened.query;
      close = opened.close;
      edge = await startFakeEdge({ db: opened.db, documentFilenameFilter: true });
      const fixtureEnv: Record<string, string> = {
        ...fixtureProcessEnv(edge.url),
        NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE: mode.deploymentMode,
        MYRAG_DEPLOYMENT_MODE: mode.deploymentMode,
      };
      for (const name of [...Object.keys(fixtureEnv), 'RAG_UPLOADER_HOLD']) saved.set(name, process.env[name]);
      Object.assign(process.env, fixtureEnv);
      ingestModule = await import('@/lib/rag/ingest');
      depsModule = await import('@/lib/rag/ingest/deps');
      objectStoreModule = await import('@/lib/rag/ingest/object-store');
      fakeStoreModule = await import('../helpers/fake-object-store');
      resolver = await import('@/lib/rag/tenant/resolve-chat');
      supabaseModule = await import('@/lib/supabase');
      approvalAdmin = await import('@/lib/rag/ingest/approval/admin');
    });

    after(async () => {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await edge?.close();
      await close?.();
    });

    beforeEach(() => {
      objectStoreModule.setObjectStoreForTests(fakeStoreModule.createFakeObjectStore());
      depsModule.setIngestDepsForTests({ ingestEnv: () => ({}) });
    });

    afterEach(() => {
      objectStoreModule.resetObjectStoreForTests();
      depsModule.resetIngestDepsForTests();
      delete process.env.RAG_UPLOADER_HOLD;
    });

    const scopeOf = async (userId: string) => {
      const resolved = await resolver.resolveTenantScope({
        requestedOrganizationId: mode.organizationId,
        deploymentMode: mode.deploymentMode,
        getUser: async () => ({ id: userId }),
        admin: supabaseModule.getSupabaseAdmin(),
        signal: new AbortController().signal,
      });
      assert.ok(resolved.ok && resolved.scope, 'scope must resolve');
      return resolved.scope;
    };

    const upload = async (userId: string | null, token: string) => {
      const entry = note(token);
      return ingestModule.ingest({
        scope: await scopeOf(userId ?? mode.admin),
        source: 'config_upload',
        sourceKey: `root/${entry.filename}`,
        text: entry.text,
        filename: entry.filename,
        mimeType: 'text/markdown',
        ...(userId !== null ? { uploaderId: userId } : {}),
        signal: new AbortController().signal,
      });
    };

    const documentOf = async (id: string) =>
      (await query('SELECT status, is_current, tenant_key, processing_state FROM documents WHERE id = $1', [id])).rows[0] as Row;
    const hold = (userId: string) => query("SELECT public.rag_hold_uploader($1, $2, $3, 'test') AS outcome", [mode.tenantKey, userId, mode.admin]);
    const release = (userId: string) => query('SELECT public.rag_release_uploader_hold($1, $2, $3) AS outcome', [mode.tenantKey, userId, mode.admin]);
    const holdCalls = () => edge.calls.filter((call) => /rag_uploader_hold_active|rag_active_uploader_holds/.test(call.path)).length;

    test('manual: a held uploader\'s upload ends pending_review with RAG_UPLOAD_APPROVAL off; another uploader publishes', async () => {
      process.env.RAG_UPLOADER_HOLD = 'manual';
      await hold(mode.held);
      const held = await upload(mode.held, 'zqxheld1');
      assert.equal(held.status, 'pending_review');
      assert.ok(held.chunkCount >= 1, 'the version is written in full');
      const row = await documentOf(held.documentId);
      assert.deepEqual([row.status, row.is_current, row.tenant_key], ['pending_review', false, mode.tenantKey]);
      const approval = (row.processing_state as Row).approval as Row;
      assert.equal(approval.required, true);
      assert.equal(approval.reason, 'uploader_hold');
      assert.equal(approval.uploader_id, mode.held);
      const chunks = (await query('SELECT status, is_current FROM document_chunks WHERE document_id = $1', [held.documentId])).rows;
      for (const chunk of chunks) assert.deepEqual([chunk.status, chunk.is_current], ['pending_review', false]);
      heldDocuments.push(held.documentId);

      const other = await upload(mode.other, 'zqxother1');
      assert.equal(other.status, 'ready');
      const otherRow = await documentOf(other.documentId);
      assert.deepEqual([otherRow.status, otherRow.is_current], ['ready', true]);
      assert.equal('approval' in (otherRow.processing_state as Row), false, 'no approval state for an uploader without a hold');
    });

    test('a run that passed identify before the hold is held at publish', async () => {
      process.env.RAG_UPLOADER_HOLD = 'manual';
      const original = depsModule.getIngestDeps().embedDocuments;
      let placed = false;
      depsModule.setIngestDepsForTests({
        embedDocuments: async (texts, opts) => {
          if (!placed) {
            placed = true;
            await hold(mode.other);
          }
          return original(texts, opts);
        },
      });
      const result = await upload(mode.other, 'zqxlate1');
      assert.equal(placed, true, 'the hold was placed after identify');
      assert.equal(result.status, 'pending_review');
      const row = await documentOf(result.documentId);
      assert.deepEqual([row.status, row.is_current], ['pending_review', false]);
      assert.equal(((row.processing_state as Row).approval as Row).reason, 'uploader_hold');
      heldDocuments.push(result.documentId);
    });

    test('releasing the holds leaves the documents pending; the Phase 3.2 approval publishes them', async () => {
      assert.equal(heldDocuments.length, 2);
      await release(mode.held);
      await release(mode.other);
      for (const id of heldDocuments) assert.equal((await documentOf(id)).status, 'pending_review');
      for (const id of heldDocuments) {
        const approved = await approvalAdmin.approveUpload({ actorUserId: mode.admin, tenantKey: mode.tenantKey, documentId: id, signal: new AbortController().signal });
        assert.equal(approved.ok, true, JSON.stringify(approved));
        const row = await documentOf(id);
        assert.deepEqual([row.status, row.is_current], ['ready', true]);
      }
    });

    test('a hold does not touch an already published document', async () => {
      const published = await upload(mode.held, 'zqxbefore1');
      assert.equal(published.status, 'ready');
      process.env.RAG_UPLOADER_HOLD = 'manual';
      await hold(mode.held);
      const row = await documentOf(published.documentId);
      assert.deepEqual([row.status, row.is_current], ['ready', true]);
      await release(mode.held);
    });

    test('an upload without an uploader is never held and asks for no hold', async () => {
      process.env.RAG_UPLOADER_HOLD = 'manual';
      const before = holdCalls();
      const result = await upload(null, 'zqxnobody1');
      if (mode.deploymentMode === 'single-tenant') {
        assert.equal(result.status, 'ready');
        assert.equal(holdCalls(), before, 'no hold lookup without an uploader');
      } else {
        // A multi-tenant scope carries its verified user, which is the uploader; only an unknown user goes without a lookup.
        assert.equal(result.status, 'ready');
      }
    });

    test('off: a held uploader\'s upload publishes exactly as before, with no hold lookup', async () => {
      await hold(mode.held);
      try {
        const before = holdCalls();
        const result = await upload(mode.held, 'zqxoff1');
        assert.equal(result.status, 'ready');
        assert.equal(result.reason, undefined);
        assert.equal(holdCalls(), before, 'no hold RPC with the switch off');
        const row = await documentOf(result.documentId);
        assert.deepEqual([row.status, row.is_current], ['ready', true]);
        assert.equal('approval' in (row.processing_state as Row), false);
      } finally {
        await release(mode.held);
      }
    });
  });
}
