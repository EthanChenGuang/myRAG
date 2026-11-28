import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { createFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';

// Phase 4.3 plan 11 (SEC-12; D-11, D-30, RET-12, RET-13, RET-15, RET-16, XLG-04): the Phase 3.2 and Phase 4.2 legs filter by access group
// (0933). A document labelled only g:<group-a> and an open {all} document share translations, table rows, identifiers and one duplicate
// cluster. The outsider never gets, is never suggested and is never listed the restricted one; member-a and admin_all get both; a call
// without keys returns both while enforcement is off and raises access_scope_required while it is on. Neutral synthetic fixtures.

const id = (kind: string, n: number): string => `00000000-0000-4000-8000-${kind}${String(n).padStart(8, '0')}`;

const IDS = {
  owner: id('9441', 1),
  memberA: id('9441', 2),
  outsider: id('9441', 3),
  org: id('9442', 1),
  restrictedDoc: id('9443', 1),
  openDoc: id('9443', 2),
  restrictedChunk: id('9444', 1),
  openChunk: id('9444', 2),
  cluster: id('9445', 1),
} as const;

const PROFILE = 'openai-3-small-1536';
const WORD = 'zephyrinox';
const RESTRICTED_ID = 'qx41071';
const OPEN_ID = 'qx41072';
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];

type Row = Record<string, unknown>;

for (const mode of MODES) {
  describe(`access filter on the Phase 3.2 and 4.2 legs (${mode})`, () => {
    let db: PGlite;
    let corpusDir: string;
    let groupA: string;
    const multi = mode === 'multi-tenant';
    const tenantKey = multi ? `o:${IDS.org}` : 's:default';
    type Caller = { keys: string[] | null; all: boolean };
    const outsider = (): Caller => ({ keys: ['all', `u:${IDS.outsider}`], all: false });
    const member = (): Caller => ({ keys: ['all', `u:${IDS.memberA}`, `g:${groupA}`], all: false });
    const admin = (): Caller => ({ keys: ['all'], all: true });
    const off = (): Caller => ({ keys: null, all: false });

    async function call(fn: string, args: string, params: unknown[], caller: Caller, enforced = false): Promise<Row[]> {
      const access = caller.keys === null ? '' : `, p_access_keys => $${params.length + 1}::text[], p_access_all => $${params.length + 2}`;
      const all = caller.keys === null ? params : [...params, caller.keys, caller.all];
      await db.exec('BEGIN');
      try {
        if (enforced) await db.query('UPDATE public.rag_access_group_settings SET enforced = true');
        await db.exec('SET LOCAL ROLE service_role');
        return (await db.query<Row>(`SELECT * FROM public.${fn}(${args}${access})`, all)).rows;
      } finally {
        await db.exec('ROLLBACK');
      }
    }

    async function refusal(run: () => Promise<unknown>): Promise<string> {
      try {
        await run();
        return 'accepted';
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }

    const LEGS: Record<string, { fn: string; args: string; params: () => unknown[]; docOf: (row: Row) => unknown }> = {
      translations: {
        fn: 'hybrid_search_translations',
        args: `p_tenant_key => $1, p_profile_id => $2, p_language => 'it', p_query_embedding => NULL, p_lexical_tokens => $3::text[], p_dense_limit => 0, p_lexical_limit => 10`,
        params: () => [tenantKey, PROFILE, [WORD]],
        docOf: (row) => row.document_id,
      },
      table_rows: {
        fn: 'rag_table_lookup',
        args: 'p_tenant_key => $1, p_tokens => $2::text[], p_min_cells => 2, p_limit => 10',
        params: () => [tenantKey, ['cellalpha', 'cellbeta']],
        docOf: (row) => row.document_id,
      },
      identifier_resolve: {
        fn: 'rag_identifier_resolve',
        args: 'p_tenant_key => $1, p_norm => $2::text[]',
        params: () => [tenantKey, [RESTRICTED_ID, OPEN_ID]],
        docOf: (row) => (row.norm === RESTRICTED_ID ? IDS.restrictedDoc : IDS.openDoc),
      },
      identifier_suggestions: {
        fn: 'rag_identifier_candidates',
        args: 'p_tenant_key => $1, p_norm => $2, p_limit => 10',
        params: () => [tenantKey, 'qx41079'],
        docOf: (row) => (row.norm === RESTRICTED_ID ? IDS.restrictedDoc : IDS.openDoc),
      },
      dup_cluster_sources: {
        fn: 'rag_dup_cluster_sources',
        args: 'p_tenant_key => $1, p_cluster_ids => $2::uuid[], p_limit => 30',
        params: () => [tenantKey, [IDS.cluster]],
        docOf: (row) => row.document_id,
      },
    };

    async function documentsOf(leg: string, caller: Caller): Promise<string[]> {
      const spec = LEGS[leg]!;
      const found = await call(spec.fn, spec.args, spec.params(), caller);
      return [...new Set(found.map((row) => String(spec.docOf(row))))].sort();
    }

    before(async () => {
      corpusDir = fs.mkdtempSync(path.join(os.tmpdir(), 'access-seam-legs-corpus-'));
      db = (await createFixtureDatabase({ deploymentMode: mode, corpusDir, supabaseGrants: true })).db;
      for (const [user, email] of [
        [IDS.owner, 'owner@example.invalid'],
        [IDS.memberA, 'member@example.invalid'],
        [IDS.outsider, 'outsider@example.invalid'],
      ] as const) {
        await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING', [user, email]);
      }
      if (multi) {
        await db.query("INSERT INTO organizations (id, name, slug, owner_id, is_personal) VALUES ($1, 'Workspace', 'access-seam-legs', $2, false)", [IDS.org, IDS.owner]);
        for (const user of [IDS.owner, IDS.memberA, IDS.outsider]) {
          await db.query('INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [IDS.org, user, user === IDS.owner ? 'owner' : 'member']);
        }
      }
      groupA = (
        await db.query<{ id: string }>(
          `INSERT INTO rag_access_groups (key, name${multi ? ', organization_id' : ''}) VALUES ('group-a', 'Group A'${multi ? ', $1' : ''}) RETURNING id`,
          multi ? [IDS.org] : [],
        )
      ).rows[0]!.id;

      const docs = [
        { doc: IDS.restrictedDoc, chunk: IDS.restrictedChunk, groups: [`g:${groupA}`], ident: RESTRICTED_ID },
        { doc: IDS.openDoc, chunk: IDS.openChunk, groups: ['all'], ident: OPEN_ID },
      ];
      for (const entry of docs) {
        await db.query(
          `INSERT INTO public.documents (id, filename, content, user_id, access_groups${multi ? ', organization_id' : ''})
           VALUES ($1, $2, 'Neutral synthetic record.', $3, $4::text[]${multi ? ', $5' : ''})`,
          [entry.doc, `${entry.doc}.md`, IDS.owner, entry.groups, ...(multi ? [IDS.org] : [])],
        );
        await db.query(
          `INSERT INTO public.document_chunks (id, document_id, content, chunk_index, identifiers_norm, identifiers_raw)
           VALUES ($1, $2, 'A neutral synthetic sentence with a reference.', 0, $3::text[], $3::text[])`,
          [entry.chunk, entry.doc, [entry.ident]],
        );
        await db.query(
          `INSERT INTO public.chunk_translations (chunk_id, document_id, tenant_key, language, content, lexical_text, source_content_hash, model)
           VALUES ($1, $2, $3, 'it', 'Una frase sintetica neutra.', $4, 'hash', 'test-model')`,
          [entry.chunk, entry.doc, tenantKey, `${WORD} frase sintetica`],
        );
        await db.query(
          `INSERT INTO public.rag_table_rows (tenant_key, document_id, version, is_current, status, table_key, row_index, header, cells, cell_norm, cell_tokens, chunk_ids)
           VALUES ($1, $2, 1, true, 'ready', 't0', 0, ARRAY['a', 'b'], '{"a": "cellalpha", "b": "cellbeta"}'::jsonb,
                   ARRAY['cellalpha', 'cellbeta'], '[["cellalpha"], ["cellbeta"]]'::jsonb, ARRAY[$3::uuid])`,
          [tenantKey, entry.doc, entry.chunk],
        );
      }
      await db.query("INSERT INTO public.rag_dup_clusters (id, tenant_key, embedding_profile_id, member_count) VALUES ($1, $2, $3, 2)", [IDS.cluster, tenantKey, PROFILE]);
      await db.query('UPDATE public.document_chunks SET dup_cluster_id = $1 WHERE id = ANY ($2::uuid[])', [IDS.cluster, [IDS.restrictedChunk, IDS.openChunk]]);
    });

    after(async () => {
      await db?.close();
      if (corpusDir) fs.rmSync(corpusDir, { recursive: true, force: true });
    });

    test('the derived rows carry their document label', async () => {
      for (const table of ['chunk_translations', 'rag_table_rows', 'document_chunks']) {
        const found = await db.query<{ access_groups: string[] }>(`SELECT access_groups FROM public.${table} WHERE document_id = $1`, [IDS.restrictedDoc]);
        assert.deepEqual(found.rows.map((row) => row.access_groups), [[`g:${groupA}`]], table);
      }
    });

    for (const leg of Object.keys(LEGS)) {
      test(`${leg}: the outsider gets only the open document; member-a, admin_all and the switch-off call get both`, async () => {
        const both = [IDS.restrictedDoc, IDS.openDoc].sort();
        assert.deepEqual(await documentsOf(leg, off()), both, 'switch off (no keys)');
        assert.deepEqual(await documentsOf(leg, member()), both, 'member-a');
        assert.deepEqual(await documentsOf(leg, admin()), both, 'admin_all');
        assert.deepEqual(await documentsOf(leg, outsider()), [IDS.openDoc], 'outsider');
      });

      test(`${leg}: no keys while enforcement is on raises access_scope_required; an empty key array raises access_keys_empty`, async () => {
        const spec = LEGS[leg]!;
        assert.match(await refusal(() => call(spec.fn, spec.args, spec.params(), off(), true)), /access_scope_required/);
        assert.match(await refusal(() => call(spec.fn, spec.args, spec.params(), { keys: [], all: false })), /access_keys_empty/);
        assert.equal((await call(spec.fn, spec.args, spec.params(), member(), true)).length > 0, true, 'member-a under enforcement');
      });
    }

    test('identifier suggestions never name an identifier found only in a restricted document', async () => {
      const spec = LEGS.identifier_suggestions!;
      const suggested = (caller: Caller) => call(spec.fn, spec.args, spec.params(), caller).then((found) => found.map((row) => row.norm).sort());
      assert.deepEqual(await suggested(outsider()), [OPEN_ID]);
      assert.deepEqual(await suggested(member()), [RESTRICTED_ID, OPEN_ID].sort());
    });

    test('each leg has exactly one overload, executable by service_role only', async () => {
      for (const spec of Object.values(LEGS)) {
        const found = await db.query<{ sig: string; anon: boolean; authed: boolean; service: boolean }>(
          `SELECT p.oid::regprocedure::text AS sig,
                  has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
                  has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authed,
                  has_function_privilege('service_role', p.oid, 'EXECUTE') AS service
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = $1`,
          [spec.fn],
        );
        assert.equal(found.rows.length, 1, spec.fn);
        assert.deepEqual([found.rows[0]!.anon, found.rows[0]!.authed, found.rows[0]!.service], [false, false, true], found.rows[0]!.sig);
      }
    });
  });
}
