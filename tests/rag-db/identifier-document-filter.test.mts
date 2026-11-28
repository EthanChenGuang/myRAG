import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { FIXTURE_USER_ID, createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { applyMigrationFiles, migrationFiles } from '../../eval/harness/migrations.mts';

/**
 * Plan 04.2-40 (D-59, the D-31 revision): with p_identifiers_norm set, hybrid_search_chunks, rag_bm25_search_chunks,
 * rag_exact_id_documents (both branches) and rag_table_lookup keep a chunk whose document carries an asked identifier in a ready chunk of
 * the caller's tenant (and, on a restricted call, of the caller's access groups). The fixture database is built through the files below
 * 0936, the NULL-identifier results are recorded, then 0936 and every later file are applied. Synthetic, neutral data only (D-41).
 */
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const LEGACY = 'openai-3-small-1536';
const MIGRATION = '0936_identifier_document_filter';
const USER_B = '00000000-0000-4000-8000-0000000936b1';
const X = 'zq-41';
const NEAR = 'zq-14';
const EVIDENCE = 'wevid';
const ANCHOR = 'wanch';
const GROUP = 'g:00000000-0000-4000-8000-000000093601';
const OTHER_GROUP = 'g:00000000-0000-4000-8000-000000093602';
const FUNCTIONS = ['hybrid_search_chunks', 'rag_bm25_search_chunks', 'rag_exact_id_documents', 'rag_table_lookup'];
const BM25_ARGS_0932 = [
  'p_tenant_key', 'p_profile_id', 'p_query_embedding', 'p_lexical_tokens', 'p_lexical_limit', 'p_date_from', 'p_date_to', 'p_sources',
  'p_document_ids', 'p_doc_types', 'p_languages', 'p_lexical_languages', 'p_supplier', 'p_amount_min', 'p_amount_max', 'p_currency',
  'p_chunking_override', 'p_include_undated', 'p_scopes', 'p_scopes_include_untagged', 'p_effective_on', 'p_version_scope',
  'p_identifiers_norm', 'p_k1', 'p_b', 'p_candidate_limit', 'p_access_keys', 'p_access_all',
];

interface ChunkSpec {
  tokens: string[];
  identifiers?: string[] | null;
  kind?: string;
  status?: string;
}

async function insertDocument(
  db: PGlite,
  userId: string,
  chunks: ChunkSpec[],
  doc: { accessGroups?: string[]; invoiceNumber?: string | null } = {},
): Promise<{ docId: string; chunkIds: string[] }> {
  const docId = crypto.randomUUID();
  await db.query(
    `INSERT INTO public.documents (id, filename, content, metadata, user_id, doc_type, language, source, status, is_current, version,
       provisional, access_groups, invoice_number, lineage_id, content_hash)
     VALUES ($1, $2, 'neutral sample', '{}'::jsonb, $3::uuid, 'general', 'en', 'chat_upload', 'ready', true, 1, false, $4::text[], $5, $1, $6)`,
    [docId, `docfilter-${docId.slice(0, 8)}.txt`, userId, doc.accessGroups ?? ['all'], doc.invoiceNumber ?? null, crypto.randomUUID()],
  );
  const chunkIds: string[] = [];
  for (const [i, c] of chunks.entries()) {
    const id = crypto.randomUUID();
    chunkIds.push(id);
    const text = c.tokens.join(' ');
    await db.query(
      `INSERT INTO public.document_chunks (id, document_id, content, metadata, chunk_index, lexical_text, language, doc_type,
         identifiers_norm, chunking_profile_id, chunk_kind, status, is_current, provisional)
       VALUES ($1, $2, $3, '{}'::jsonb, $4, $3, 'en', 'general', $5::text[], 'legacy', $6, $7, true, false)`,
      [id, docId, text, i, c.identifiers ?? null, c.kind ?? 'text', c.status ?? 'ready'],
    );
  }
  return { docId, chunkIds };
}

async function rebuildStats(db: PGlite, tenant: string): Promise<void> {
  await db.query('DELETE FROM public.rag_lexical_df WHERE tenant_key = $1', [tenant]);
  await db.query('DELETE FROM public.rag_lexical_corpus WHERE tenant_key = $1', [tenant]);
  const member = `c.tenant_key = $1 AND c.is_current AND c.status IN ('ready', 'variant') AND c.lexical_tsv IS NOT NULL AND c.lexical_tsv <> ''::tsvector`;
  await db.query(
    `INSERT INTO public.rag_lexical_corpus (tenant_key, corpus, chunking_profile_id, language, chunk_count, total_len)
     SELECT $1, 'chunks', c.chunking_profile_id, COALESCE(c.language, 'und'), count(*), sum(public.rag_lexical_dl(c.lexical_tsv))
     FROM public.document_chunks c WHERE ${member} GROUP BY 3, 4`,
    [tenant],
  );
  await db.query(
    `INSERT INTO public.rag_lexical_df (tenant_key, corpus, lexeme, chunking_profile_id, language, df)
     SELECT $1, 'chunks', x.lexeme, c.chunking_profile_id, COALESCE(c.language, 'und'), count(*)
     FROM public.document_chunks c CROSS JOIN LATERAL unnest(tsvector_to_array(c.lexical_tsv)) AS x(lexeme) WHERE ${member} GROUP BY 3, 4, 5`,
    [tenant],
  );
  await db.query(
    `INSERT INTO public.rag_lexical_stats_state (tenant_key, status, rebuilt_at) VALUES ($1, 'ready', now())
     ON CONFLICT (tenant_key) DO UPDATE SET status = 'ready', rebuilt_at = now()`,
    [tenant],
  );
}

interface Call {
  ids?: string[] | null;
  keys?: string[] | null;
  all?: boolean;
}

async function hybridIds(db: PGlite, tenant: string, call: Call = {}): Promise<string[]> {
  const rows = await db.query<{ id: string }>(
    `SELECT chunk_id::text AS id FROM public.hybrid_search_chunks(p_tenant_key => $1, p_profile_id => $2, p_query_embedding => NULL,
       p_lexical_tokens => ARRAY['${EVIDENCE}', '${ANCHOR}'], p_dense_limit => 0, p_lexical_limit => 200, p_identifiers_norm => $3::text[],
       p_access_keys => $4::text[], p_access_all => $5::boolean) WHERE leg = 'lexical'`,
    [tenant, LEGACY, call.ids ?? null, call.keys ?? null, call.all ?? false],
  );
  return rows.rows.map((r) => r.id).sort();
}

async function bm25Ids(db: PGlite, tenant: string, call: Call = {}): Promise<string[]> {
  const rows = await db.query<{ id: string }>(
    `SELECT chunk_id::text AS id FROM public.rag_bm25_search_chunks(p_tenant_key => $1, p_profile_id => $2, p_query_embedding => NULL,
       p_lexical_tokens => ARRAY['${EVIDENCE}', '${ANCHOR}'], p_lexical_limit => 200, p_candidate_limit => 0, p_identifiers_norm => $3::text[],
       p_access_keys => $4::text[], p_access_all => $5::boolean)`,
    [tenant, LEGACY, call.ids ?? null, call.keys ?? null, call.all ?? false],
  );
  return rows.rows.map((r) => r.id).sort();
}

async function exactIds(db: PGlite, tenant: string, tokens: string[], call: Call = {}): Promise<string[]> {
  const rows = await db.query<{ id: string }>(
    `SELECT chunk_id::text AS id FROM public.rag_exact_id_documents($1, $2::text[], 100, NULL::jsonb, $3::text[], $4::text[], $5::boolean)`,
    [tenant, tokens, call.ids ?? null, call.keys ?? null, call.all ?? false],
  );
  return rows.rows.map((r) => r.id).sort();
}

async function lookupRows(db: PGlite, tenant: string, call: Call = {}): Promise<string[]> {
  const rows = await db.query<{ id: string }>(
    `SELECT document_id::text || ':' || chunk_id::text AS id
     FROM public.rag_table_lookup($1, ARRAY['plin', 'mepra'], 2, 50, NULL::jsonb, $2::text[], $3::text[], $4::boolean)`,
    [tenant, call.ids ?? null, call.keys ?? null, call.all ?? false],
  );
  return rows.rows.map((r) => r.id).sort();
}

/** The text between the marker comments of every function, with placeholders and parameter names folded, for the parity check. */
function fragments(source: string): string[] {
  const out: string[] = [];
  const re = /\/\* identifier-document-filter:begin \*\/([\s\S]*?)\/\* identifier-document-filter:end \*\//g;
  for (const m of source.matchAll(re)) {
    out.push(
      (m[1] as string)
        .replace(/''/g, "'")
        .replace(/::text\[\]/g, '')
        .replace(/\$\d+/g, '$n')
        .replace(/\b(p_tenant_key|p_identifiers_norm|v_anchor_keys)\b/g, '$n')
        .replace(/\s+/g, ' ')
        .trim(),
    );
  }
  return out;
}

for (const mode of MODES) {
  const tenantA = mode === 'multi-tenant' ? `u:${FIXTURE_USER_ID}` : 's:default';
  const tenantB = `u:${USER_B}`;

  describe(`0936 document-level identifier filter (${mode})`, () => {
    let db: PGlite;
    const d: Record<string, { docId: string; chunkIds: string[] }> = {};
    const before0936: Record<string, string[]> = {};
    let bm25ArgsBefore = '';
    let secdefBefore: Record<string, boolean> = {};

    const offCalls = (): Record<string, () => Promise<string[]>> => ({
      'hybrid, no keys': () => hybridIds(db, tenantA),
      'hybrid, everyone': () => hybridIds(db, tenantA, { keys: ['all'] }),
      'hybrid, group': () => hybridIds(db, tenantA, { keys: ['all', GROUP] }),
      'hybrid, admin': () => hybridIds(db, tenantA, { keys: ['all'], all: true }),
      'bm25, no keys': () => bm25Ids(db, tenantA),
      'bm25, everyone': () => bm25Ids(db, tenantA, { keys: ['all'] }),
      'bm25, admin': () => bm25Ids(db, tenantA, { keys: ['all'], all: true }),
      'exact, lexical branch': () => exactIds(db, tenantA, [EVIDENCE]),
      'exact, header branch': () => exactIds(db, tenantA, [X]),
      'exact, admin': () => exactIds(db, tenantA, [EVIDENCE], { keys: ['all'], all: true }),
      'lookup, no keys': () => lookupRows(db, tenantA),
      'lookup, everyone': () => lookupRows(db, tenantA, { keys: ['all'] }),
      'lookup, admin': () => lookupRows(db, tenantA, { keys: ['all'], all: true }),
    });

    before(async () => {
      db = (await createEmptyFixtureDatabase({ deploymentMode: mode, migrations: false })).db;
      const files = migrationFiles(mode);
      const split = files.findIndex((f) => path.basename(f).startsWith('0936_'));
      assert.ok(split > 0, '0936 is in the migration list');
      await applyMigrationFiles(db, files.slice(0, split));
      if (mode === 'single-tenant') {
        await db.query("INSERT INTO auth.users (id, email) VALUES ($1, 'fixture-user@example.invalid')", [FIXTURE_USER_ID]);
      } else {
        await db.query("INSERT INTO auth.users (id, email) VALUES ($1, 'fixture-user-b@example.invalid')", [USER_B]);
      }

      // D1: H carries X, E (same document) holds the evidence without the identifier, N carries only a near-miss.
      d.d1 = await insertDocument(
        db,
        FIXTURE_USER_ID,
        [
          { tokens: [ANCHOR, 'w1'], identifiers: [X] },
          { tokens: [EVIDENCE, 'w2'] },
          { tokens: [EVIDENCE, 'w3'], kind: 'invoice_header' },
        ],
        { invoiceNumber: X.toUpperCase() },
      );
      d.d2 = await insertDocument(db, FIXTURE_USER_ID, [{ tokens: [EVIDENCE, 'w4'], identifiers: [NEAR] }]);
      d.d3 = await insertDocument(db, FIXTURE_USER_ID, [{ tokens: [EVIDENCE, 'w5'] }]);
      // D5: restricted to GROUP, with its own anchor and evidence chunk.
      d.d5 = await insertDocument(db, FIXTURE_USER_ID, [{ tokens: [ANCHOR, 'w6'], identifiers: [X] }, { tokens: [EVIDENCE, 'w7'] }], {
        accessGroups: [GROUP],
      });
      // D6: the only chunk carrying X has failed; its ready sibling never qualifies through it.
      d.d6 = await insertDocument(db, FIXTURE_USER_ID, [{ tokens: [ANCHOR, 'w8'], identifiers: [X], status: 'failed' }, { tokens: [EVIDENCE, 'w9'] }]);
      if (mode === 'multi-tenant') {
        d.b = await insertDocument(db, USER_B, [{ tokens: [ANCHOR, 'w10'], identifiers: [X] }, { tokens: [EVIDENCE, 'w11'] }]);
        await rebuildStats(db, tenantB);
      }
      await rebuildStats(db, tenantA);

      // Table rows: a row of D1 whose only chunk is E (no identifier) and the same values in D3.
      for (const key of ['d1', 'd3'] as const) {
        const doc = d[key]!;
        const chunk = key === 'd1' ? doc.chunkIds[1] : doc.chunkIds[0];
        const rows = [
          {
            table_key: `${doc.docId}:t0`,
            row_index: 0,
            header: ['Kelmo', 'Darvi'],
            cells: { Kelmo: 'plin', Darvi: 'mepra' },
            cell_tokens: [['plin'], ['mepra']],
            cell_norm: ['plin', 'mepra'],
            chunk_ids: [chunk],
          },
        ];
        await db.transaction(async (tx) => {
          await tx.exec('SET LOCAL ROLE service_role');
          await tx.query('SELECT * FROM public.rag_write_table_rows($1, $2::uuid, $3, $4::jsonb)', [tenantA, doc.docId, 'legacy', JSON.stringify(rows)]);
        });
      }

      for (const [name, run] of Object.entries(offCalls())) before0936[name] = await run();
      bm25ArgsBefore =
        (await db.query<{ a: string }>("SELECT pg_get_function_arguments(oid) AS a FROM pg_proc WHERE proname = 'rag_bm25_search_chunks'")).rows[0]?.a ?? '';
      secdefBefore = Object.fromEntries(
        (await db.query<{ n: string; s: boolean }>('SELECT proname AS n, prosecdef AS s FROM pg_proc WHERE proname = ANY($1)', [FUNCTIONS])).rows.map(
          (r) => [r.n, r.s],
        ),
      );

      await applyMigrationFiles(db, files.slice(split));
    });

    after(async () => {
      await db?.close();
    });

    test('the evidence chunk of a document carrying X is returned by both search functions (failed before 0936)', async () => {
      const [h, e, header] = d.d1!.chunkIds;
      for (const [name, ids] of [
        ['hybrid_search_chunks', await hybridIds(db, tenantA, { ids: [X] })],
        ['rag_bm25_search_chunks', await bm25Ids(db, tenantA, { ids: [X] })],
      ] as const) {
        assert.ok(ids.includes(e as string), `${name}: evidence chunk E of D1 missing from ${JSON.stringify(ids)}`);
        assert.ok(ids.includes(header as string), `${name}: header chunk of D1`);
        assert.ok(ids.includes(h as string), `${name}: anchor chunk H of D1`);
      }
    });

    test('no chunk of a near-miss, unrelated, failed-anchor or other-tenant document qualifies', async () => {
      const outside = [...d.d2!.chunkIds, ...d.d3!.chunkIds, ...d.d6!.chunkIds, ...(d.b?.chunkIds ?? []), ...d.d5!.chunkIds];
      for (const ids of [await hybridIds(db, tenantA, { ids: [X], keys: ['all'] }), await bm25Ids(db, tenantA, { ids: [X], keys: ['all'] })]) {
        for (const id of outside) assert.ok(!ids.includes(id), `unexpected chunk ${id}`);
        assert.deepEqual(ids, [...d.d1!.chunkIds].sort());
      }
      if (mode === 'multi-tenant') {
        assert.deepEqual(await hybridIds(db, tenantB, { ids: [X] }), [...d.b!.chunkIds].sort());
        assert.deepEqual(await bm25Ids(db, tenantB, { ids: [X] }), [...d.b!.chunkIds].sort());
      }
    });

    test('rag_exact_id_documents: both branches keep chunks of D1 that lack X; nothing of D2 or D3 qualifies', async () => {
      const [, e, header] = d.d1!.chunkIds;
      const lexical = await exactIds(db, tenantA, [EVIDENCE], { ids: [X], keys: ['all'] });
      assert.deepEqual(lexical, [e, header].sort(), 'lexical branch');
      const headerBranch = await exactIds(db, tenantA, [X], { ids: [X], keys: ['all'] });
      assert.ok(headerBranch.includes(header as string), 'header branch: the invoice_header chunk of D1 without X');
      if (mode === 'multi-tenant') assert.deepEqual(await exactIds(db, tenantB, [EVIDENCE], { ids: [X] }), [d.b!.chunkIds[1]]);
    });

    test('rag_table_lookup: the D1 row whose chunk lacks X qualifies; the D3 row does not', async () => {
      assert.deepEqual(await lookupRows(db, tenantA, { ids: [X], keys: ['all'] }), [`${d.d1!.docId}:${d.d1!.chunkIds[1]}`]);
      assert.deepEqual(await lookupRows(db, tenantA, { ids: [NEAR] }), []);
    });

    test('access: a caller outside the group gets nothing of D5; a member gets its anchor and evidence; guards hold', async () => {
      const d5 = [...d.d5!.chunkIds].sort();
      for (const search of [hybridIds, bm25Ids]) {
        const outsider = await search(db, tenantA, { ids: [X], keys: ['all', OTHER_GROUP] });
        assert.ok(d5.every((id) => !outsider.includes(id)), 'outsider');
        const member = await search(db, tenantA, { ids: [X], keys: ['all', GROUP] });
        assert.ok(d5.every((id) => member.includes(id)), 'member');
        const admin = await search(db, tenantA, { ids: [X], keys: ['all'], all: true });
        assert.ok(d5.every((id) => admin.includes(id)), 'admin');
      }
      assert.ok(!(await exactIds(db, tenantA, [EVIDENCE], { ids: [X], keys: ['all'] })).includes(d.d5!.chunkIds[1] as string));
      assert.ok((await exactIds(db, tenantA, [EVIDENCE], { ids: [X], keys: ['all', GROUP] })).includes(d.d5!.chunkIds[1] as string));
      assert.deepEqual(await lookupRows(db, tenantA, { ids: [X], keys: [OTHER_GROUP] }), []);
      for (const run of [
        () => hybridIds(db, tenantA, { ids: [X], keys: [] }),
        () => bm25Ids(db, tenantA, { ids: [X], keys: [] }),
        () => exactIds(db, tenantA, [EVIDENCE], { ids: [X], keys: [] }),
        () => lookupRows(db, tenantA, { ids: [X], keys: [] }),
      ]) {
        await assert.rejects(run(), /access_keys_empty/);
      }
      await db.query('UPDATE public.rag_access_group_settings SET enforced = true');
      try {
        for (const run of [
          () => hybridIds(db, tenantA, { ids: [X] }),
          () => bm25Ids(db, tenantA, { ids: [X] }),
          () => exactIds(db, tenantA, [EVIDENCE], { ids: [X] }),
          () => lookupRows(db, tenantA, { ids: [X] }),
        ]) {
          await assert.rejects(run(), /access_scope_required/);
        }
      } finally {
        await db.query('UPDATE public.rag_access_group_settings SET enforced = false');
      }
    });

    test('p_identifiers_norm NULL: every call returns the ids it returned before 0936', async () => {
      for (const [name, run] of Object.entries(offCalls())) {
        assert.deepEqual(await run(), before0936[name], name);
      }
      assert.ok((before0936['hybrid, no keys'] as string[]).length >= 8, 'the off calls are not vacuous');
    });

    test('predicate text parity: the marked fragment is the same in all four functions (both exact-id branches)', async () => {
      const rows = await db.query<{ n: string; src: string }>('SELECT proname AS n, prosrc AS src FROM pg_proc WHERE proname = ANY($1)', [FUNCTIONS]);
      const found = new Map(rows.rows.map((r) => [r.n, fragments(r.src)]));
      assert.equal(found.get('rag_exact_id_documents')?.length, 2, 'two branches');
      const all = FUNCTIONS.flatMap((f) => {
        const list = found.get(f) ?? [];
        assert.ok(list.length >= 1, `${f} has the marked fragment`);
        return list;
      });
      assert.equal(new Set(all).size, 1, `fragments differ:\n${[...new Set(all)].join('\n')}`);
      assert.match(all[0] as string, /ic\.tenant_key = \$n/);
      assert.match(all[0] as string, /ic\.status IN \('ready', 'variant'\)/);
      assert.match(all[0] as string, /ic\.access_groups OPERATOR\(pg_catalog\.&&\) \$n/);
    });

    test('catalog: one overload each, service_role only, empty search_path, security mode and the bm25 arguments unchanged', async () => {
      for (const name of FUNCTIONS) {
        const rows = await db.query<{ oid: number; secdef: boolean; config: string[] | null }>(
          'SELECT oid::int, prosecdef AS secdef, proconfig AS config FROM pg_proc WHERE proname = $1',
          [name],
        );
        assert.equal(rows.rows.length, 1, `${name}: one overload`);
        const row = rows.rows[0]!;
        assert.equal(row.secdef, secdefBefore[name], `${name}: security mode`);
        assert.ok((row.config ?? []).some((c) => c === 'search_path=' || c === 'search_path=""'), `${name}: empty search_path`);
        for (const role of ['anon', 'authenticated']) {
          const ok = await db.query<{ ok: boolean }>('SELECT has_function_privilege($1, $2::oid, $3) AS ok', [role, row.oid, 'EXECUTE']);
          assert.equal(ok.rows[0]?.ok, false, `${name}: ${role} cannot execute`);
        }
        const svc = await db.query<{ ok: boolean }>('SELECT has_function_privilege($1, $2::oid, $3) AS ok', ['service_role', row.oid, 'EXECUTE']);
        assert.equal(svc.rows[0]?.ok, true, `${name}: service_role executes`);
      }
      const args = (await db.query<{ a: string }>("SELECT pg_get_function_arguments(oid) AS a FROM pg_proc WHERE proname = 'rag_bm25_search_chunks'")).rows[0]?.a;
      assert.equal(args, bm25ArgsBefore, 'bm25 argument list equals the 0932 one');
      const names = args!.split(/,\s*(?=p_)/).map((p) => p.split(' ')[0]);
      assert.deepEqual(names, BM25_ARGS_0932, 'no argument outside the 0932 signature');
    });

    test('re-applying 0936 changes nothing; an extra bm25 argument (for example p_df_mode) stops it with 55000', async () => {
      const sql = fs.readFileSync(path.join(process.cwd(), 'supabase/migrations', `${MIGRATION}.sql`), 'utf8');
      const src = async (): Promise<string[]> =>
        (await db.query<{ s: string }>('SELECT proname || prosrc AS s FROM pg_proc WHERE proname = ANY($1) ORDER BY proname', [FUNCTIONS])).rows.map((r) => r.s);
      const before = await src();
      const ids = await hybridIds(db, tenantA, { ids: [X] });
      await db.exec(sql);
      assert.deepEqual(await src(), before);
      assert.deepEqual(await hybridIds(db, tenantA, { ids: [X] }), ids);
      await db.exec(
        "CREATE FUNCTION public.rag_bm25_search_chunks(p_tenant_key text, p_df_mode text) RETURNS integer LANGUAGE sql SET search_path = '' AS $$ SELECT 1 $$",
      );
      try {
        await assert.rejects(db.exec(sql), (error: unknown) => (error as { code?: string }).code === '55000');
        await db.exec('ROLLBACK').catch(() => undefined);
      } finally {
        await db.exec('DROP FUNCTION public.rag_bm25_search_chunks(text, text)');
      }
      assert.deepEqual(await src(), before, 'a stopped run leaves the functions as they were');
    });
  });
}
