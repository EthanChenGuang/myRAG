import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { FIXTURE_USER_ID, createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { lcg } from '../helpers/neutral-lexical-corpus.ts';

/**
 * D-14: rag_bm25_search_chunks (0904) cannot drift from hybrid_search_chunks silently. (a) Every input parameter of hybrid_search_chunks
 * except the three dense-only ones exists on the BM25 function with the same type and default; (b) for every filter case, with limits
 * above the match count, both functions return the same set of chunk ids. A new filter case is one row of CASES. Neutral generated
 * tokens and synthetic values only (D-41).
 */
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const LEGACY = 'openai-3-small-1536';
const ALT_PROFILE = 'p-parity-alt';
const TOKEN = 'wpar';
const DENSE_ONLY = ['p_dense_limit', 'p_iterative_scan', 'p_exact_scan_cutoff'];
const LANG_A = 'en';
const LANG_B = 'it';
const UND = 'und';

interface InputArg {
  name: string;
  type: string;
  decl: string;
}

/** The input parameters of the one function of that name: name, type and the declaration text from pg_get_function_arguments. */
async function inputArgs(db: PGlite, name: string): Promise<InputArg[]> {
  const rows = await db.query<{ name: string; type: string; args: string }>(
    `SELECT a.name, pg_catalog.format_type(a.t, NULL) AS type, pg_get_function_arguments(p.oid) AS args
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     CROSS JOIN LATERAL unnest(p.proargnames, COALESCE(p.proallargtypes, p.proargtypes::oid[]), COALESCE(p.proargmodes, array_fill('i'::"char", ARRAY[cardinality(p.proargnames)]))) WITH ORDINALITY AS a(name, t, mode, ord)
     WHERE n.nspname = 'public' AND p.proname = $1 AND a.mode IN ('i', 'b') ORDER BY a.ord`,
    [name],
  );
  const decls = new Map<string, string>();
  const text = rows.rows[0]?.args ?? '';
  for (const part of text.split(/,\s*(?=p_[a-z0-9_]+\s)/)) {
    const match = /^(p_[a-z0-9_]+)\s/.exec(part.trim());
    if (match) decls.set(match[1] as string, part.trim());
  }
  return rows.rows.map((r) => ({ name: r.name, type: r.type, decl: decls.get(r.name) ?? '' }));
}

interface Tenant {
  key: string;
  userId: string;
}

interface DocSpec {
  docType?: string;
  language?: string;
  source?: string;
  supplierName?: string | null;
  supplierTaxId?: string | null;
  grossTotal?: number | null;
  currency?: string | null;
  status?: string;
  isCurrent?: boolean;
  lineage?: string | null;
  version?: number;
  supersededBy?: string | null;
  contentHash?: string | null;
  createdAt?: string;
  provisional?: boolean;
  id?: string;
}

interface ChunkSpec {
  tokens?: string[];
  language?: string;
  docDate?: string | null;
  scopes?: string[];
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  identifiers?: string[] | null;
  profile?: string;
  kind?: string;
  status?: string;
  isCurrent?: boolean;
  provisional?: boolean;
}

const random = lcg(17);
const filler = (): string[] => Array.from({ length: 4 + Math.floor(random() * 6) }, () => `w${Math.floor(random() * 50)}`);

async function insertDocument(db: PGlite, tenant: Tenant, doc: DocSpec, chunks: ChunkSpec[]): Promise<{ docId: string; chunkIds: string[] }> {
  const docId = doc.id ?? crypto.randomUUID();
  const docStatus = doc.status ?? 'ready';
  await db.query(
    `INSERT INTO public.documents (id, filename, content, metadata, user_id, doc_type, language, source, supplier_name, supplier_tax_id,
       gross_total, currency, status, is_current, lineage_id, version, superseded_by, content_hash, created_at, provisional)
     VALUES ($1, $2, 'neutral sample', '{}'::jsonb, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::uuid, $14, $15::uuid, $16,
       $17::timestamptz, $18)`,
    [
      docId,
      `parity-${docId.slice(0, 8)}.txt`,
      tenant.userId,
      doc.docType ?? 'general',
      doc.language ?? LANG_A,
      doc.source ?? 'chat_upload',
      doc.supplierName ?? null,
      doc.supplierTaxId ?? null,
      doc.grossTotal ?? null,
      doc.currency ?? null,
      docStatus,
      doc.isCurrent ?? true,
      doc.lineage ?? null,
      doc.version ?? 1,
      doc.supersededBy ?? null,
      doc.contentHash ?? null,
      doc.createdAt ?? '2024-01-10T00:00:00Z',
      doc.provisional ?? false,
    ],
  );
  const chunkIds: string[] = [];
  for (const [i, c] of chunks.entries()) {
    const id = crypto.randomUUID();
    chunkIds.push(id);
    const text = [TOKEN, ...(c.tokens ?? filler())].join(' ');
    await db.query(
      `INSERT INTO public.document_chunks (id, document_id, content, metadata, chunk_index, lexical_text, language, doc_type, doc_date, scopes,
         effective_from, effective_to, identifiers_norm, chunking_profile_id, chunk_kind, status, is_current, provisional)
       VALUES ($1, $2, $3, '{}'::jsonb, $4, $3, $5, $6, $7::date, $8::text[], $9::date, $10::date, $11::text[], $12, $13, $14, $15, $16)`,
      [
        id,
        docId,
        text,
        i,
        c.language ?? doc.language ?? LANG_A,
        doc.docType ?? 'general',
        c.docDate ?? null,
        c.scopes ?? [],
        c.effectiveFrom ?? null,
        c.effectiveTo ?? null,
        c.identifiers ?? null,
        c.profile ?? 'legacy',
        c.kind ?? 'text',
        c.status ?? (docStatus === 'ready' ? 'ready' : docStatus),
        c.isCurrent ?? doc.isCurrent ?? true,
        c.provisional ?? doc.provisional ?? false,
      ],
    );
  }
  return { docId, chunkIds };
}

/** Enables statistics for the tenant and rebuilds its counters from its member chunks. */
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

interface FilterCase {
  name: string;
  args: Record<string, unknown>;
  /** At least this many rows (most cases must match something, so equality is not vacuous). */
  min?: number;
  /** Exactly this many rows (an empty filter). */
  exact?: number;
}

/** Placeholder casts for every filter parameter shared by both functions. */
const CASTS: Record<string, string> = {
  p_date_from: 'date',
  p_date_to: 'date',
  p_sources: 'text[]',
  p_document_ids: 'uuid[]',
  p_doc_types: 'text[]',
  p_languages: 'text[]',
  p_lexical_languages: 'text[]',
  p_supplier: 'text',
  p_amount_min: 'numeric',
  p_amount_max: 'numeric',
  p_currency: 'text',
  p_chunking_override: 'jsonb',
  p_include_undated: 'boolean',
  p_scopes: 'text[]',
  p_scopes_include_untagged: 'boolean',
  p_effective_on: 'date',
  p_version_scope: 'jsonb',
  p_identifiers_norm: 'text[]',
};

function namedArgs(args: Record<string, unknown>, offset: number): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const parts: string[] = [];
  for (const [name, value] of Object.entries(args)) {
    const cast = CASTS[name];
    assert.ok(cast, `unknown filter parameter ${name}`);
    params.push(typeof value === 'object' && value !== null && !Array.isArray(value) ? JSON.stringify(value) : value);
    parts.push(`, ${name} => $${offset + params.length}::${cast}`);
  }
  return { sql: parts.join(''), params };
}

async function lexicalLegIds(db: PGlite, tenant: string, args: Record<string, unknown>): Promise<string[]> {
  const extra = namedArgs(args, 2);
  const rows = await db.query<{ id: string }>(
    `SELECT chunk_id::text AS id FROM public.hybrid_search_chunks(p_tenant_key => $1, p_profile_id => $2, p_query_embedding => NULL,
       p_lexical_tokens => ARRAY['${TOKEN}'], p_dense_limit => 0, p_lexical_limit => 200${extra.sql}) WHERE leg = 'lexical'`,
    [tenant, LEGACY, ...extra.params],
  );
  return rows.rows.map((r) => r.id).sort();
}

async function bm25Ids(db: PGlite, tenant: string, args: Record<string, unknown>): Promise<string[]> {
  const extra = namedArgs(args, 2);
  const rows = await db.query<{ id: string }>(
    `SELECT chunk_id::text AS id FROM public.rag_bm25_search_chunks(p_tenant_key => $1, p_profile_id => $2, p_query_embedding => NULL,
       p_lexical_tokens => ARRAY['${TOKEN}'], p_lexical_limit => 200, p_candidate_limit => 0${extra.sql})`,
    [tenant, LEGACY, ...extra.params],
  );
  return rows.rows.map((r) => r.id).sort();
}

for (const mode of MODES) {
  const tenant: Tenant = { key: mode === 'multi-tenant' ? `u:${FIXTURE_USER_ID}` : 's:default', userId: FIXTURE_USER_ID };

  describe(`0904 filter parity with hybrid_search_chunks (${mode})`, () => {
    let db: PGlite;
    const ids: Record<string, string[]> = {};
    let cases: FilterCase[] = [];

    before(async () => {
      db = (await createEmptyFixtureDatabase({ deploymentMode: mode })).db;
      if (mode === 'single-tenant') {
        await db.query("INSERT INTO auth.users (id, email) VALUES ($1, 'fixture-user@example.invalid')", [FIXTURE_USER_ID]);
      }

      // General documents: dated and undated chunks, two sources, scopes, effective dates and identifiers.
      const dated: string[] = [];
      for (let d = 0; d < 6; d += 1) {
        const doc = await insertDocument(db, tenant, { source: d % 2 === 0 ? 'chat_upload' : 'nango' }, [
          { docDate: `2024-0${d + 1}-15`, scopes: d % 3 === 0 ? ['region:north'] : d % 3 === 1 ? ['region:south', 'department:ops'] : [] },
          { docDate: null, effectiveFrom: d % 2 === 0 ? '2024-01-01' : '2024-06-01', effectiveTo: d % 2 === 0 ? '2024-04-30' : null },
          { docDate: `2024-0${d + 1}-20`, identifiers: d < 2 ? ['id-a'] : d < 4 ? ['id-b'] : null, scopes: d === 5 ? ['department:ops'] : [] },
        ]);
        dated.push(doc.docId);
        ids[`general-${d}`] = doc.chunkIds;
      }
      ids.generalDocs = dated;
      // Documents in a second language, with und chunks whose document language decides the language filters.
      for (let d = 0; d < 2; d += 1) {
        ids[`lang-b-${d}`] = (await insertDocument(db, tenant, { language: LANG_B }, [{}, { language: UND }, { docDate: '2024-03-10' }])).chunkIds;
      }
      ids.undA = (await insertDocument(db, tenant, { language: LANG_A }, [{ language: UND }, {}])).chunkIds;
      // Invoice-style documents with synthetic supplier, total and currency values.
      for (const [name, tax, total, currency] of [
        ['Alpha Sample Holder', 'TX-0001', 100, 'EUR'],
        ['Beta Sample Holder', 'TX-0002', 250, 'USD'],
        [null, null, null, null],
      ] as Array<[string | null, string | null, number | null, string | null]>) {
        ids[`invoice-${tax ?? 'none'}`] = (
          await insertDocument(db, tenant, { docType: 'invoice_receipt', supplierName: name, supplierTaxId: tax, grossTotal: total, currency }, [
            {},
            { kind: 'invoice_header' },
          ])
        ).chunkIds;
      }
      ids.contract = (await insertDocument(db, tenant, { docType: 'contract_legal' }, [{}, {}])).chunkIds;

      // product_technical with an active non-legacy profile: a dual-written document, a document only in legacy (fallback clause) and a
      // document whose legacy image chunk is kept next to its profile chunks.
      await db.query(
        `INSERT INTO public.chunking_profiles (id, doc_type, child_tokens, parent_mode, parent_tokens, status, preset)
         VALUES ($1, 'product_technical', 256, 'none', NULL, 'building', 'custom')`,
        [ALT_PROFILE],
      );
      await db.query("UPDATE public.chunking_profiles SET status = 'retired' WHERE id = 'legacy' AND doc_type = 'product_technical'");
      await db.query("UPDATE public.chunking_profiles SET status = 'active' WHERE id = $1 AND doc_type = 'product_technical'", [ALT_PROFILE]);
      ids.techDual = (
        await insertDocument(db, tenant, { docType: 'product_technical' }, [{ profile: 'legacy' }, { profile: ALT_PROFILE }, { profile: ALT_PROFILE }])
      ).chunkIds;
      ids.techLegacyOnly = (await insertDocument(db, tenant, { docType: 'product_technical' }, [{ profile: 'legacy' }, { profile: 'legacy' }])).chunkIds;
      ids.techImage = (
        await insertDocument(db, tenant, { docType: 'product_technical' }, [{ profile: 'legacy', kind: 'image' }, { profile: ALT_PROFILE }])
      ).chunkIds;

      // Version history: a superseded version with different content, one with the same content as its successor, and a provisional one.
      for (const [label, sameHash, provisional] of [
        ['changed', false, false],
        ['same', true, false],
        ['provisional', false, true],
      ] as Array<[string, boolean, boolean]>) {
        const lineage = crypto.randomUUID();
        const v2 = crypto.randomUUID();
        await insertDocument(db, tenant, { id: v2, lineage, version: 2, contentHash: 'hash-2', createdAt: '2024-06-01T00:00:00Z' }, [{}]).then((r) => {
          ids[`v2-${label}`] = r.chunkIds;
        });
        ids[`v1-${label}`] = (
          await insertDocument(
            db,
            tenant,
            {
              lineage,
              version: 1,
              isCurrent: false,
              supersededBy: v2,
              contentHash: sameHash ? 'hash-2' : 'hash-1',
              createdAt: '2023-03-01T00:00:00Z',
              provisional,
            },
            [{ tokens: ['w900', 'w901'] }],
          )
        ).chunkIds;
      }
      // Rows that no default call may return: quarantined, pending review, failed and a non-current chunk of a current document.
      ids.quarantined = (await insertDocument(db, tenant, { status: 'quarantined' }, [{}])).chunkIds;
      ids.pending = (await insertDocument(db, tenant, { status: 'pending_review' }, [{}])).chunkIds;
      ids.failedChunk = (await insertDocument(db, tenant, {}, [{ status: 'failed' }, {}])).chunkIds;
      ids.staleChunk = (await insertDocument(db, tenant, {}, [{ isCurrent: false }, {}])).chunkIds;

      await rebuildStats(db, tenant.key);

      cases = [
        { name: 'no filter', args: {}, min: 30 },
        { name: 'date range', args: { p_date_from: '2024-02-01', p_date_to: '2024-05-31' }, min: 4 },
        { name: 'date from only', args: { p_date_from: '2024-04-01' }, min: 3 },
        { name: 'date range with undated', args: { p_date_from: '2024-02-01', p_date_to: '2024-05-31', p_include_undated: true }, min: 10 },
        { name: 'one source', args: { p_sources: ['nango'] }, min: 6 },
        { name: 'empty source list', args: { p_sources: [] }, exact: 0 },
        { name: 'document ids', args: { p_document_ids: (ids.generalDocs as string[]).slice(0, 2) }, min: 6 },
        { name: 'doc type general', args: { p_doc_types: ['general'] }, min: 20 },
        { name: 'doc type with an active profile', args: { p_doc_types: ['product_technical'] }, min: 4 },
        { name: 'two doc types', args: { p_doc_types: ['invoice_receipt', 'contract_legal'] }, min: 8 },
        { name: 'unknown doc type', args: { p_doc_types: ['memo'] }, exact: 0 },
        { name: 'languages, second language', args: { p_languages: [LANG_B] }, min: 6 },
        { name: 'languages, first language', args: { p_languages: [LANG_A] }, min: 20 },
        { name: 'lexical languages, second language', args: { p_lexical_languages: [LANG_B] }, min: 6 },
        { name: 'lexical languages, both', args: { p_lexical_languages: [LANG_A, LANG_B] }, min: 30 },
        { name: 'lexical languages, empty list', args: { p_lexical_languages: [] }, exact: 0 },
        { name: 'supplier by name part', args: { p_supplier: 'alpha sample' }, min: 2 },
        { name: 'supplier by tax id', args: { p_supplier: 'TX-0002' }, min: 2 },
        { name: 'amount minimum', args: { p_amount_min: 150 }, min: 2 },
        { name: 'amount maximum', args: { p_amount_max: 150 }, min: 2 },
        { name: 'currency', args: { p_currency: 'EUR' }, min: 2 },
        { name: 'chunking override to legacy', args: { p_chunking_override: { product_technical: 'legacy' } }, min: 30 },
        { name: 'chunking override, one doc type', args: { p_chunking_override: { product_technical: 'legacy' }, p_doc_types: ['product_technical'] }, min: 4 },
        { name: 'one scope', args: { p_scopes: ['region:north'] }, min: 2 },
        { name: 'two dimensions', args: { p_scopes: ['region:south', 'department:ops'] }, min: 2 },
        { name: 'one scope with untagged', args: { p_scopes: ['region:north'], p_scopes_include_untagged: true }, min: 20 },
        { name: 'two scopes in one dimension', args: { p_scopes: ['region:north', 'region:south'] }, min: 4 },
        { name: 'effective on a date', args: { p_effective_on: '2024-03-01' }, min: 20 },
        { name: 'version scope current', args: { p_version_scope: { mode: 'current' } }, min: 30 },
        { name: 'version scope all', args: { p_version_scope: { mode: 'all' } }, min: 30 },
        { name: 'version scope range', args: { p_version_scope: { mode: 'range', from: '2023-01-01', to: '2023-12-31' } }, min: 1 },
        { name: 'version scope range, open end', args: { p_version_scope: { mode: 'range', from: '2024-07-01' } }, min: 1 },
        { name: 'version scope all with doc type', args: { p_version_scope: { mode: 'all' }, p_doc_types: ['product_technical'] }, min: 4 },
        { name: 'identifiers', args: { p_identifiers_norm: ['id-a'] }, min: 2 },
        { name: 'empty identifier list', args: { p_identifiers_norm: [] }, exact: 0 },
        {
          name: 'combined',
          args: { p_doc_types: ['general'], p_languages: [LANG_A], p_date_from: '2024-01-01', p_date_to: '2024-06-30', p_include_undated: true },
          min: 10,
        },
      ];
    });

    after(async () => {
      await db?.close();
    });

    test('signature parity: every input of hybrid_search_chunks except the dense-only three exists with the same type and default', async () => {
      const hybrid = await inputArgs(db, 'hybrid_search_chunks');
      const bm25 = new Map((await inputArgs(db, 'rag_bm25_search_chunks')).map((a) => [a.name, a]));
      assert.ok(hybrid.length >= 20, `hybrid_search_chunks has ${hybrid.length} inputs`);
      const missing = hybrid.filter((a) => !DENSE_ONLY.includes(a.name) && !bm25.has(a.name)).map((a) => a.name);
      assert.deepEqual(missing, [], `missing on rag_bm25_search_chunks: ${missing.join(', ')}`);
      for (const arg of hybrid.filter((a) => !DENSE_ONLY.includes(a.name))) {
        const other = bm25.get(arg.name) as InputArg;
        assert.equal(other.type, arg.type, `${arg.name} type`);
        assert.equal(other.decl, arg.decl, `${arg.name} declaration`);
      }
      for (const name of DENSE_ONLY) assert.ok(!bm25.has(name), `${name} is dense-only`);
      const added = [...bm25.keys()].filter((name) => !hybrid.some((a) => a.name === name));
      assert.deepEqual(added.sort(), ['p_b', 'p_candidate_limit', 'p_k1']);
      // proargnames is the catalog source of both lists.
      const names = await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_proc WHERE proname IN ('hybrid_search_chunks', 'rag_bm25_search_chunks') AND 'p_lexical_tokens' = ANY (proargnames)",
      );
      assert.equal(names.rows[0]?.n, 2);
    });

    test('matched-set parity: for every filter case both functions return the same chunk ids', async () => {
      assert.ok(cases.length >= 30);
      for (const c of cases) {
        const expected = await lexicalLegIds(db, tenant.key, c.args);
        const actual = await bm25Ids(db, tenant.key, c.args);
        assert.ok(expected.length < 200, `${c.name}: the match count stays below the limit`);
        if (c.exact !== undefined) assert.equal(expected.length, c.exact, `${c.name}: ts_rank_cd leg count`);
        if (c.min !== undefined) assert.ok(expected.length >= c.min, `${c.name}: ts_rank_cd leg returned ${expected.length}, expected >= ${c.min}`);
        assert.deepEqual(actual, expected, `${c.name}: id sets differ`);
      }
    });

    test('the cases exercise the fallback, image, version and language clauses', async () => {
      const unfiltered = new Set(await bm25Ids(db, tenant.key, {}));
      const has = (key: string, i = 0): boolean => unfiltered.has((ids[key] as string[])[i] as string);
      assert.ok(has('techLegacyOnly', 0) && has('techLegacyOnly', 1), 'a document missing from the active profile is served from legacy');
      assert.ok(!has('techDual', 0), 'the legacy chunk of a dual-written document is not served');
      assert.ok(has('techDual', 1), 'the profile chunk is served');
      assert.ok(has('techImage', 0), 'a legacy image chunk is kept next to the profile chunks');
      const all = new Set(await bm25Ids(db, tenant.key, { p_version_scope: { mode: 'all' } }));
      assert.ok(all.has((ids['v1-changed'] as string[])[0] as string), 'version scope all returns the changed superseded version');
      assert.ok(!all.has((ids['v1-same'] as string[])[0] as string), 'a superseded version with the same content is left out');
      assert.ok(!all.has((ids['v1-provisional'] as string[])[0] as string), 'a provisional superseded version is left out');
      const lexB = new Set(await bm25Ids(db, tenant.key, { p_lexical_languages: [LANG_B] }));
      assert.ok(lexB.has((ids['lang-b-0'] as string[])[1] as string), 'an und chunk of a second-language document matches that language');
      assert.ok(!lexB.has((ids.undA as string[])[0] as string), 'an und chunk of a first-language document does not');
    });

    test('quarantined, pending-review, failed and non-current chunks are in neither set under the default scope', async () => {
      const excluded = [
        (ids.quarantined as string[])[0],
        (ids.pending as string[])[0],
        (ids.failedChunk as string[])[0],
        (ids.staleChunk as string[])[0],
        (ids['v1-changed'] as string[])[0],
      ] as string[];
      for (const args of [{}, { p_version_scope: { mode: 'current' } }]) {
        const hybrid = new Set(await lexicalLegIds(db, tenant.key, args));
        const bm25 = new Set(await bm25Ids(db, tenant.key, args));
        for (const id of excluded) {
          assert.ok(!hybrid.has(id), 'ts_rank_cd leg');
          assert.ok(!bm25.has(id), 'BM25 leg');
        }
      }
      assert.ok((await bm25Ids(db, tenant.key, {})).includes((ids.failedChunk as string[])[1] as string), 'the ready sibling is returned');
    });
  });
}
