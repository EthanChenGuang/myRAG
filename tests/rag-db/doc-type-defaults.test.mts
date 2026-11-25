import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createFixtureDatabase, type DeploymentMode, type FixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase } from '../../eval/harness/two-tenant.mts';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { loadIngestConfig } from '@/lib/rag/ingest/config';
import { DocTypeDefaultsError, deleteDocTypeDefault, getDocTypeDefaults, resolveDocType, setDocTypeDefault } from '@/lib/rag/ingest/profiles/resolve-doc-type';
import { mintScope, scopeKey, type TenantScope } from '@/lib/rag/tenant/scope';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REAL_CORPUS = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const FUNCTIONS = ['rag_get_doc_type_defaults', 'rag_set_doc_type_default', 'rag_delete_doc_type_default'];
const FOREIGN_KEY = 'u:00000000-0000-4000-8000-000000000999';

type Row = Record<string, unknown>;

/** The Supabase client contract over PGlite: named arguments, one row set back, the database message on error. */
function pgliteRpc(db: PGlite): RpcClient {
  return {
    rpc(fn, args) {
      const keys = Object.keys(args);
      const sql = `SELECT * FROM ${fn}(${keys.map((key, index) => `${key} => $${index + 1}`).join(', ')})`;
      const run = db
        .query<Row>(
          sql,
          keys.map((key) => args[key]),
        )
        .then((result): RpcResponse => ({ data: result.rows, error: null }))
        .catch((error: unknown): RpcResponse => ({ data: null, error: { code: 'P0001', message: error instanceof Error ? error.message : String(error) } }));
      const request: RpcRequest = {
        abortSignal: () => request,
        then: (onFulfilled, onRejected) => run.then(onFulfilled, onRejected),
      };
      return request;
    },
  };
}

async function failureOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'accepted';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

for (const mode of MODES) {
  describe(`rag_doc_type_defaults (${mode})`, () => {
    let fixture: FixtureDatabase;
    let db: PGlite;
    let scopeA: TenantScope;
    let scopeB: TenantScope | null = null;
    let keyA: string;
    let keyB: string | null = null;
    const signal = new AbortController().signal;
    const deps = () => ({ db: () => pgliteRpc(db), config: loadIngestConfig({}), signal });

    before(async () => {
      if (mode === 'single-tenant') {
        fixture = await createFixtureDatabase({ deploymentMode: mode, corpusDir: REAL_CORPUS });
        scopeA = mintScope('single', null, null);
      } else {
        fixture = await createTwoTenantDatabase();
        scopeA = mintScope('personal', TWO_TENANT_IDS.userA, null);
        scopeB = mintScope('personal', TWO_TENANT_IDS.userB, null);
        keyB = scopeKey(scopeB).toLowerCase();
      }
      db = fixture.db;
      keyA = scopeKey(scopeA).toLowerCase();
    });

    after(async () => {
      await fixture?.db.close();
    });

    const requireSchema = async (): Promise<void> => {
      const table = await db.query<{ present: boolean }>("SELECT to_regclass('public.rag_doc_type_defaults') IS NOT NULL AS present");
      assert.equal(table.rows[0]?.present, true, 'migration 0312 must create rag_doc_type_defaults');
      const functions = await db.query<{ proname: string }>('SELECT proname FROM pg_proc WHERE pronamespace = $1::regnamespace AND proname = ANY($2)', ['public', FUNCTIONS]);
      assert.deepEqual(functions.rows.map((row) => row.proname).sort(), [...FUNCTIONS].sort(), 'migration 0312 must define the three functions');
    };

    const set = (tenantKey: string, kind: string, ref: string | null, docType: string, actor: string | null = 'admin-1') =>
      db.query<Row>('SELECT * FROM rag_set_doc_type_default($1, $2, $3, $4, $5)', [tenantKey, kind, ref, docType, actor]);

    test('the table is closed to anon and authenticated, open to service_role, RLS on with no policies', async () => {
      await requireSchema();
      const privileges = await db.query<{ anon: boolean; authenticated: boolean; service: boolean; rls: boolean }>(
        `SELECT has_table_privilege('anon', 'public.rag_doc_type_defaults', 'SELECT,INSERT,UPDATE,DELETE')
                  OR has_table_privilege('anon', 'public.rag_doc_type_defaults', 'SELECT') AS anon,
                has_table_privilege('authenticated', 'public.rag_doc_type_defaults', 'SELECT')
                  OR has_table_privilege('authenticated', 'public.rag_doc_type_defaults', 'INSERT')
                  OR has_table_privilege('authenticated', 'public.rag_doc_type_defaults', 'UPDATE')
                  OR has_table_privilege('authenticated', 'public.rag_doc_type_defaults', 'DELETE') AS authenticated,
                has_table_privilege('service_role', 'public.rag_doc_type_defaults', 'SELECT,INSERT,UPDATE,DELETE') AS service,
                (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.rag_doc_type_defaults'::regclass) AS rls`,
      );
      assert.deepEqual(privileges.rows[0], { anon: false, authenticated: false, service: true, rls: true });
      const policies = await db.query("SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'rag_doc_type_defaults'");
      assert.equal(policies.rows.length, 0);
    });

    test('the three functions are executable by service_role only, and anon and authenticated are refused when they call', async () => {
      await requireSchema();
      const exposure = await db.query<{ proname: string; anon: boolean; authenticated: boolean; service: boolean }>(
        `SELECT p.proname, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
                has_function_privilege('service_role', p.oid, 'EXECUTE') AS service
         FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY($1) ORDER BY p.proname`,
        [FUNCTIONS],
      );
      assert.equal(exposure.rows.length, FUNCTIONS.length);
      for (const row of exposure.rows) assert.deepEqual({ anon: row.anon, authenticated: row.authenticated, service: row.service }, { anon: false, authenticated: false, service: true }, row.proname);

      for (const role of ['anon', 'authenticated']) {
        await db.exec(`SET ROLE ${role}`);
        try {
          const write = await failureOf(() => db.query("SELECT * FROM rag_set_doc_type_default($1, 'tenant', NULL, 'invoice_receipt', 'attacker')", [keyA]));
          assert.match(write, /permission denied/, `${role} must not be able to set a default`);
          const read = await failureOf(() => db.query('SELECT * FROM rag_get_doc_type_defaults($1, NULL, NULL, NULL)', [keyA]));
          assert.match(read, /permission denied/, `${role} must not be able to read the defaults through the function`);
          const remove = await failureOf(() => db.query("SELECT * FROM rag_delete_doc_type_default($1, 'tenant', NULL)", [keyA]));
          assert.match(remove, /permission denied/, `${role} must not be able to delete a default`);
          const table = await failureOf(() => db.query('SELECT * FROM rag_doc_type_defaults'));
          assert.match(table, /permission denied/, `${role} must not read the table directly`);
        } finally {
          await db.exec('RESET ROLE');
        }
      }
      const stored = await db.query("SELECT 1 FROM rag_doc_type_defaults WHERE updated_by = 'attacker'");
      assert.equal(stored.rows.length, 0);
    });

    test('setting a default upserts one row per tenant, kind and ref and records who and when', async () => {
      await requireSchema();
      const first = await set(keyA, 'tenant', null, 'invoice_receipt', 'admin-1');
      assert.equal(first.rows[0]?.doc_type, 'invoice_receipt');
      assert.equal(first.rows[0]?.tenant_key, keyA);
      await db.query("UPDATE rag_doc_type_defaults SET updated_at = now() - interval '1 hour' WHERE tenant_key = $1 AND source_kind = 'tenant'", [keyA]);
      const second = await set(keyA, 'tenant', null, 'auto', 'admin-2');
      assert.equal(second.rows[0]?.doc_type, 'auto');
      const rows = await db.query<Row>("SELECT doc_type, updated_by, updated_at > now() - interval '1 minute' AS fresh FROM rag_doc_type_defaults WHERE tenant_key = $1 AND source_kind = 'tenant'", [keyA]);
      assert.equal(rows.rows.length, 1, 'a null ref must not allow a second tenant row');
      assert.deepEqual(rows.rows[0], { doc_type: 'auto', updated_by: 'admin-2', fresh: true });
      await set(keyA, 'nango', 'folder-1', 'financial_report');
      await set(keyA, 'nango', 'folder-1', 'contract_legal');
      await set(keyA, 'nango', 'conn-1', 'financial_report');
      await set(keyA, 'nango', null, 'general');
      const nango = await db.query<Row>("SELECT source_ref, doc_type FROM rag_doc_type_defaults WHERE tenant_key = $1 AND source_kind = 'nango' ORDER BY source_ref NULLS FIRST", [keyA]);
      assert.deepEqual(nango.rows, [
        { source_ref: null, doc_type: 'general' },
        { source_ref: 'conn-1', doc_type: 'financial_report' },
        { source_ref: 'folder-1', doc_type: 'contract_legal' },
      ]);
    });

    test('an unknown type, an unknown source kind, a ref on a kind without refs, a blank actor and a malformed tenant key are refused', async () => {
      await requireSchema();
      const cases: Array<[string, () => Promise<unknown>, RegExp]> = [
        ['unknown type', () => set(keyA, 'tenant', null, 'memo'), /invalid_doc_type/],
        ['unknown source kind', () => set(keyA, 'email', null, 'general'), /invalid_source_kind/],
        ['ai_to_rag takes no default of its own', () => set(keyA, 'ai_to_rag', null, 'general'), /invalid_source_kind/],
        ['ref on chat_upload', () => set(keyA, 'chat_upload', 'x', 'general'), /invalid_argument/],
        ['ref on tenant', () => set(keyA, 'tenant', 'x', 'general'), /invalid_argument/],
        ['blank ref', () => set(keyA, 'nango', '  ', 'general'), /invalid_argument/],
        ['blank actor', () => set(keyA, 'tenant', null, 'general', '  '), /actor_required|invalid_argument/],
        ['null actor', () => set(keyA, 'tenant', null, 'general', null), /actor_required|invalid_argument/],
        ['upper-case tenant key', () => set(keyA.toUpperCase(), 'tenant', null, 'general'), /invalid_tenant_key/],
        ['free-text tenant key', () => set('acme', 'tenant', null, 'general'), /invalid_tenant_key/],
        ['null tenant key', () => set(null as unknown as string, 'tenant', null, 'general'), /invalid_tenant_key|invalid_argument/],
        ['foreign-mode tenant key', () => set(mode === 'single-tenant' ? FOREIGN_KEY : 's:default', 'tenant', null, 'general'), /invalid_tenant_key/],
      ];
      for (const [label, run, expected] of cases) {
        assert.match(await failureOf(run), expected, label);
      }
    });

    test('reading returns only the rows of the tenant asked for, narrowed by source, connection and folder', async () => {
      await requireSchema();
      await set(keyA, 'tenant', null, 'financial_report');
      await set(keyA, 'chat_upload', null, 'product_technical');
      await set(keyA, 'nango', null, 'general');
      await set(keyA, 'nango', 'conn-1', 'invoice_receipt');
      await set(keyA, 'nango', 'folder-1', 'contract_legal');
      await set(keyA, 'nango', 'folder-2', 'scanned_image');
      const read = async (source: string | null, conn: string | null, folder: string | null) =>
        (await db.query<Row>('SELECT source_kind, source_ref, doc_type, tenant_key FROM rag_get_doc_type_defaults($1, $2, $3, $4)', [keyA, source, conn, folder])).rows;
      const all = await read(null, null, null);
      assert.ok(all.length >= 6);
      assert.ok(all.every((row) => row.tenant_key === keyA));

      const chat = await read('chat_upload', null, null);
      assert.deepEqual(chat.map((row) => `${row.source_kind}:${row.source_ref ?? '-'}`).sort(), ['chat_upload:-', 'tenant:-']);

      const nango = await read('nango', 'conn-1', 'folder-1');
      assert.deepEqual(nango.map((row) => `${row.source_kind}:${row.source_ref ?? '-'}`).sort(), ['nango:-', 'nango:conn-1', 'nango:folder-1', 'tenant:-']);

      const unrelated = await read('nango', 'conn-9', 'folder-9');
      assert.deepEqual(unrelated.map((row) => `${row.source_kind}:${row.source_ref ?? '-'}`).sort(), ['nango:-', 'tenant:-']);

      const scraper = await read('scraper', 'conn-1', 'folder-1');
      assert.deepEqual(scraper.map((row) => `${row.source_kind}:${row.source_ref ?? '-'}`), ['tenant:-'], 'nango refs must not apply to another source');
    });

    test('a default can be removed, and removing a missing one reports false', async () => {
      await requireSchema();
      await set(keyA, 'nango', 'folder-del', 'general');
      const removed = await db.query<{ deleted: boolean }>("SELECT * FROM rag_delete_doc_type_default($1, 'nango', 'folder-del')", [keyA]);
      assert.equal(removed.rows[0]?.deleted, true);
      const again = await db.query<{ deleted: boolean }>("SELECT * FROM rag_delete_doc_type_default($1, 'nango', 'folder-del')", [keyA]);
      assert.equal(again.rows[0]?.deleted, false);
      assert.match(await failureOf(() => db.query("SELECT * FROM rag_delete_doc_type_default('acme', 'tenant', NULL)")), /invalid_tenant_key/);
    });

    test('the TypeScript layer resolves, lists, sets and deletes through the real functions', async () => {
      await requireSchema();
      await db.query('DELETE FROM rag_doc_type_defaults');
      await setDocTypeDefault(scopeA, { sourceKind: 'tenant', docType: 'financial_report', updatedBy: 'admin-1' }, deps());
      await setDocTypeDefault(scopeA, { sourceKind: 'nango', sourceRef: 'folder-1', docType: 'contract_legal', updatedBy: 'admin-1' }, deps());
      const nango = await resolveDocType(scopeA, { source: 'nango', nangoFolderId: 'folder-1', nangoConnectionId: 'conn-1', filename: 'a.md', mimeType: 'text/markdown' }, deps());
      assert.deepEqual([nango.docType, nango.origin], ['contract_legal', 'source_default']);
      const chat = await resolveDocType(scopeA, { source: 'chat_upload', filename: 'a.md', mimeType: 'text/markdown' }, deps());
      assert.deepEqual([chat.docType, chat.origin], ['financial_report', 'tenant_default']);
      const listed = await getDocTypeDefaults(scopeA, undefined, deps());
      assert.deepEqual(listed.map((row) => `${row.sourceKind}:${row.sourceRef ?? '-'}:${row.docType}`).sort(), ['nango:folder-1:contract_legal', 'tenant:-:financial_report']);
      assert.equal(await deleteDocTypeDefault(scopeA, { sourceKind: 'nango', sourceRef: 'folder-1' }, deps()), true);
      const after = await resolveDocType(scopeA, { source: 'nango', nangoFolderId: 'folder-1', filename: 'a.md', mimeType: 'text/markdown' }, deps());
      assert.deepEqual([after.docType, after.origin], ['financial_report', 'tenant_default']);
      const refused = await setDocTypeDefault(scopeA, { sourceKind: 'tenant', docType: 'general', updatedBy: 'admin-1' }, { ...deps(), db: () => ({ rpc: () => { throw new DocTypeDefaultsError('x', null); } }) }).catch((error: unknown) => error);
      assert.ok(refused instanceof DocTypeDefaultsError);
    });

    if (mode === 'single-tenant') {
      test('single-tenant refuses a key that is not s:default, so no second tenant can hold defaults', async () => {
        await requireSchema();
        assert.equal(keyA, 's:default');
        assert.match(await failureOf(() => set(FOREIGN_KEY, 'tenant', null, 'invoice_receipt')), /invalid_tenant_key/);
        const rows = await db.query('SELECT 1 FROM rag_doc_type_defaults WHERE tenant_key <> $1', [keyA]);
        assert.equal(rows.rows.length, 0);
      });
    } else {
      test('defaults of tenant A never affect tenant B, including a Nango folder with the same ref string', async () => {
        await requireSchema();
        assert.ok(scopeB && keyB);
        await db.query('DELETE FROM rag_doc_type_defaults');
        await setDocTypeDefault(scopeA, { sourceKind: 'tenant', docType: 'invoice_receipt', updatedBy: 'admin-a' }, deps());
        await setDocTypeDefault(scopeA, { sourceKind: 'nango', sourceRef: 'folder-1', docType: 'contract_legal', updatedBy: 'admin-a' }, deps());
        await setDocTypeDefault(scopeA, { sourceKind: 'chat_upload', docType: 'financial_report', updatedBy: 'admin-a' }, deps());

        const bInput = { source: 'nango' as const, nangoFolderId: 'folder-1', nangoConnectionId: 'conn-1', filename: 'a.md', mimeType: 'text/markdown' };
        const b = await resolveDocType(scopeB as TenantScope, bInput, deps());
        assert.deepEqual([b.docType, b.origin], ['general', 'fallback']);
        const bChat = await resolveDocType(scopeB as TenantScope, { source: 'chat_upload', filename: 'a.md', mimeType: 'text/markdown' }, deps());
        assert.deepEqual([bChat.docType, bChat.origin], ['general', 'fallback']);
        assert.deepEqual(await getDocTypeDefaults(scopeB as TenantScope, undefined, deps()), []);

        const a = await resolveDocType(scopeA, bInput, deps());
        assert.deepEqual([a.docType, a.origin], ['contract_legal', 'source_default']);

        await setDocTypeDefault(scopeB as TenantScope, { sourceKind: 'nango', sourceRef: 'folder-1', docType: 'scanned_image', updatedBy: 'admin-b' }, deps());
        const aAgain = await resolveDocType(scopeA, bInput, deps());
        assert.equal(aAgain.docType, 'contract_legal', 'B setting the same folder ref must not change A');
        const bAgain = await resolveDocType(scopeB as TenantScope, bInput, deps());
        assert.equal(bAgain.docType, 'scanned_image');
        assert.equal(await deleteDocTypeDefault(scopeB as TenantScope, { sourceKind: 'tenant' }, deps()), false, 'B has no tenant default to delete, and A keeps its own');
        const tenantA = await db.query('SELECT 1 FROM rag_doc_type_defaults WHERE tenant_key = $1 AND source_kind = $2', [keyA, 'tenant']);
        assert.equal(tenantA.rows.length, 1);
      });

      test('an organization is its own tenant, separate from the personal tenant of its member', async () => {
        await requireSchema();
        const org = mintScope('org', TWO_TENANT_IDS.userA, TWO_TENANT_IDS.orgO);
        await db.query('DELETE FROM rag_doc_type_defaults');
        await setDocTypeDefault(org, { sourceKind: 'tenant', docType: 'product_technical', updatedBy: 'admin-o' }, deps());
        const personal = await resolveDocType(scopeA, { source: 'chat_upload', filename: 'a.md', mimeType: 'text/markdown' }, deps());
        assert.deepEqual([personal.docType, personal.origin], ['general', 'fallback']);
        const inOrg = await resolveDocType(org, { source: 'chat_upload', filename: 'a.md', mimeType: 'text/markdown' }, deps());
        assert.deepEqual([inOrg.docType, inOrg.origin], ['product_technical', 'tenant_default']);
      });
    }
  });
}
