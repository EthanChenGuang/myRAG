import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { createFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';

// Phase 4.3 plan 10 (SEC-12; D-10, D-11, D-12, D-13, A-04, A-09): every other SQL function that returns chunk or document content filters by
// access group before ranking, or refuses while enforcement is on. Each case seeds a document labelled only g:<group-a> and an open {all}
// document in the same tenant; the outsider never gets a row of the restricted document (forged ids, exact text, limit 1), member-a and
// admin_all get it, a call without keys raises access_scope_required while enforcement is on. Fixtures are neutral synthetic sentences.

const id = (kind: string, n: number): string => `00000000-0000-4000-8000-${kind}${String(n).padStart(8, '0')}`;

const IDS = {
  owner: id('9431', 1),
  memberA: id('9431', 2),
  outsider: id('9431', 3),
  org: id('9432', 1),
  restrictedDoc: id('9433', 1),
  openDoc: id('9433', 2),
  bulkDoc: id('9433', 3),
  recallDoc: id('9433', 4),
  restrictedChunk: id('9434', 1),
  restrictedLexChunk: id('9434', 2),
  openChunk: id('9434', 3),
  restrictedParent: id('9435', 1),
  openParent: id('9435', 2),
} as const;

const PROFILE = 'test-access-1536';
const DIMS = 1536;
const RESTRICTED_INVOICE = 'qx-7731-zeph';
const RESTRICTED_TOKEN = 'quillmarrow-4417';
const OPEN_INVOICE = 'qx-7732-open';
const RECALL_ROWS = 10;
const BULK_ROWS = 1200;

type Row = Record<string, unknown>;
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];

/** A deterministic unit-free vector literal; seed picks the direction. */
function vector(seed: number): string {
  const values: string[] = [];
  let x = seed * 9301 + 49297;
  for (let i = 0; i < DIMS; i += 1) {
    x = (x * 9301 + 49297) % 233280;
    values.push((x / 233280 - 0.5).toFixed(5));
  }
  return `[${values.join(',')}]`;
}

async function rows<T = Row>(db: PGlite, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

async function asServiceRole<T>(db: PGlite, run: () => Promise<T>): Promise<T> {
  await db.exec('SET ROLE service_role');
  try {
    return await run();
  } finally {
    await db.exec('RESET ROLE');
  }
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
  describe(`access predicate on the other content functions (${mode})`, () => {
    let db: PGlite;
    let corpusDir: string;
    let groupA: string;
    let groupB: string;
    const multi = mode === 'multi-tenant';
    const tenantKey = multi ? `o:${IDS.org}` : 's:default';
    const outsiderKeys = (): string[] => ['all', `u:${IDS.outsider}`];
    const memberKeys = (): string[] => ['all', `u:${IDS.memberA}`, `g:${groupA}`];
    const groupBKeys = (): string[] => ['all', `u:${IDS.outsider}`, `g:${groupB}`];
    type Caller = { name: string; keys: string[] | null; all: boolean };
    const callers = (): Record<'outsider' | 'member' | 'admin' | 'off', Caller> => ({
      outsider: { name: 'outsider', keys: outsiderKeys(), all: false },
      member: { name: 'member-a', keys: memberKeys(), all: false },
      admin: { name: 'admin_all', keys: ['all'], all: true },
      off: { name: 'switch off', keys: null, all: false },
    });

    async function insertDocument(docId: string, groups: string[], extra: Row = {}): Promise<void> {
      const columns = ['id', 'filename', 'content', 'user_id', 'access_groups', ...(multi ? ['organization_id'] : []), ...Object.keys(extra)];
      const values: unknown[] = [docId, `${docId}.md`, 'Neutral synthetic record.', IDS.owner, groups, ...(multi ? [IDS.org] : []), ...Object.values(extra)];
      await db.query(
        `INSERT INTO public.documents (${columns.join(', ')}) VALUES (${values.map((_, i) => (i === 4 ? `$${i + 1}::text[]` : `$${i + 1}`)).join(', ')})`,
        values,
      );
    }

    async function insertChunk(docId: string, chunkId: string | null, index: number, content: string, embedding: string, extra: Row = {}): Promise<string> {
      const columns = ['id', 'document_id', 'content', 'chunk_index', 'embedding', ...Object.keys(extra)];
      const values: unknown[] = [chunkId, docId, content, index, embedding, ...Object.values(extra)];
      const result = await rows<{ id: string }>(
        db,
        `INSERT INTO public.document_chunks (${columns.join(', ')})
         VALUES (COALESCE($1::uuid, gen_random_uuid()), ${values.slice(1).map((_, i) => `$${i + 2}`).join(', ')}) RETURNING id`,
        values,
      );
      return result[0]!.id;
    }

    async function withEnforcement<T>(run: () => Promise<T>): Promise<T> {
      await db.query('UPDATE public.rag_access_group_settings SET enforced = true');
      try {
        return await run();
      } finally {
        await db.query('UPDATE public.rag_access_group_settings SET enforced = false');
      }
    }

    function accessArgs(caller: Caller, offset: number): { sql: string; params: unknown[] } {
      if (caller.keys === null) return { sql: '', params: [] };
      return { sql: `, p_access_keys => $${offset}::text[], p_access_all => $${offset + 1}`, params: [caller.keys, caller.all] };
    }

    before(async () => {
      corpusDir = fs.mkdtempSync(path.join(os.tmpdir(), 'access-retrieval-corpus-'));
      db = (await createFixtureDatabase({ deploymentMode: mode, corpusDir, supabaseGrants: true })).db;
      for (const [user, email] of [
        [IDS.owner, 'owner@example.invalid'],
        [IDS.memberA, 'member@example.invalid'],
        [IDS.outsider, 'outsider@example.invalid'],
      ] as const) {
        await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING', [user, email]);
      }
      await db.query('INSERT INTO admin_users (id) VALUES ($1) ON CONFLICT DO NOTHING', [IDS.owner]);
      if (multi) {
        await db.query("INSERT INTO organizations (id, name, slug, owner_id, is_personal) VALUES ($1, 'Workspace', 'access-retrieval', $2, false)", [IDS.org, IDS.owner]);
        for (const [user, role] of [
          [IDS.owner, 'owner'],
          [IDS.memberA, 'member'],
          [IDS.outsider, 'member'],
        ] as const) {
          await db.query('INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [IDS.org, user, role]);
        }
      }
      const orgColumn = multi ? ', organization_id' : '';
      const orgValue = multi ? ', $1' : '';
      groupA = (await rows<{ id: string }>(db, `INSERT INTO rag_access_groups (key, name${orgColumn}) VALUES ('group-a', 'Group A'${orgValue}) RETURNING id`, multi ? [IDS.org] : []))[0]!.id;
      groupB = (await rows<{ id: string }>(db, `INSERT INTO rag_access_groups (key, name${orgColumn}) VALUES ('group-b', 'Group B'${orgValue}) RETURNING id`, multi ? [IDS.org] : []))[0]!.id;

      await insertDocument(IDS.restrictedDoc, [`g:${groupA}`], {
        doc_type: 'invoice_receipt',
        invoice_number: RESTRICTED_INVOICE,
        supplier_name: 'Synthetic Supplier',
        issue_date: '2026-01-15',
        gross_total: 120,
        currency: 'EUR',
      });
      await insertDocument(IDS.openDoc, ['all'], {
        doc_type: 'invoice_receipt',
        invoice_number: OPEN_INVOICE,
        supplier_name: 'Synthetic Supplier',
        issue_date: '2026-01-10',
        gross_total: 80,
        currency: 'EUR',
      });
      await insertChunk(IDS.restrictedDoc, IDS.restrictedChunk, 0, `Invoice ${RESTRICTED_INVOICE} neutral synthetic header.`, vector(1), {
        chunk_kind: 'invoice_header',
        lexical_text: `invoice ${RESTRICTED_INVOICE} neutral synthetic header`,
      });
      await insertChunk(IDS.restrictedDoc, IDS.restrictedLexChunk, 1, `The ${RESTRICTED_TOKEN} clause is a neutral synthetic sentence.`, vector(2), {
        lexical_text: `the ${RESTRICTED_TOKEN} clause is a neutral synthetic sentence`,
      });
      await insertChunk(IDS.openDoc, IDS.openChunk, 0, `Invoice ${OPEN_INVOICE} neutral synthetic header.`, vector(3), {
        chunk_kind: 'invoice_header',
        lexical_text: `invoice ${OPEN_INVOICE} neutral synthetic header`,
      });
      for (const [parent, docId, index] of [
        [IDS.restrictedParent, IDS.restrictedDoc, 0],
        [IDS.openParent, IDS.openDoc, 0],
      ] as const) {
        await db.query(
          `INSERT INTO public.document_parents (id, document_id, tenant_key, chunking_profile_id, content, token_count, parent_index)
           VALUES ($1, $2, $3, 'legacy', 'Neutral synthetic parent section.', 4, $4)`,
          [parent, docId, tenantKey, index],
        );
      }

      // Recall fixture (D-13): a large group-b document and a group-a document of RECALL_ROWS chunks in the same tenant.
      await insertDocument(IDS.bulkDoc, [`g:${groupB}`]);
      await insertDocument(IDS.recallDoc, [`g:${groupA}`]);
      await db.query(
        `INSERT INTO public.document_chunks (id, document_id, content, chunk_index, embedding)
         SELECT gen_random_uuid(), $1, 'Neutral synthetic bulk sentence ' || g, g,
                (SELECT ('[' || string_agg(((((g * 7919 + i * 104729) % 1000)::float8 / 1000.0) - 0.5)::text, ',') || ']') FROM generate_series(1, ${DIMS}) i)::vector
         FROM generate_series(1, ${BULK_ROWS}) g`,
        [IDS.bulkDoc],
      );
      for (let n = 0; n < RECALL_ROWS; n += 1) {
        await insertChunk(IDS.recallDoc, null, n, `Neutral synthetic recall sentence ${n}.`, vector(100 + n));
      }

      await db.query(`INSERT INTO embedding_profiles (id, provider, model, dims, storage, status) VALUES ($1, 'openai', 'test-model', ${DIMS}, 'halfvec', 'available')`, [
        PROFILE,
      ]);
      await db.query(
        `INSERT INTO chunk_embeddings (chunk_id, profile_id, tenant_key, embedding, embedding_model, dims)
         SELECT id, $1, tenant_key, embedding::halfvec(${DIMS}), 'test-model', ${DIMS} FROM public.document_chunks WHERE embedding IS NOT NULL`,
        [PROFILE],
      );
    });

    after(async () => {
      await db?.close();
      if (corpusDir) fs.rmSync(corpusDir, { recursive: true, force: true });
    });

    test('the seeded labels: chunks and parents carry their document label', async () => {
      const labels = await rows<{ access_groups: string[] }>(db, 'SELECT access_groups FROM public.document_chunks WHERE id = $1', [IDS.restrictedLexChunk]);
      assert.deepEqual(labels[0]?.access_groups, [`g:${groupA}`]);
      const parent = await rows<{ access_groups: string[] }>(db, 'SELECT access_groups FROM public.document_parents WHERE id = $1', [IDS.restrictedParent]);
      assert.deepEqual(parent[0]?.access_groups, [`g:${groupA}`]);
    });

    // --- rag_fetch_parents (Task 1) ---

    async function fetchParents(caller: Caller): Promise<string[]> {
      const extra = accessArgs(caller, 3);
      const result = await asServiceRole(db, () =>
        rows<{ id: string }>(db, `SELECT id FROM rag_fetch_parents(p_tenant_key => $1, p_parent_ids => $2::uuid[]${extra.sql})`, [
          tenantKey,
          [IDS.restrictedParent, IDS.openParent],
          ...extra.params,
        ]),
      );
      return result.map((row) => row.id).sort();
    }

    test('rag_fetch_parents: the outsider passing the restricted parent id gets no row of it; member-a and admin_all get it', async () => {
      const c = callers();
      assert.deepEqual(await fetchParents(c.outsider), [IDS.openParent], 'outsider');
      assert.deepEqual(await fetchParents(c.member), [IDS.restrictedParent, IDS.openParent].sort(), 'member-a');
      assert.deepEqual(await fetchParents(c.admin), [IDS.restrictedParent, IDS.openParent].sort(), 'admin_all');
      assert.deepEqual(await fetchParents(c.off), [IDS.restrictedParent, IDS.openParent].sort(), 'switch off, enforcement off: today');
    });

    // --- rag_exact_id_documents (Task 2) ---

    async function exactIds(caller: Caller, tokens: string[]): Promise<string[]> {
      const extra = accessArgs(caller, 4);
      const result = await asServiceRole(db, () =>
        rows<{ chunk_id: string }>(db, `SELECT chunk_id FROM rag_exact_id_documents(p_tenant_key => $1, p_tokens => $2::text[], p_limit => $3${extra.sql})`, [
          tenantKey,
          tokens,
          20,
          ...extra.params,
        ]),
      );
      return result.map((row) => row.chunk_id).sort();
    }

    test('rag_exact_id_documents: neither branch returns a restricted row to the outsider; member-a and admin_all get both', async () => {
      const c = callers();
      assert.deepEqual(await exactIds(c.outsider, [RESTRICTED_INVOICE]), [], 'outsider, invoice branch');
      assert.deepEqual(await exactIds(c.outsider, [RESTRICTED_TOKEN]), [], 'outsider, lexical branch (chunk-only)');
      assert.deepEqual(await exactIds(c.outsider, [OPEN_INVOICE]), [IDS.openChunk], 'outsider still gets the open document');
      for (const caller of [c.member, c.admin, c.off]) {
        assert.ok((await exactIds(caller, [RESTRICTED_INVOICE])).includes(IDS.restrictedChunk), `${caller.name}, invoice branch`);
        assert.deepEqual(await exactIds(caller, [RESTRICTED_TOKEN]), [IDS.restrictedLexChunk], `${caller.name}, lexical branch`);
      }
    });

    test('rag_exact_id_documents: the chunk-only branch rechecks the document label (a stale chunk label does not leak)', async () => {
      await db.exec('ALTER TABLE public.document_chunks DISABLE TRIGGER USER');
      try {
        await db.query("UPDATE public.document_chunks SET access_groups = '{all}' WHERE id = $1", [IDS.restrictedLexChunk]);
        assert.deepEqual(await exactIds(callers().outsider, [RESTRICTED_TOKEN]), [], 'document label still restricts');
      } finally {
        await db.query('UPDATE public.document_chunks SET access_groups = $2::text[] WHERE id = $1', [IDS.restrictedLexChunk, [`g:${groupA}`]]);
        await db.exec('ALTER TABLE public.document_chunks ENABLE TRIGGER USER');
      }
    });

    // --- match_chunks_by_profile (Task 2) ---

    async function profileSearch(caller: Caller, query: string, limit: number): Promise<string[]> {
      const extra = accessArgs(caller, 4);
      const result = await asServiceRole(db, () =>
        rows<{ id: string }>(
          db,
          `SELECT id FROM match_chunks_by_profile(p_tenant_key => $1, p_profile_id => '${PROFILE}', p_dims => ${DIMS}, p_query => $2::halfvec(${DIMS}),
             p_match_count => $3, p_min_similarity => -2, p_require_active => false${extra.sql})`,
          [tenantKey, query, limit, ...extra.params],
        ),
      );
      return result.map((row) => row.id);
    }

    test('match_chunks_by_profile: limit 1 with the restricted text as query returns no restricted row to the outsider', async () => {
      const c = callers();
      const outsider = await profileSearch(c.outsider, vector(1), 1);
      assert.equal(outsider.length, 1);
      assert.notEqual(outsider[0], IDS.restrictedChunk);
      const restrictedIds = new Set((await rows<{ id: string }>(db, 'SELECT id FROM public.document_chunks WHERE document_id IN ($1, $2)', [IDS.restrictedDoc, IDS.recallDoc])).map((r) => r.id));
      for (const chunk of await profileSearch(c.outsider, vector(1), 50)) assert.ok(!restrictedIds.has(chunk), 'no restricted chunk in the outsider top 50');
      for (const caller of [c.member, c.admin, c.off]) {
        assert.deepEqual(await profileSearch(caller, vector(1), 1), [IDS.restrictedChunk], caller.name);
      }
    });

    async function bruteForce(keys: string[], query: string, limit: number): Promise<string[]> {
      return (
        await rows<{ id: string }>(
          db,
          `WITH all_rows AS MATERIALIZED (
             SELECT c.id, (c.embedding::halfvec(${DIMS})) <=> $2::halfvec(${DIMS}) AS dist
             FROM public.document_chunks c JOIN public.documents d ON d.id = c.document_id
             WHERE c.tenant_key = $1 AND c.is_current AND c.status = 'ready' AND c.embedding IS NOT NULL
               AND c.access_groups && $3::text[] AND d.access_groups && $3::text[])
           SELECT id FROM all_rows ORDER BY dist + 0, id LIMIT $4`,
          [tenantKey, query, keys, limit],
        )
      ).map((row) => row.id);
    }

    test(`match_chunks_by_profile: member-a, who sees ${RECALL_ROWS + 2} of over ${BULK_ROWS} rows, gets the brute-force top ten (D-13)`, async () => {
      const query = vector(7);
      const expected = await bruteForce(memberKeys(), query, 10);
      assert.equal(expected.length, 10);
      assert.deepEqual(await profileSearch(callers().member, query, 10), expected);
    });

    test('match_chunks_by_profile: a caller who sees more than the bound still gets only visible rows, ranked by distance', async () => {
      const query = vector(9);
      const got = await profileSearch({ name: 'group-b', keys: groupBKeys(), all: false }, query, 10);
      assert.equal(got.length, 10);
      const visible = new Set(await bruteForce(groupBKeys(), query, BULK_ROWS + 10));
      for (const chunk of got) assert.ok(visible.has(chunk), 'every row is visible to the caller');
    });

    // --- rag_find_invoices (Task 2) ---

    async function invoices(caller: Caller): Promise<string[]> {
      const extra = accessArgs(caller, 2);
      const result = await asServiceRole(db, () =>
        rows<{ document_id: string }>(
          db,
          `SELECT document_id FROM rag_find_invoices(p_tenant_key => $1, p_supplier => 'synthetic supplier', p_date_from => NULL, p_date_to => NULL,
             p_amount_min => NULL, p_amount_max => NULL, p_currency => NULL, p_limit => 10${extra.sql})`,
          [tenantKey, ...extra.params],
        ),
      );
      return result.map((row) => row.document_id).sort();
    }

    test('rag_find_invoices: a restricted invoice document is not returned to the outsider', async () => {
      const c = callers();
      assert.deepEqual(await invoices(c.outsider), [IDS.openDoc]);
      for (const caller of [c.member, c.admin, c.off]) assert.deepEqual(await invoices(caller), [IDS.restrictedDoc, IDS.openDoc].sort(), caller.name);
    });

    // --- legacy search RPC of the mode (Task 3) ---

    async function legacySearch(caller: Caller, query: string, limit: number): Promise<string[]> {
      const extra = accessArgs(caller, 3);
      const sql = multi
        ? `SELECT id AS chunk FROM match_documents_by_workspace(p_query_embedding => $1::vector, p_match_count => $2, p_min_similarity => -2,
             p_org_id => '${IDS.org}', p_user_id => NULL${extra.sql})`
        : `SELECT chunk_id AS chunk FROM match_document_chunks(query_embedding => $1::vector, similarity_threshold => -2, match_count => $2${extra.sql})`;
      const result = await asServiceRole(db, () => rows<{ chunk: string }>(db, sql, [query, limit, ...extra.params]));
      return result.map((row) => row.chunk);
    }

    const legacyName = multi ? 'match_documents_by_workspace' : 'match_document_chunks';

    test(`${legacyName}: limit 1 with the restricted text as query returns no restricted row to the outsider`, async () => {
      const c = callers();
      const outsider = await legacySearch(c.outsider, vector(1), 1);
      assert.equal(outsider.length, 1);
      assert.notEqual(outsider[0], IDS.restrictedChunk);
      for (const caller of [c.member, c.admin, c.off]) assert.deepEqual(await legacySearch(caller, vector(1), 1), [IDS.restrictedChunk], caller.name);
    });

    test(`${legacyName}: member-a gets the brute-force top ten (D-13)`, async () => {
      const query = vector(11);
      const expected = await bruteForce(memberKeys(), query, 10);
      assert.deepEqual(await legacySearch(callers().member, query, 10), expected);
    });

    // --- guard, overloads, grants (Tasks 1-3) ---

    const GUARDED_CALLS = (): Array<{ name: string; sql: string; params: unknown[] }> => [
      { name: 'rag_fetch_parents', sql: 'SELECT * FROM rag_fetch_parents($1, $2::uuid[])', params: [tenantKey, [IDS.openParent]] },
      { name: 'rag_exact_id_documents', sql: 'SELECT * FROM rag_exact_id_documents($1, $2::text[], 5)', params: [tenantKey, [OPEN_INVOICE]] },
      {
        name: 'match_chunks_by_profile',
        sql: `SELECT * FROM match_chunks_by_profile($1, '${PROFILE}', ${DIMS}, $2::halfvec(${DIMS}), 3, -2, false)`,
        params: [tenantKey, vector(3)],
      },
      { name: 'rag_find_invoices', sql: 'SELECT * FROM rag_find_invoices($1, NULL, NULL, NULL, NULL, NULL, NULL, 5)', params: [tenantKey] },
      multi
        ? { name: legacyName, sql: `SELECT * FROM match_documents_by_workspace($1::vector, 3, -2, '${IDS.org}', NULL)`, params: [vector(3)] }
        : { name: legacyName, sql: 'SELECT * FROM match_document_chunks($1::vector, -2, 3)', params: [vector(3)] },
    ];

    test('every redefined function raises access_scope_required without keys while enforcement is on, and access_keys_empty for {}', async () => {
      for (const call of GUARDED_CALLS()) {
        assert.equal(await failureOf(() => asServiceRole(db, () => db.query(call.sql, call.params))), 'accepted', `${call.name} off`);
        const refused = await withEnforcement(() => failureOf(() => asServiceRole(db, () => db.query(call.sql, call.params))));
        assert.match(refused, /access_scope_required/, `${call.name} enforced`);
        const withKeys = call.sql.replace(/\)$/, ", p_access_keys => '{}'::text[])");
        assert.match(await failureOf(() => asServiceRole(db, () => db.query(withKeys, call.params))), /access_keys_empty/, `${call.name} empty keys`);
        const member = call.sql.replace(/\)$/, ', p_access_keys => $9::text[])').replace(/\$9/, `$${call.params.length + 1}`);
        assert.equal(
          await withEnforcement(() => failureOf(() => asServiceRole(db, () => db.query(member, [...call.params, memberKeys()])))),
          'accepted',
          `${call.name} with keys while enforced`,
        );
      }
    });

    test('each redefined function exists in exactly one overload, keeps its security mode, has an empty search_path and is service_role only', async () => {
      const expected: Record<string, { definer: boolean; args: number }> = {
        rag_fetch_parents: { definer: false, args: 4 },
        rag_exact_id_documents: { definer: false, args: 7 },
        match_chunks_by_profile: { definer: true, args: 9 },
        rag_find_invoices: { definer: true, args: 10 },
        hybrid_search_chunks: { definer: false, args: 28 },
        ...(multi ? { match_documents_by_workspace: { definer: true, args: 7 } } : { match_document_chunks: { definer: false, args: 5 } }),
      };
      const found = await rows<{ proname: string; definer: boolean; nargs: number; config: string[] | null; anon: boolean; authn: boolean; service: boolean }>(
        db,
        `SELECT p.proname, p.prosecdef AS definer, p.pronargs AS nargs, p.proconfig AS config,
                has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authn,
                has_function_privilege('service_role', p.oid, 'EXECUTE') AS service
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = ANY($1::text[])`,
        [Object.keys(expected)],
      );
      for (const [name, spec] of Object.entries(expected)) {
        const overloads = found.filter((row) => row.proname === name);
        assert.equal(overloads.length, 1, `${name}: one overload`);
        const row = overloads[0]!;
        assert.equal(row.definer, spec.definer, `${name}: security mode`);
        assert.equal(row.nargs, spec.args, `${name}: arguments`);
        assert.deepEqual(row.config, ['search_path=""'], `${name}: search_path`);
        assert.equal(row.anon, false, `${name}: anon`);
        assert.equal(row.authn, false, `${name}: authenticated`);
        assert.equal(row.service, true, `${name}: service_role`);
      }
    });

    // --- unused legacy content functions (Task 3, RESEARCH section 1a) ---

    const UNUSED = (): Array<{ name: string; sql: string; params: unknown[] }> =>
      multi
        ? [
            { name: 'match_document_chunks_by_org', sql: `SELECT * FROM match_document_chunks_by_org('${IDS.org}', $1::vector, 3, -2)`, params: [vector(3)] },
            { name: 'get_documents_by_type_slug', sql: `SELECT * FROM get_documents_by_type_slug('${IDS.org}', 'text', NULL)`, params: [] },
            { name: 'get_documents_by_type_slug_workspace', sql: `SELECT * FROM get_documents_by_type_slug_workspace('${IDS.org}', NULL, 'text', NULL)`, params: [] },
            { name: 'match_documents_by_organization', sql: `SELECT * FROM match_documents_by_organization($1::vector, -2, 3, '${IDS.org}')`, params: [vector(3)] },
            { name: 'match_document_chunks', sql: 'SELECT * FROM match_document_chunks($1::vector, 3, -2)', params: [vector(3)] },
          ]
        : [
            { name: 'match_documents', sql: 'SELECT * FROM match_documents($1::vector, 3)', params: [vector(3)] },
            { name: 'match_document_chunks_optimized', sql: "SELECT * FROM match_document_chunks_optimized($1::vector, -2, 3, 'balanced')", params: [vector(3)] },
            { name: 'search_chunks_by_keywords', sql: "SELECT * FROM search_chunks_by_keywords('synthetic', 3)", params: [] },
            { name: 'get_document_chunks', sql: `SELECT * FROM get_document_chunks('${IDS.restrictedDoc}')`, params: [] },
          ];

    test('the unused legacy content functions answer as before while enforcement is off and raise access_scope_required while it is on', async () => {
      for (const call of UNUSED()) {
        const before = await rows(db, 'SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.proname = $2', [
          'public',
          call.name,
        ]);
        assert.equal((before[0] as { n: number }).n, 1, `${call.name}: one overload, signature kept`);
        assert.equal(await failureOf(() => asServiceRole(db, () => db.query(call.sql, call.params))), 'accepted', `${call.name} off`);
        const refused = await withEnforcement(() => failureOf(() => asServiceRole(db, () => db.query(call.sql, call.params))));
        assert.match(refused, /access_scope_required/, `${call.name} enforced`);
      }
    });

    test('the unused legacy content functions have an empty search_path and are executable by service_role only', async () => {
      for (const call of UNUSED()) {
        const meta = await rows<{ config: string[] | null; anon: boolean; authn: boolean; service: boolean }>(
          db,
          `SELECT p.proconfig AS config, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
                  has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authn, has_function_privilege('service_role', p.oid, 'EXECUTE') AS service
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = $1`,
          [call.name],
        );
        assert.deepEqual(meta[0], { config: ['search_path=""'], anon: false, authn: false, service: true }, call.name);
      }
    });
  });
}
