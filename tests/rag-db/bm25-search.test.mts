import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { applyMigrationFiles, migrationFiles } from '../../eval/harness/migrations.mts';
import { FIXTURE_USER_ID, createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { bm25Reference, type Bm25Stats } from '../helpers/bm25-reference.ts';
import { lcg, neutralLexicalCorpus } from '../helpers/neutral-lexical-corpus.ts';

/**
 * 0904 rag_bm25_search_chunks (D-13, D-22, D-23, D-25, D-32): scores equal an independent BM25 reference computed from the caller's own
 * statistics, another tenant's chunks or counters never change a result, and the function is service_role only. Text is generated
 * neutral tokens (w0..wN) only (D-41).
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATION = 'supabase/migrations/0904_bm25_search_chunks.sql';
const LEGACY = 'openai-3-small-1536';
const SECOND_USER_ID = '00000000-0000-4000-8000-0000000000b4';
const ALT_PROFILE = 'p-bm25-alt';
const COMMON = 'w9000';
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const LANG_A = 'en';
const LANG_B = 'it';
const UND = 'und';

type Row = Record<string, unknown>;

interface ChunkSpec {
  id: string;
  docId: string;
  tenant: string;
  tokens: string[];
  profile: string;
  language: string;
  docLanguage: string;
  docType: string;
  kind: string;
  current: boolean;
}

interface Tenant {
  key: string;
  userId: string;
}

interface Call {
  tokens: string[];
  limit?: number;
  cap?: number;
  k1?: number;
  b?: number;
  docTypes?: string[] | null;
  lexicalLanguages?: string[] | null;
  embedding?: string | null;
}

function vec(text: string): string {
  return `[${embedText(text).join(',')}]`;
}

function codeOf(error: unknown): string {
  return typeof (error as { code?: string }).code === 'string' ? (error as { code: string }).code : '';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const isMember = (c: ChunkSpec): boolean => c.current && c.tokens.length > 0;

class Seeder {
  readonly chunks: ChunkSpec[] = [];
  constructor(private readonly db: PGlite) {}

  /** One document with its chunks, written in two statements. */
  async document(
    tenant: Tenant,
    docType: string,
    docLanguage: string,
    chunks: Array<{ tokens: string[]; profile?: string; language?: string; kind?: string; embed?: boolean }>,
  ): Promise<ChunkSpec[]> {
    const docId = crypto.randomUUID();
    await this.db.query(
      `INSERT INTO public.documents (id, filename, content, metadata, user_id, doc_type, language, is_current, status)
       VALUES ($1, $2, 'neutral sample', '{}'::jsonb, $3::uuid, $4, $5, true, 'ready')`,
      [docId, `bm25-${docId.slice(0, 8)}.txt`, tenant.userId, docType, docLanguage],
    );
    const specs: ChunkSpec[] = chunks.map((c) => ({
      id: crypto.randomUUID(),
      docId,
      tenant: tenant.key,
      tokens: c.tokens,
      profile: c.profile ?? 'legacy',
      language: c.language ?? docLanguage,
      docLanguage,
      docType,
      kind: c.kind ?? 'text',
      current: true,
    }));
    await this.db.query(
      `INSERT INTO public.document_chunks (id, document_id, content, metadata, chunk_index, lexical_text, language, doc_type, chunk_kind,
         chunking_profile_id, status, is_current, embedding)
       SELECT u.id, $1::uuid, u.txt, '{}'::jsonb, u.ord::int - 1, u.txt, u.lang, $2, u.kind, u.profile, 'ready', true, u.emb::public.vector
         FROM unnest($3::uuid[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[]) WITH ORDINALITY AS u(id, txt, lang, kind, profile, emb, ord)`,
      [
        docId,
        docType,
        specs.map((s) => s.id),
        specs.map((s) => s.tokens.join(' ')),
        specs.map((s) => s.language),
        specs.map((s) => s.kind),
        specs.map((s) => s.profile),
        chunks.map((c, i) => (c.embed ? vec((specs[i] as ChunkSpec).tokens.join(' ')) : null)),
      ],
    );
    this.chunks.push(...specs);
    return specs;
  }

  /** Replaces the tenant's counters with a recompute in TypeScript from the seeded member chunks, and marks the tenant ready. */
  async rebuildStats(tenant: string): Promise<void> {
    await this.db.query('DELETE FROM public.rag_lexical_df WHERE tenant_key = $1', [tenant]);
    await this.db.query('DELETE FROM public.rag_lexical_corpus WHERE tenant_key = $1', [tenant]);
    const corpus = new Map<string, { profile: string; language: string; n: number; len: number }>();
    const df = new Map<string, { lexeme: string; profile: string; language: string; n: number }>();
    for (const c of this.chunks.filter((x) => x.tenant === tenant && isMember(x))) {
      const ck = `${c.profile}|${c.language}`;
      const entry = corpus.get(ck) ?? { profile: c.profile, language: c.language, n: 0, len: 0 };
      entry.n += 1;
      entry.len += c.tokens.length;
      corpus.set(ck, entry);
      for (const lexeme of new Set(c.tokens)) {
        const dk = `${lexeme}|${ck}`;
        const d = df.get(dk) ?? { lexeme, profile: c.profile, language: c.language, n: 0 };
        d.n += 1;
        df.set(dk, d);
      }
    }
    const cs = [...corpus.values()];
    await this.db.query(
      `INSERT INTO public.rag_lexical_corpus (tenant_key, corpus, chunking_profile_id, language, chunk_count, total_len)
       SELECT $1, 'chunks', u.p, u.l, u.n, u.len FROM unnest($2::text[], $3::text[], $4::bigint[], $5::bigint[]) AS u(p, l, n, len)`,
      [tenant, cs.map((x) => x.profile), cs.map((x) => x.language), cs.map((x) => x.n), cs.map((x) => x.len)],
    );
    const ds = [...df.values()];
    await this.db.query(
      `INSERT INTO public.rag_lexical_df (tenant_key, corpus, lexeme, chunking_profile_id, language, df)
       SELECT $1, 'chunks', u.x, u.p, u.l, u.n FROM unnest($2::text[], $3::text[], $4::text[], $5::bigint[]) AS u(x, p, l, n)`,
      [tenant, ds.map((x) => x.lexeme), ds.map((x) => x.profile), ds.map((x) => x.language), ds.map((x) => x.n)],
    );
    await this.db.query(
      `INSERT INTO public.rag_lexical_stats_state (tenant_key, status, rebuilt_at) VALUES ($1, 'ready', now())
       ON CONFLICT (tenant_key) DO UPDATE SET status = 'ready', rebuilt_at = now()`,
      [tenant],
    );
  }
}

const KNOWN_DOC_TYPES = ['financial_report', 'contract_legal', 'invoice_receipt', 'product_technical', 'scanned_image', 'general'];

/** The effective profile per doc type: the active profile, else legacy (no override in these tests). */
type EffectiveMap = Record<string, string>;

/** The rows the 0856 lexical filter admits for this call, mirrored in TypeScript for the cases these tests seed. */
function matching(chunks: ChunkSpec[], tenant: string, eff: EffectiveMap, call: Call): ChunkSpec[] {
  const query = new Set(call.tokens);
  return chunks.filter((c) => {
    if (c.tenant !== tenant || !isMember(c)) return false;
    if (!c.tokens.some((t) => query.has(t))) return false;
    if (call.docTypes && !call.docTypes.includes(c.docType)) return false;
    const ep = eff[c.docType];
    if (!ep) return false;
    const profileOk =
      c.profile === ep ||
      (ep !== 'legacy' && c.profile === 'legacy' && ['image', 'invoice_header'].includes(c.kind)) ||
      (ep !== 'legacy' && c.profile === 'legacy' && !chunks.some((o) => o.docId === c.docId && o.current && o.profile === ep));
    if (!profileOk) return false;
    if (call.lexicalLanguages) {
      const langs = call.lexicalLanguages;
      if (!(langs.includes(c.language) || (c.language === UND && langs.includes(c.docLanguage)))) return false;
    }
    return true;
  });
}

/** D-13 request statistics, computed from the seeded member chunks of the tenant. */
function requestStats(chunks: ChunkSpec[], tenant: string, eff: EffectiveMap, call: Call, omit: string[] = []): Bm25Stats {
  const types = call.docTypes ? KNOWN_DOC_TYPES.filter((t) => call.docTypes?.includes(t)) : KNOWN_DOC_TYPES;
  const profiles = new Set(types.map((t) => eff[t] ?? 'legacy'));
  const counted = chunks.filter(
    (c) =>
      c.tenant === tenant &&
      isMember(c) &&
      profiles.has(c.profile) &&
      (!call.lexicalLanguages || call.lexicalLanguages.includes(c.language) || c.language === UND),
  );
  const df = new Map<string, number>();
  for (const c of counted) for (const t of new Set(c.tokens)) df.set(t, (df.get(t) ?? 0) + 1);
  for (const t of omit) df.delete(t);
  const total = counted.reduce((sum, c) => sum + c.tokens.length, 0);
  return { N: counted.length, avgdl: total / counted.length, df };
}

interface Expected {
  id: string;
  score: number;
}

function expectedResults(chunks: ChunkSpec[], tenant: string, eff: EffectiveMap, call: Call, omit: string[] = []): Expected[] {
  const docs = matching(chunks, tenant, eff, call);
  const stats = requestStats(chunks, tenant, eff, call, omit);
  const scores = bm25Reference({ docs: docs.map((d) => d.tokens), query: [...new Set(call.tokens)], k1: call.k1 ?? 1.2, b: call.b ?? 0.75, stats });
  return docs
    .map((d, i) => ({ id: d.id, score: scores[i] as number }))
    .sort((x, y) => (Math.abs(y.score - x.score) > 1e-9 ? y.score - x.score : x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

async function bm25(db: PGlite, tenant: string, call: Call): Promise<Row[]> {
  return (
    await db.query<Row>(
      `SELECT leg, rank, chunk_id::text AS chunk_id, similarity, lexical_score, dense_mode
       FROM public.rag_bm25_search_chunks(
         p_tenant_key => $1, p_profile_id => $2, p_query_embedding => $3::public.vector, p_lexical_tokens => $4::text[],
         p_lexical_limit => $5, p_doc_types => $6::text[], p_lexical_languages => $7::text[],
         p_k1 => $8, p_b => $9, p_candidate_limit => $10) ORDER BY rank`,
      [
        tenant,
        LEGACY,
        call.embedding ?? null,
        call.tokens,
        call.limit ?? 200,
        call.docTypes ?? null,
        call.lexicalLanguages ?? null,
        call.k1 ?? 1.2,
        call.b ?? 0.75,
        call.cap ?? 500,
      ],
    )
  ).rows;
}

/**
 * Rank by rank, the reference score of the returned chunk equals the reference score expected at that rank, and the returned score equals
 * it. Scores that are mathematically equal can differ by one unit in the last place in both implementations (b = 1 makes tf / dl the
 * only input), so such near-ties may come in either order; exact ties are checked separately.
 */
function assertMatchesReference(rows: Row[], expected: Expected[], label: string, limit = 200): void {
  const want = expected.slice(0, limit);
  const byId = new Map(expected.map((e) => [e.id, e.score]));
  const tol = (x: number): number => 1e-9 * Math.max(1, Math.abs(x));
  assert.equal(rows.length, want.length, `${label}: row count`);
  assert.equal(new Set(rows.map((r) => r.chunk_id)).size, rows.length, `${label}: distinct chunks`);
  rows.forEach((row, i) => {
    const target = (want[i] as Expected).score;
    const ref = byId.get(String(row.chunk_id));
    assert.ok(ref !== undefined, `${label}: rank ${i + 1} returned a chunk the filter does not admit`);
    assert.ok(Math.abs(ref - target) <= tol(target), `${label}: rank ${i + 1} order (reference ${ref} where ${target} is expected)`);
    const got = Number(row.lexical_score);
    // lexical_score is real, as in hybrid_search_chunks: compare to 1e-6 relative to the score once it exceeds 1.
    assert.ok(Math.abs(got - ref) <= 1e-6 * Math.max(1, Math.abs(ref)), `${label}: rank ${i + 1} score ${got} vs reference ${ref}`);
    assert.equal(row.rank, i + 1, `${label}: rank`);
    assert.equal(row.leg, 'lexical');
    assert.equal(row.dense_mode, 'n/a');
  });
}

async function errorOf(db: PGlite, sql: string, params: unknown[] = []): Promise<unknown> {
  try {
    await db.query(sql, params);
  } catch (error) {
    return error;
  }
  return null;
}

async function execErrorOf(db: PGlite, sql: string): Promise<unknown> {
  try {
    await db.exec(sql);
  } catch (error) {
    return error;
  }
  return null;
}

const BAD_CALL = `SELECT count(*) FROM public.rag_bm25_search_chunks(p_tenant_key => $1, p_profile_id => $2, p_query_embedding => NULL,
  p_lexical_tokens => ARRAY['w1'], p_lexical_limit => $3, p_k1 => $4, p_b => $5, p_candidate_limit => $6,
  p_scopes => $7::text[], p_version_scope => $8::jsonb, p_chunking_override => $9::jsonb)`;

/** Ten neutral queries of one to eight tokens: frequent, rare and mixed. */
function queries(): string[][] {
  const random = lcg(29);
  const out: string[][] = [['w0'], ['w250'], ['w1', 'w2'], ['w3', 'w120', 'w350']];
  for (let n = 4; out.length < 10; n += 1) {
    const q: string[] = [];
    while (q.length < Math.min(n, 8)) q.push(`w${Math.floor(random() * 300)}`);
    out.push(q);
  }
  return out;
}

for (const mode of MODES) {
  const tenantA: Tenant = { key: mode === 'multi-tenant' ? `u:${FIXTURE_USER_ID}` : 's:default', userId: FIXTURE_USER_ID };
  const tenantB: Tenant | null = mode === 'multi-tenant' ? { key: `u:${SECOND_USER_ID}`, userId: SECOND_USER_ID } : null;
  const wrongModeKey = mode === 'multi-tenant' ? 's:default' : `u:${SECOND_USER_ID}`;

  describe(`0904 rag_bm25_search_chunks (${mode})`, () => {
    let db: PGlite;
    let seeder: Seeder;
    const eff: EffectiveMap = Object.fromEntries(KNOWN_DOC_TYPES.map((t) => [t, 'legacy']));
    let baseChunks: ChunkSpec[] = [];
    let lengthPair: ChunkSpec[] = [];
    let fallback: ChunkSpec[] = [];
    let embedded: ChunkSpec | undefined;

    before(async () => {
      db = (await createEmptyFixtureDatabase({ deploymentMode: mode })).db;
      if (mode === 'single-tenant') {
        await db.query("INSERT INTO auth.users (id, email) VALUES ($1, 'fixture-user@example.invalid')", [FIXTURE_USER_ID]);
      } else {
        await db.query("INSERT INTO auth.users (id, email) VALUES ($1, 'second-user@example.invalid')", [SECOND_USER_ID]);
      }
      seeder = new Seeder(db);

      // 300 member chunks of the general type, 30 documents of ten chunks; the documents alternate between two languages and every
      // fifth chunk is und. Every chunk also holds the common token, so its IDF is the smallest possible.
      const corpus = neutralLexicalCorpus({ seed: 11, chunks: 300, vocabulary: 400, minLength: 5, maxLength: 40 });
      for (let d = 0; d < 30; d += 1) {
        const docLanguage = d % 3 === 2 ? LANG_B : LANG_A;
        const specs = await seeder.document(
          tenantA,
          'general',
          docLanguage,
          corpus.slice(d * 10, d * 10 + 10).map((tokens, i) => ({ tokens: [...tokens, COMMON], language: i % 5 === 4 ? UND : docLanguage })),
        );
        baseChunks.push(...specs);
      }
      // Two chunks with the same term count of w9001 and different lengths (the b = 0 case).
      lengthPair = await seeder.document(tenantA, 'general', LANG_A, [
        { tokens: ['w9001', 'w1', 'w2'] },
        { tokens: ['w9001', 'w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 'w10'] },
      ]);
      // One chunk with a stored embedding for the similarity comparison.
      [embedded] = await seeder.document(tenantA, 'general', LANG_A, [{ tokens: ['w9002', 'w5', 'w6'], embed: true }]);

      // product_technical: an active non-legacy profile. Two documents are written in both profiles, one only in legacy (served by the
      // fallback clause and not counted in the statistics).
      await db.query(
        `INSERT INTO public.chunking_profiles (id, doc_type, child_tokens, parent_mode, parent_tokens, status, preset)
         VALUES ($1, 'product_technical', 256, 'none', NULL, 'building', 'custom')`,
        [ALT_PROFILE],
      );
      await db.query("UPDATE public.chunking_profiles SET status = 'retired' WHERE id = 'legacy' AND doc_type = 'product_technical'");
      await db.query("UPDATE public.chunking_profiles SET status = 'active' WHERE id = $1 AND doc_type = 'product_technical'", [ALT_PROFILE]);
      eff.product_technical = ALT_PROFILE;
      for (let d = 0; d < 2; d += 1) {
        const tokens = [`w${20 + d}`, 'w9003', 'w9004', `w${40 + d}`];
        await seeder.document(tenantA, 'product_technical', LANG_A, [
          { tokens, profile: 'legacy' },
          { tokens: [...tokens, 'w9004'], profile: ALT_PROFILE },
          { tokens: ['w9003', `w${60 + d}`], profile: ALT_PROFILE },
        ]);
      }
      fallback = await seeder.document(tenantA, 'product_technical', LANG_A, [{ tokens: ['w9003', 'w9003', 'w70', 'w71'], profile: 'legacy' }]);
      await seeder.rebuildStats(tenantA.key);
    });

    after(async () => {
      await db?.close();
    });

    test('the function exists once, and its result columns equal those of hybrid_search_chunks', async () => {
      const rows = await db.query<{ name: string; result: string }>(
        `SELECT p.proname AS name, pg_get_function_result(p.oid) AS result FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname IN ('rag_bm25_search_chunks', 'hybrid_search_chunks') ORDER BY p.proname`,
      );
      assert.deepEqual(
        rows.rows.map((r) => r.name),
        ['hybrid_search_chunks', 'rag_bm25_search_chunks'],
      );
      assert.equal(rows.rows[1]?.result, rows.rows[0]?.result);
    });

    test('every score equals the reference with no candidate cap, and the default cap gives the same rows when the matches fit', async () => {
      for (const tokens of queries()) {
        const expected = expectedResults(seeder.chunks, tenantA.key, eff, { tokens });
        assert.ok(expected.length > 0, `query ${tokens.join(' ')} matches`);
        assertMatchesReference(await bm25(db, tenantA.key, { tokens, cap: 0 }), expected, `cap 0 ${tokens.join(' ')}`);
        assertMatchesReference(await bm25(db, tenantA.key, { tokens }), expected, `default cap ${tokens.join(' ')}`);
        assertMatchesReference(await bm25(db, tenantA.key, { tokens, limit: 5 }), expected, `limit 5 ${tokens.join(' ')}`, 5);
      }
    });

    test('k1 and b change scores exactly as the reference does; b = 0 ignores length', async () => {
      for (const [k1, b] of [
        [0.5, 1],
        [2, 0.3],
        [3, 0],
      ] as Array<[number, number]>) {
        for (const tokens of queries().slice(0, 5)) {
          const call = { tokens, k1, b, cap: 0 };
          assertMatchesReference(await bm25(db, tenantA.key, call), expectedResults(seeder.chunks, tenantA.key, eff, call), `k1 ${k1} b ${b}`);
        }
      }
      const [short, long] = lengthPair as [ChunkSpec, ChunkSpec];
      const scoreOf = (rows: Row[], id: string): number => Number(rows.find((r) => r.chunk_id === id)?.lexical_score);
      const flat = await bm25(db, tenantA.key, { tokens: ['w9001'], b: 0 });
      assert.equal(flat.length, 2);
      assert.equal(scoreOf(flat, short.id), scoreOf(flat, long.id));
      assert.deepEqual(
        flat.map((r) => r.chunk_id),
        [short.id, long.id].sort(),
        'an exact tie is ordered by chunk id',
      );
      const normal = await bm25(db, tenantA.key, { tokens: ['w9001'] });
      assert.ok(scoreOf(normal, short.id) > scoreOf(normal, long.id), 'with b = 0.75 the shorter chunk scores higher');
    });

    test('a token in every chunk has a small positive IDF; a token with no counter row is scored with df 1', async () => {
      const everyRows = await bm25(db, tenantA.key, { tokens: [COMMON], cap: 0 });
      assert.equal(everyRows.length, 200);
      for (const row of everyRows) assert.ok(Number(row.lexical_score) > 0, 'positive');
      assertMatchesReference(everyRows, expectedResults(seeder.chunks, tenantA.key, eff, { tokens: [COMMON] }), 'common token');

      await db.query("DELETE FROM public.rag_lexical_df WHERE tenant_key = $1 AND lexeme = 'w250'", [tenantA.key]);
      try {
        const call = { tokens: ['w250', 'w1'], cap: 0 };
        assertMatchesReference(await bm25(db, tenantA.key, call), expectedResults(seeder.chunks, tenantA.key, eff, call, ['w250']), 'uncompacted');
      } finally {
        await seeder.rebuildStats(tenantA.key);
      }
    });

    test('statistics scope: the requested lexical languages plus und, and only the effective profile of the requested doc types', async () => {
      for (const call of [
        { tokens: ['w1', 'w7', 'w30'], lexicalLanguages: [LANG_A] },
        { tokens: ['w1', 'w7', 'w30'], lexicalLanguages: [LANG_B] },
        { tokens: ['w2', 'w9'], lexicalLanguages: [LANG_A, LANG_B] },
      ]) {
        const expected = expectedResults(seeder.chunks, tenantA.key, eff, call);
        assert.ok(expected.length > 0);
        assertMatchesReference(await bm25(db, tenantA.key, { ...call, cap: 0 }), expected, `languages ${call.lexicalLanguages.join(',')}`);
      }
      // The per-language statistics differ from the tenant-wide ones, so the reference would fail if und or the other language were
      // counted differently.
      const en = requestStats(seeder.chunks, tenantA.key, eff, { tokens: [], lexicalLanguages: [LANG_A] });
      const all = requestStats(seeder.chunks, tenantA.key, eff, { tokens: [] });
      assert.notEqual(en.N, all.N);

      const tech = { tokens: ['w9003', 'w9004', 'w20'], docTypes: ['product_technical'] };
      const techRows = await bm25(db, tenantA.key, { ...tech, cap: 0 });
      assertMatchesReference(techRows, expectedResults(seeder.chunks, tenantA.key, eff, tech), 'effective profile');
      assert.equal(requestStats(seeder.chunks, tenantA.key, eff, tech).N, 4, 'only the four chunks of the active profile are counted');
      const ids = new Set(techRows.map((r) => r.chunk_id));
      assert.ok(ids.has((fallback[0] as ChunkSpec).id), 'the legacy chunk of a document missing from the profile is returned');
      for (const c of seeder.chunks.filter((x) => x.docType === 'product_technical' && x.profile === 'legacy' && x !== fallback[0])) {
        assert.ok(!ids.has(c.id), 'a dual-written legacy chunk is not returned');
      }
      // Without a doc type filter the statistics hold every effective profile (legacy for the other types and the alternative profile).
      const unfiltered = { tokens: ['w9003', 'w1'] };
      assertMatchesReference(await bm25(db, tenantA.key, { ...unfiltered, cap: 0 }), expectedResults(seeder.chunks, tenantA.key, eff, unfiltered), 'all types');
    });

    test('similarity of a lexical hit under the legacy profile equals the value the ts_rank_cd leg returns', async () => {
      const chunk = embedded as ChunkSpec;
      const embedding = vec('w9002 w5 query');
      const rows = await bm25(db, tenantA.key, { tokens: ['w9002'], embedding });
      assert.equal(rows.length, 1);
      const hybrid = await db.query<Row>(
        `SELECT chunk_id::text AS chunk_id, similarity FROM public.hybrid_search_chunks(p_tenant_key => $1, p_profile_id => $2,
           p_query_embedding => $3::public.vector, p_lexical_tokens => ARRAY['w9002'], p_dense_limit => 0, p_lexical_limit => 10)`,
        [tenantA.key, LEGACY, embedding],
      );
      assert.equal(hybrid.rows[0]?.chunk_id, chunk.id);
      assert.equal(rows[0]?.chunk_id, chunk.id);
      assert.ok(typeof rows[0]?.similarity === 'number');
      assert.equal(rows[0]?.similarity, hybrid.rows[0]?.similarity);
      const noEmbedding = await bm25(db, tenantA.key, { tokens: ['w9002'] });
      assert.equal(noEmbedding[0]?.similarity, null);
    });

    test('an empty or fully rejected token list and a zero limit return no row; both functions run in one transaction', async () => {
      assert.deepEqual(await bm25(db, tenantA.key, { tokens: [] }), []);
      assert.deepEqual(await bm25(db, tenantA.key, { tokens: ['', 'w1 w2', "w1'", 'w1\\'] }), []);
      assert.deepEqual(await bm25(db, tenantA.key, { tokens: ['w1'], limit: 0 }), []);
      const odd = await bm25(db, tenantA.key, { tokens: ['w1', 'w1&w2', '!w3', 'w4:*', '$1', ')'] });
      assert.ok(odd.length > 0, 'tokens with tsquery operators are literal lexemes and cause no error');
      await db.exec('BEGIN');
      try {
        const h = await db.query(
          `SELECT count(*)::int AS n FROM public.hybrid_search_chunks(p_tenant_key => $1, p_profile_id => $2, p_query_embedding => NULL,
             p_lexical_tokens => ARRAY['w1'], p_dense_limit => 0, p_lexical_limit => 10)`,
          [tenantA.key, LEGACY],
        );
        assert.ok(Number((h.rows[0] as Row).n) > 0);
        assert.ok((await bm25(db, tenantA.key, { tokens: ['w1'] })).length > 0);
      } finally {
        await db.exec('COMMIT');
      }
    });

    test('not ready: no state row, a building state or request statistics with no chunk raise lexical_stats_not_ready (55000)', async () => {
      const expectNotReady = async (label: string): Promise<void> => {
        const error = await errorOf(db, 'SELECT * FROM public.rag_bm25_search_chunks($1, $2, NULL, ARRAY[\'w1\'], 10)', [tenantA.key, LEGACY]);
        assert.equal(codeOf(error), '55000', `${label}: ${messageOf(error)}`);
        assert.match(messageOf(error), /^lexical_stats_not_ready/, label);
      };
      try {
        await db.query('DELETE FROM public.rag_lexical_stats_state WHERE tenant_key = $1', [tenantA.key]);
        await expectNotReady('no state row');
        await db.query("INSERT INTO public.rag_lexical_stats_state (tenant_key, status) VALUES ($1, 'building')", [tenantA.key]);
        await expectNotReady('building');
        await db.query("UPDATE public.rag_lexical_stats_state SET status = 'ready' WHERE tenant_key = $1", [tenantA.key]);
        await db.query('DELETE FROM public.rag_lexical_corpus WHERE tenant_key = $1', [tenantA.key]);
        await expectNotReady('no chunk in the request statistics');
      } finally {
        await seeder.rebuildStats(tenantA.key);
      }
      assert.ok((await bm25(db, tenantA.key, { tokens: ['w1'] })).length > 0, 'ready again');
    });

    test('k1, b, the candidate cap, the lexical limit and invalid filter arguments raise 22023', async () => {
      const base = [tenantA.key, LEGACY, 10, 1.2, 0.75, 500, null, null, null];
      const cases: Array<[string, number, unknown]> = [
        ['k1 below 0.5', 3, 0.49],
        ['k1 above 3', 3, 3.01],
        ['k1 null', 3, null],
        ['b below 0', 4, -0.01],
        ['b above 1', 4, 1.01],
        ['negative candidate cap', 5, -1],
        ['candidate cap above 2000', 5, 2001],
        ['negative lexical limit', 2, -1],
        ['lexical limit above 200', 2, 201],
        ['malformed scope', 6, ['region']],
        ['unknown scope dimension', 6, ['colour:x']],
        ['unknown version scope mode', 7, JSON.stringify({ mode: 'later' })],
        ['range bounds reversed', 7, JSON.stringify({ mode: 'range', from: '2024-02-01', to: '2024-01-01' })],
        ['unknown chunking profile in override', 8, JSON.stringify({ general: 'no-such-profile' })],
      ];
      for (const [label, index, value] of cases) {
        const params = [...base];
        params[index] = value;
        const error = await errorOf(db, BAD_CALL, params);
        assert.equal(codeOf(error), '22023', `${label}: ${messageOf(error)}`);
      }
      const profile = await errorOf(db, BAD_CALL, [tenantA.key, 'no-such-embedding-profile', 10, 1.2, 0.75, 500, null, null, null]);
      assert.equal(codeOf(profile), '22023');
      const identifiers = await errorOf(
        db,
        `SELECT count(*) FROM public.rag_bm25_search_chunks(p_tenant_key => $1, p_profile_id => $2, p_query_embedding => NULL,
           p_lexical_tokens => ARRAY['w1'], p_lexical_limit => 10, p_identifiers_norm => $3::text[])`,
        [tenantA.key, LEGACY, Array.from({ length: 101 }, (_, i) => `id${i}`)],
      );
      assert.equal(codeOf(identifiers), '22023');
      const ok = await db.query(BAD_CALL, [tenantA.key, LEGACY, 10, 0.5, 0, 0, null, null, null]);
      assert.equal(ok.rows.length, 1, 'bounds are inclusive');
    });

    test('isolation: another tenant never changes a score or appears in a result; a key of the other mode is rejected', async () => {
      const calls: Call[] = [{ tokens: ['w0', 'w1', 'w2'] }, { tokens: ['w250', 'w3'] }, { tokens: [COMMON, 'w5'] }];
      const before = await Promise.all(calls.map((call) => bm25(db, tenantA.key, { ...call, cap: 0 })));
      if (tenantB) {
        // Tenant B holds the same tokens with very different frequencies, and its own ready statistics.
        const random = lcg(5);
        for (let d = 0; d < 6; d += 1) {
          await seeder.document(
            tenantB,
            'general',
            LANG_A,
            Array.from({ length: 10 }, () => ({ tokens: Array.from({ length: 30 }, () => (random() < 0.8 ? 'w250' : `w${Math.floor(random() * 4)}`)) })),
          );
        }
        await seeder.rebuildStats(tenantB.key);
        const withB = await Promise.all(calls.map((call) => bm25(db, tenantA.key, { ...call, cap: 0 })));
        assert.deepEqual(withB, before, 'B present');
        const bIds = new Set(seeder.chunks.filter((c) => c.tenant === tenantB.key).map((c) => c.id));
        for (const rows of withB) for (const row of rows) assert.ok(!bIds.has(String(row.chunk_id)), 'a chunk of B is returned for A');
        await db.query('UPDATE public.rag_lexical_df SET df = df * 7 + 3 WHERE tenant_key = $1', [tenantB.key]);
        await db.query('UPDATE public.rag_lexical_corpus SET chunk_count = chunk_count * 9, total_len = total_len * 2 WHERE tenant_key = $1', [tenantB.key]);
        assert.deepEqual(await Promise.all(calls.map((call) => bm25(db, tenantA.key, { ...call, cap: 0 }))), before, 'B statistics changed');
        const bRows = await bm25(db, tenantB.key, { tokens: ['w250'] });
        assert.ok(bRows.length > 0);
        for (const row of bRows) assert.ok(bIds.has(String(row.chunk_id)), 'a call for B returns only B');
      }
      const error = await errorOf(db, 'SELECT * FROM public.rag_bm25_search_chunks($1, $2, NULL, ARRAY[\'w1\'], 10)', [wrongModeKey, LEGACY]);
      assert.equal(codeOf(error), '22023', messageOf(error));
      assert.match(messageOf(error), /tenant key/);
    });

    test('anon and authenticated cannot execute it; it is an invoker function with an empty search_path granted to service_role', async () => {
      const acl = await db.query<Row>(
        `SELECT has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
                has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role,
                COALESCE((SELECT bool_or(g.grantee = 0) FROM aclexplode(p.proacl) g WHERE g.privilege_type = 'EXECUTE'), true) AS public_exec,
                p.prosecdef AS definer, p.proconfig AS config
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'rag_bm25_search_chunks'`,
      );
      assert.deepEqual(acl.rows, [{ anon: false, authenticated: false, service_role: true, public_exec: false, definer: false, config: ['search_path=""'] }]);
      for (const role of ['anon', 'authenticated']) {
        await db.exec(`SET ROLE ${role}`);
        try {
          const error = await errorOf(db, 'SELECT * FROM public.rag_bm25_search_chunks($1, $2, NULL, ARRAY[\'w1\'], 10)', [tenantA.key, LEGACY]);
          assert.equal(codeOf(error), '42501', `${role}: ${messageOf(error)}`);
        } finally {
          await db.exec('RESET ROLE');
        }
      }
    });
  });

  describe(`0904 apply rules (${mode})`, () => {
    test('applying 0904 twice leaves one function and does not change hybrid_search_chunks', async () => {
      const fixture = await createEmptyFixtureDatabase({ deploymentMode: mode, migrations: false });
      const db = fixture.db;
      try {
        const files = migrationFiles(mode);
        assert.ok(files.includes(MIGRATION), `${MIGRATION} is in the migration list`);
        await applyMigrationFiles(
          db,
          files.filter((file) => file < MIGRATION),
        );
        const hybridHash = async (): Promise<Row[]> =>
          (
            await db.query<Row>(
              `SELECT md5(p.prosrc) AS src, pg_get_function_identity_arguments(p.oid) AS args, p.proacl::text AS acl FROM pg_proc p
               JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'hybrid_search_chunks'`,
            )
          ).rows;
        const beforeHash = await hybridHash();
        assert.equal(beforeHash.length, 1);
        const sql = fs.readFileSync(path.join(REPO_ROOT, MIGRATION), 'utf8');
        await db.exec(sql);
        await db.exec(sql);
        assert.deepEqual(await hybridHash(), beforeHash);
        const count = await db.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'rag_bm25_search_chunks'",
        );
        assert.equal(count.rows[0]?.n, 1);
        await applyMigrationFiles(
          db,
          files.filter((file) => file > MIGRATION),
        );
      } finally {
        await db.close();
      }
    });

    test('the file stops with 55000 when the statistics tables are missing', async () => {
      const fixture = await createEmptyFixtureDatabase({ deploymentMode: mode, migrations: false });
      const db = fixture.db;
      try {
        const files = migrationFiles(mode);
        await applyMigrationFiles(
          db,
          files.filter((file) => file < 'supabase/migrations/0900'),
        );
        const error = await execErrorOf(db, fs.readFileSync(path.join(REPO_ROOT, MIGRATION), 'utf8'));
        assert.equal(codeOf(error), '55000', messageOf(error));
      } finally {
        await db.close();
      }
    });
  });
}
