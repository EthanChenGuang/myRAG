import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { FIXTURE_USER_ID, createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { chunkLexicalText } from '../../src/lib/rag/lexical/chunk-text';
import { lexicalTokens } from '../../src/lib/rag/lexical/tokenize';
import { rerankText } from '../../src/lib/rag/rerank/text';
import { lcg, neutralLexicalCorpus } from '../helpers/neutral-lexical-corpus.ts';

/**
 * 04.4-21 (D-55): 0906 rag_lexical_rerank_stats, the tenant statistics read of the local reranker. Its counts equal a full recompute of
 * the tenant's member chunks per (doc type, language), it answers only the asked terms, another tenant never changes it, and it is
 * service_role only. The token-form precondition runs first: the terms the reranker tokenizes from a chunk's rerank text are the lexemes
 * the statistics count for that chunk. Neutral synthetic text only (D-41).
 */
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const SECOND_USER_ID = '00000000-0000-4000-8000-0000000000c5';
const ALT_PROFILE = 'p-rerank-alt';
const FN = 'rag_lexical_rerank_stats';

type Row = Record<string, unknown>;

interface Tenant {
  key: string;
  userId: string;
}

interface Seeded {
  id: string;
  tenant: string;
  profile: string;
  language: string | null;
  tokens: string[];
  current: boolean;
}

function codeOf(error: unknown): string {
  return typeof (error as { code?: string }).code === 'string' ? (error as { code: string }).code : '';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function errorOf(db: PGlite, sql: string, params: unknown[]): Promise<unknown> {
  try {
    await db.query(sql, params);
  } catch (error) {
    return error;
  }
  return null;
}

/** Neutral samples in the three registry languages; content and section paths only, no domain strings. */
const TOKEN_FORM_SAMPLES: Array<{ language: string; sectionPath: string[]; content: string }> = [
  { language: 'en', sectionPath: ['North panel', 'Markers'], content: 'The north panel lists seven cobalt markers beside the river gauge, 12.5 cm apart.' },
  { language: 'en', sectionPath: [], content: 'Document: sample-a.txt. Chunk 1 of 3. Content: Amber tiles fill the second row; row-3 stays empty.' },
  { language: 'it', sectionPath: ['Pannello nord'], content: "Il pannello nord elenca sette marcatori color cobalto accanto all'indicatore del fiume." },
  { language: 'zh', sectionPath: ['北侧面板', '标记'], content: '北侧面板列出七个钴色标记，位于河流水位计旁边。第二行铺满琥珀色瓷砖。' },
  { language: 'zh', sectionPath: [], content: '混合文本 alpha-7 与 beta_9，共 3 项。' },
];

async function seedDocument(
  db: PGlite,
  seeded: Seeded[],
  tenant: Tenant,
  docType: string,
  docLanguage: string,
  chunks: Array<{ tokens: string[]; profile?: string; language?: string | null; current?: boolean }>,
): Promise<Seeded[]> {
  const docId = crypto.randomUUID();
  await db.query(
    `INSERT INTO public.documents (id, filename, content, metadata, user_id, doc_type, language, is_current, status)
     VALUES ($1, $2, 'neutral sample', '{}'::jsonb, $3::uuid, $4, $5, true, 'ready')`,
    [docId, `rerank-${docId.slice(0, 8)}.txt`, tenant.userId, docType, docLanguage],
  );
  const rows: Seeded[] = chunks.map((c) => ({
    id: crypto.randomUUID(),
    tenant: tenant.key,
    profile: c.profile ?? 'legacy',
    language: c.language === undefined ? docLanguage : c.language,
    tokens: c.tokens,
    current: c.current ?? true,
  }));
  await db.query(
    `INSERT INTO public.document_chunks (id, document_id, content, metadata, chunk_index, lexical_text, language, doc_type, chunk_kind,
       chunking_profile_id, status, is_current)
     SELECT u.id, $1::uuid, u.txt, '{}'::jsonb, u.ord::int - 1, u.txt, u.lang, $2, 'text', u.profile, 'ready', u.cur
       FROM unnest($3::uuid[], $4::text[], $5::text[], $6::text[], $7::boolean[]) WITH ORDINALITY AS u(id, txt, lang, profile, cur, ord)`,
    [docId, docType, rows.map((r) => r.id), rows.map((r) => r.tokens.join(' ')), rows.map((r) => r.language), rows.map((r) => r.profile), rows.map((r) => r.current)],
  );
  seeded.push(...rows);
  return rows;
}

/** The reference: chunk count, total length and df per asked term over the tenant's current chunks of one (profile, language) bucket. */
function recompute(seeded: Seeded[], tenant: string, profile: string, language: string, terms: string[]) {
  const members = seeded.filter(
    (c) => c.tenant === tenant && c.current && c.tokens.length > 0 && c.profile === profile && (c.language ?? 'und') === language,
  );
  return {
    chunk_count: members.length,
    total_len: members.reduce((sum, c) => sum + c.tokens.length, 0),
    dfs: terms.map((t) => members.filter((c) => c.tokens.includes(t)).length),
  };
}

async function readStats(db: PGlite, tenant: string, terms: string[], chunkIds: string[]): Promise<Row[]> {
  return (
    await db.query<Row>(
      `SELECT chunk_id::text AS chunk_id, chunking_profile_id, language, chunk_count::int AS chunk_count, total_len::int AS total_len, terms,
              (SELECT array_agg(x::int ORDER BY o) FROM unnest(dfs) WITH ORDINALITY AS u(x, o)) AS dfs
         FROM public.${FN}($1, $2::text[], $3::uuid[]) ORDER BY chunk_id`,
      [tenant, terms, chunkIds],
    )
  ).rows;
}

describe('04.4-21 token forms: rerank text terms equal the lexemes the statistics count (precondition)', () => {
  let db: PGlite;

  before(async () => {
    db = (await createEmptyFixtureDatabase({ deploymentMode: 'single-tenant' })).db;
  });

  after(async () => {
    await db?.close();
  });

  async function counted(lexical: string): Promise<Set<string>> {
    const { rows } = await db.query<{ lexemes: string[] }>('SELECT pg_catalog.tsvector_to_array(public.rag_lexical_tsvector($1)) AS lexemes', [lexical]);
    return new Set(rows[0]?.lexemes ?? []);
  }

  for (const sample of TOKEN_FORM_SAMPLES) {
    test(`${sample.language}, ${sample.sectionPath.length} path part(s): every rerank term is a counted lexeme of the same form`, async () => {
      const rerankTerms = new Set(lexicalTokens(rerankText({ sectionPath: sample.sectionPath, content: sample.content }).text));
      const lexemes = await counted(chunkLexicalText({ sectionPath: sample.sectionPath, content: sample.content }));
      assert.ok(rerankTerms.size > 0, 'the sample yields terms');
      assert.deepEqual([...rerankTerms].filter((t) => !lexemes.has(t)), [], 'rerank_token_form_mismatch');
      if (!sample.content.startsWith('Document:')) assert.deepEqual([...rerankTerms].sort(), [...lexemes].sort(), 'rerank_token_form_mismatch');
    });
  }

  test('known scope difference, not a form difference: a legacy-prefixed chunk counts its title, which the rerank text strips', async () => {
    const sample = TOKEN_FORM_SAMPLES.find((s) => s.content.startsWith('Document:')) as (typeof TOKEN_FORM_SAMPLES)[number];
    const rerankTerms = new Set(lexicalTokens(rerankText({ sectionPath: sample.sectionPath, content: sample.content }).text));
    const lexemes = await counted(chunkLexicalText({ sectionPath: sample.sectionPath, content: sample.content }));
    const titleOnly = [...lexemes].filter((t) => !rerankTerms.has(t)).sort();
    assert.deepEqual(titleOnly, [...new Set(lexicalTokens('sample-a.txt'))].filter((t) => !rerankTerms.has(t)).sort());
  });
});

for (const mode of MODES) {
  const tenantA: Tenant = { key: mode === 'multi-tenant' ? `u:${FIXTURE_USER_ID}` : 's:default', userId: FIXTURE_USER_ID };
  const tenantB: Tenant | null = mode === 'multi-tenant' ? { key: `u:${SECOND_USER_ID}`, userId: SECOND_USER_ID } : null;
  const wrongModeKey = mode === 'multi-tenant' ? 's:default' : `u:${SECOND_USER_ID}`;

  describe(`0906 ${FN} (${mode})`, () => {
    let db: PGlite;
    const seeded: Seeded[] = [];
    let general: Seeded[] = [];
    let technical: Seeded[] = [];

    before(async () => {
      db = (await createEmptyFixtureDatabase({ deploymentMode: mode })).db;
      if (mode === 'single-tenant') {
        await db.query("INSERT INTO auth.users (id, email) VALUES ($1, 'fixture-user@example.invalid')", [FIXTURE_USER_ID]);
      } else {
        await db.query("INSERT INTO auth.users (id, email) VALUES ($1, 'second-user@example.invalid')", [SECOND_USER_ID]);
      }
      const corpus = neutralLexicalCorpus({ seed: 21, chunks: 120, vocabulary: 150, minLength: 4, maxLength: 30 });
      for (let d = 0; d < 12; d += 1) {
        const language = d % 3 === 2 ? 'it' : 'en';
        general.push(
          ...(await seedDocument(
            db,
            seeded,
            tenantA,
            'general',
            language,
            corpus.slice(d * 10, d * 10 + 10).map((tokens, i) => ({ tokens, language: i % 5 === 4 ? 'und' : language, current: !(d === 0 && i === 0) })),
          )),
        );
      }
      // product_technical: an active non-legacy profile; a chunk still under legacy reads the legacy bucket (its own profile).
      await db.query(
        `INSERT INTO public.chunking_profiles (id, doc_type, child_tokens, parent_mode, parent_tokens, status, preset)
         VALUES ($1, 'product_technical', 256, 'none', NULL, 'building', 'custom')`,
        [ALT_PROFILE],
      );
      await db.query("UPDATE public.chunking_profiles SET status = 'retired' WHERE id = 'legacy' AND doc_type = 'product_technical'");
      await db.query("UPDATE public.chunking_profiles SET status = 'active' WHERE id = $1 AND doc_type = 'product_technical'", [ALT_PROFILE]);
      technical = await seedDocument(db, seeded, tenantA, 'product_technical', 'en', [
        { tokens: ['w1', 'w2', 'w3'], profile: 'legacy' },
        { tokens: ['w1', 'w2', 'w3', 'w4'], profile: ALT_PROFILE },
        { tokens: ['w2', 'w5'], profile: ALT_PROFILE },
      ]);
      await db.query('SELECT public.rag_lexstats_enable($1)', [tenantA.key]);
      await db.query('SELECT public.rag_lexstats_rebuild($1)', [tenantA.key]);
    });

    after(async () => {
      await db?.close();
    });

    test('the function exists once', async () => {
      const { rows } = await db.query<{ sig: string }>(
        `SELECT p.oid::regprocedure::text AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = $1`,
        [FN],
      );
      assert.deepEqual(rows.map((r) => r.sig), [`${FN}(text,text[],uuid[])`]);
    });

    test("each candidate reads its own chunk's (profile, language) bucket, equal to a full recompute; terms in the asked order", async () => {
      const terms = ['w3', 'w1', 'w0', 'w149', 'w99999'];
      const asked = [...general.slice(1, 12), ...technical];
      const rows = await readStats(db, tenantA.key, terms, asked.map((c) => c.id));
      assert.equal(rows.length, asked.length);
      for (const chunk of asked) {
        const row = rows.find((r) => r.chunk_id === chunk.id);
        assert.ok(row, 'answered');
        const language = chunk.language ?? 'und';
        assert.equal(row.chunking_profile_id, chunk.profile);
        assert.equal(row.language, language);
        assert.deepEqual(row.terms, terms);
        assert.deepEqual(
          { chunk_count: row.chunk_count, total_len: row.total_len, dfs: row.dfs },
          recompute(seeded, tenantA.key, chunk.profile, language, terms),
          `${chunk.profile}/${language}`,
        );
      }
      const legacyTechnical = rows.find((r) => r.chunk_id === technical[0]?.id);
      assert.equal(legacyTechnical?.chunking_profile_id, 'legacy', 'a chunk under legacy reads the legacy bucket, not the active profile');
    });

    test('a non-current chunk still reads its bucket; an unknown id gives no row; duplicates are answered once; rejected term forms are left out', async () => {
      const stale = general[0] as Seeded;
      const rows = await readStats(db, tenantA.key, ['w1', 'w1', "w'1", 'w 1', ''], [stale.id, stale.id, crypto.randomUUID()]);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.chunk_id, stale.id);
      assert.deepEqual(rows[0]?.terms, ['w1']);
    });

    test('pending deltas are not read: counters are the compacted ones, as in rag_bm25_search_chunks', async () => {
      const ids = general.slice(1, 4).map((c) => c.id);
      const before = await readStats(db, tenantA.key, ['w1'], ids);
      await seedDocument(db, [], tenantA, 'general', 'en', [{ tokens: ['w1', 'w1', 'w2'] }]);
      const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.rag_lexical_stats_pending WHERE tenant_key = $1', [tenantA.key]);
      assert.ok((rows[0]?.n ?? 0) > 0, 'the insert staged a delta');
      assert.deepEqual(await readStats(db, tenantA.key, ['w1'], ids), before);
      await db.query('DELETE FROM public.rag_lexical_stats_pending WHERE tenant_key = $1', [tenantA.key]);
    });

    test('argument limits raise 22023: more than 64 terms or 500 chunks; no term or no chunk asks nothing', async () => {
      const call = `SELECT * FROM public.${FN}($1, $2::text[], $3::uuid[])`;
      const id = (general[1] as Seeded).id;
      assert.equal(codeOf(await errorOf(db, call, [tenantA.key, Array.from({ length: 65 }, (_, i) => `w${i}`), [id]])), '22023');
      assert.equal(codeOf(await errorOf(db, call, [tenantA.key, ['w1'], Array.from({ length: 501 }, () => crypto.randomUUID())])), '22023');
      assert.equal((await db.query(call, [tenantA.key, [], [id]])).rows.length, 0);
      assert.equal((await db.query(call, [tenantA.key, ['w1'], []])).rows.length, 0);
    });

    test('not ready: no state row or a building state raise lexical_stats_not_ready (55000)', async () => {
      const id = (general[1] as Seeded).id;
      if (tenantB) {
        const error = await errorOf(db, `SELECT * FROM public.${FN}($1, ARRAY['w1'], ARRAY[$2]::uuid[])`, [tenantB.key, id]);
        assert.equal(codeOf(error), '55000', messageOf(error));
        assert.match(messageOf(error), /lexical_stats_not_ready/);
      }
      await db.query("UPDATE public.rag_lexical_stats_state SET status = 'building' WHERE tenant_key = $1", [tenantA.key]);
      try {
        const error = await errorOf(db, `SELECT * FROM public.${FN}($1, ARRAY['w1'], ARRAY[$2]::uuid[])`, [tenantA.key, id]);
        assert.equal(codeOf(error), '55000', messageOf(error));
        assert.match(messageOf(error), /lexical_stats_not_ready/);
      } finally {
        await db.query("UPDATE public.rag_lexical_stats_state SET status = 'ready' WHERE tenant_key = $1", [tenantA.key]);
      }
    });

    test("isolation: another tenant's chunk ids give no row, its statistics never change the answer; a key of the other mode is rejected", async () => {
      const terms = ['w1', 'w2', 'w3', 'w50'];
      const ids = general.slice(1, 12).map((c) => c.id);
      const before = await readStats(db, tenantA.key, terms, ids);
      if (tenantB) {
        const random = lcg(9);
        const bChunks: Seeded[] = [];
        for (let d = 0; d < 4; d += 1) {
          bChunks.push(
            ...(await seedDocument(
              db,
              [],
              tenantB,
              'general',
              'en',
              Array.from({ length: 10 }, () => ({ tokens: Array.from({ length: 20 }, () => (random() < 0.7 ? 'w1' : `w${Math.floor(random() * 4)}`)) })),
            )),
          );
        }
        await db.query('SELECT public.rag_lexstats_enable($1)', [tenantB.key]);
        await db.query('SELECT public.rag_lexstats_rebuild($1)', [tenantB.key]);
        assert.deepEqual(await readStats(db, tenantA.key, terms, ids), before, 'B present');
        assert.deepEqual(await readStats(db, tenantA.key, terms, bChunks.map((c) => c.id)), [], "B's chunk ids under A's key");
        assert.deepEqual(await readStats(db, tenantA.key, terms, [...ids, ...bChunks.slice(0, 5).map((c) => c.id)]), before, 'mixed ids keep only A');
        await db.query('UPDATE public.rag_lexical_df SET df = df * 7 + 3 WHERE tenant_key = $1', [tenantB.key]);
        await db.query('UPDATE public.rag_lexical_corpus SET chunk_count = chunk_count * 9, total_len = total_len * 2 WHERE tenant_key = $1', [tenantB.key]);
        assert.deepEqual(await readStats(db, tenantA.key, terms, ids), before, 'B statistics changed');
        const bRows = await readStats(db, tenantB.key, ['w1'], [bChunks[0]?.id as string]);
        assert.equal(bRows[0]?.chunk_count, 40 * 9, 'a call for B reads B');
        assert.deepEqual(await readStats(db, tenantB.key, ['w1'], ids), [], "A's chunk ids under B's key");
      }
      const error = await errorOf(db, `SELECT * FROM public.${FN}($1, ARRAY['w1'], ARRAY[]::uuid[])`, [wrongModeKey]);
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
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = $1`,
        [FN],
      );
      assert.deepEqual(acl.rows, [{ anon: false, authenticated: false, service_role: true, public_exec: false, definer: false, config: ['search_path=""'] }]);
      for (const role of ['anon', 'authenticated']) {
        await db.exec(`SET ROLE ${role}`);
        try {
          const error = await errorOf(db, `SELECT * FROM public.${FN}($1, ARRAY['w1'], ARRAY[]::uuid[])`, [tenantA.key]);
          assert.equal(codeOf(error), '42501', `${role}: ${messageOf(error)}`);
        } finally {
          await db.exec('RESET ROLE');
        }
      }
    });
  });
}
