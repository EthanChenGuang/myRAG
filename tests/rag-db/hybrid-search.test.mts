import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { queryLexicalTokens } from '../../src/lib/rag/lexical/tokenize.ts';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURE_USER_ID, createFixtureDatabase, type DeploymentMode, type FixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REAL_CORPUS = path.join(REPO_ROOT, 'eval/fixtures/corpus');

const LEGACY = 'openai-3-small-1536';
const HALFVEC = 'test-hybrid-halfvec-1536';

type HybridRow = {
  leg: string;
  rank: number;
  chunk_id: string;
  similarity: number | null;
  lexical_score: number | null;
  dense_mode: string;
};

type Role = 'anon' | 'authenticated' | 'service_role';

function vec(values?: number[]): string {
  return `[${(values ?? embedText('warranty period')).join(',')}]`;
}

function vec3(): string {
  return '[1,0,0]';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function codeOf(error: unknown): string {
  return typeof (error as { code?: string }).code === 'string' ? (error as { code: string }).code : '';
}

async function asRole<T>(db: PGlite, role: Role, run: () => Promise<T>): Promise<T> {
  await db.exec(`SET ROLE ${role}`);
  try {
    return await run();
  } finally {
    await db.exec('RESET ROLE');
  }
}

interface HybridArgs {
  tenantKey: string;
  profile?: string;
  embedding?: string | null;
  tokens?: string[];
  denseLimit?: number;
  lexicalLimit?: number;
  exactCutoff?: number;
  iterativeScan?: string;
}

async function hybrid(db: PGlite, args: HybridArgs): Promise<HybridRow[]> {
  const {
    tenantKey,
    profile = LEGACY,
    embedding = vec(),
    tokens = [],
    denseLimit = 10,
    lexicalLimit = 10,
    exactCutoff = 0,
    iterativeScan = 'off',
  } = args;
  const result = await db.query<HybridRow>(
    `SELECT leg, rank, chunk_id::text, similarity, lexical_score, dense_mode
     FROM hybrid_search_chunks(
       p_tenant_key => $1,
       p_profile_id => $2,
       p_query_embedding => $3::vector,
       p_lexical_tokens => $4::text[],
       p_dense_limit => $5,
       p_lexical_limit => $6,
       p_exact_scan_cutoff => $7,
       p_iterative_scan => $8
     )
     ORDER BY leg, rank`,
    [tenantKey, profile, embedding, tokens, denseLimit, lexicalLimit, exactCutoff, iterativeScan],
  );
  return result.rows;
}

async function catalogRpcOids(db: PGlite, names: string[]): Promise<string> {
  const result = await db.query<{ line: string }>(
    `SELECT p.proname || ':' || p.oid::text AS line FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
     WHERE p.proname = ANY($1::text[]) ORDER BY p.proname, p.oid`,
    [names],
  );
  return result.rows.map((row) => row.line).join('|');
}

describe('hybrid_search_chunks core (0407)', () => {
  let fixture: TwoTenantDatabase;
  let db: PGlite;
  let catalogBefore: string;

  before(async () => {
    fixture = await createTwoTenantDatabase();
    db = fixture.db;
    catalogBefore = await catalogRpcOids(db, ['match_documents_by_workspace', 'match_document_chunks']);
    await db.query(
      `UPDATE document_chunks SET lexical_text = $1 WHERE id = $2`,
      ['型号 xr-2000 xr2000 设备 warranty two tenant isolation canary phrase alpha', TWO_TENANT_IDS.chunkA],
    );
    await db.query(
      `INSERT INTO embedding_profiles (id, provider, model, dims, storage, status)
       VALUES ($1, 'openai', 'test', 1536, 'halfvec', 'available')`,
      [HALFVEC],
    );
    await db.query(
      `INSERT INTO chunk_embeddings (chunk_id, profile_id, tenant_key, embedding, embedding_model, dims)
       SELECT id, $1, tenant_key, embedding::halfvec(1536), 'test', 1536 FROM document_chunks WHERE id = $2`,
      [HALFVEC, TWO_TENANT_IDS.chunkA],
    );
  });

  after(async () => {
    await db.close();
  });

  test('zh exact-term lexical query ranks XR-2000 chunk first on the lexical leg', async () => {
    const tokens = queryLexicalTokens('型号XR-2000保修');
    const rows = await hybrid(db, {
      tenantKey: `u:${TWO_TENANT_IDS.userA}`,
      tokens,
      denseLimit: 0,
      lexicalLimit: 5,
    });
    const lexical = rows.filter((row) => row.leg === 'lexical');
    assert.ok(lexical.length >= 1);
    assert.equal(lexical[0]?.chunk_id, TWO_TENANT_IDS.chunkA);
    assert.equal(lexical[0]?.rank, 1);
    assert.ok((lexical[0]?.lexical_score ?? 0) > 0);
  });

  test('dense leg orders by cosine distance and exposes similarity as one minus distance', async () => {
    const rows = await hybrid(db, {
      tenantKey: `u:${TWO_TENANT_IDS.userA}`,
      embedding: vec(embedText('two tenant isolation canary')),
      tokens: [],
      denseLimit: 5,
      lexicalLimit: 0,
    });
    const dense = rows.filter((row) => row.leg === 'dense');
    assert.ok(dense.length >= 1);
    for (const row of dense) {
      assert.ok(row.similarity === null || row.similarity <= 1);
    }
    const ranks = dense.map((row) => row.rank);
    assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
  });

  test('halfvec profile routes through chunk_embeddings', async () => {
    const rows = await hybrid(db, {
      tenantKey: `u:${TWO_TENANT_IDS.userA}`,
      profile: HALFVEC,
      embedding: vec(embedText('two tenant isolation canary')),
      tokens: [],
      denseLimit: 3,
      lexicalLimit: 0,
    });
    const dense = rows.filter((row) => row.leg === 'dense');
    assert.ok(dense.some((row) => row.chunk_id === TWO_TENANT_IDS.chunkA));
  });

  test('wrong embedding dims and unknown profile raise embedding_profile_mismatch', async () => {
    await assert.rejects(
      () =>
        hybrid(db, {
          tenantKey: `u:${TWO_TENANT_IDS.userA}`,
          embedding: vec3(),
          tokens: [],
          denseLimit: 1,
          lexicalLimit: 0,
        }),
      (error: unknown) => messageOf(error).includes('embedding_profile_mismatch: dims') && codeOf(error) === '22000',
    );
    await assert.rejects(
      () =>
        hybrid(db, {
          tenantKey: `u:${TWO_TENANT_IDS.userA}`,
          profile: 'no-such-profile',
          tokens: [],
          denseLimit: 1,
          lexicalLimit: 0,
        }),
      (error: unknown) => messageOf(error).includes('unknown profile') && codeOf(error) === '22023',
    );
  });

  test('empty lexical tokens yield dense-only; dense limit zero with null vector yields lexical-only', async () => {
    const denseOnly = await hybrid(db, {
      tenantKey: `u:${TWO_TENANT_IDS.userA}`,
      tokens: [],
      denseLimit: 3,
      lexicalLimit: 5,
    });
    assert.ok(denseOnly.every((row) => row.leg === 'dense'));

    const lexicalOnly = await hybrid(db, {
      tenantKey: `u:${TWO_TENANT_IDS.userA}`,
      embedding: null,
      tokens: ['canary'],
      denseLimit: 0,
      lexicalLimit: 5,
    });
    assert.ok(lexicalOnly.every((row) => row.leg === 'lexical'));
  });

  test('injection-shaped tokens next to canary never raise', async () => {
    const tokens = ["a'b", 'x & y', ':*', '!', 'drop table', 'canary'];
    const rows = await hybrid(db, {
      tenantKey: `u:${TWO_TENANT_IDS.userA}`,
      tokens,
      denseLimit: 0,
      lexicalLimit: 5,
    });
    assert.ok(rows.length >= 1);
  });

  test('exact scan cutoff switches dense_mode to exact and preserves the top hit', async () => {
    const ann = await hybrid(db, {
      tenantKey: `u:${TWO_TENANT_IDS.userA}`,
      tokens: [],
      denseLimit: 5,
      lexicalLimit: 0,
      exactCutoff: 0,
    });
    const exact = await hybrid(db, {
      tenantKey: `u:${TWO_TENANT_IDS.userA}`,
      tokens: [],
      denseLimit: 5,
      lexicalLimit: 0,
      exactCutoff: 100,
    });
    assert.equal(exact[0]?.dense_mode, 'exact');
    assert.equal(exact[0]?.chunk_id, ann[0]?.chunk_id);
  });

  test('bogus iterative scan mode and out-of-range limits raise 22023', async () => {
    await assert.rejects(
      () =>
        hybrid(db, {
          tenantKey: `u:${TWO_TENANT_IDS.userA}`,
          iterativeScan: 'bogus',
          denseLimit: 1,
          lexicalLimit: 0,
        }),
      (error: unknown) => codeOf(error) === '22023',
    );
    await assert.rejects(
      () =>
        hybrid(db, {
          tenantKey: `u:${TWO_TENANT_IDS.userA}`,
          denseLimit: 500,
          lexicalLimit: 0,
        }),
      (error: unknown) => codeOf(error) === '22023',
    );
    await assert.rejects(
      () =>
        hybrid(db, {
          tenantKey: `u:${TWO_TENANT_IDS.userA}`,
          exactCutoff: 200_000,
          denseLimit: 1,
          lexicalLimit: 0,
        }),
      (error: unknown) => codeOf(error) === '22023',
    );
  });

  test('iterative scan other than off raises iterative_scan_unsupported when pgvector is below 0.8', async () => {
    await db.query(`UPDATE pg_extension SET extversion = '0.7.9' WHERE extname = 'vector'`);
    try {
      await assert.rejects(
        () =>
          hybrid(db, {
            tenantKey: `u:${TWO_TENANT_IDS.userA}`,
            iterativeScan: 'relaxed_order',
            denseLimit: 3,
            lexicalLimit: 0,
          }),
        (error: unknown) => messageOf(error).includes('iterative_scan_unsupported'),
      );
    } finally {
      await db.query(`UPDATE pg_extension SET extversion = '0.8.7' WHERE extname = 'vector'`);
    }
  });

  test('p_dense_limit 75 returns 75 dense rows and resets GUCs after the call', async () => {
    for (let i = 0; i < 60; i++) {
      const text = `synthetic filler chunk ${i} warranty device`;
      await db.query(
        `INSERT INTO document_chunks (id, document_id, content, embedding, chunk_index, metadata, tenant_key, lexical_text, is_current, status)
         SELECT gen_random_uuid(), d.id, $1, $2::vector, 100 + $3::int, '{}'::jsonb, 'u:' || d.user_id::text, $1, true, 'ready'
         FROM documents d WHERE d.user_id = $4 AND d.organization_id IS NULL LIMIT 1`,
        [text, vec(embedText(text)), i, FIXTURE_USER_ID],
      );
    }
    await db.exec('SET enable_seqscan = off; SET enable_bitmapscan = off;');
  const rows = await hybrid(db, {
      tenantKey: `u:${FIXTURE_USER_ID}`,
      embedding: vec(embedText('warranty device')),
      tokens: [],
      denseLimit: 75,
      lexicalLimit: 0,
    });
    assert.equal(rows.length, 75);
    assert.equal(rows[0]?.dense_mode, 'ann');
    const gucs = await db.query<{ ef: string; it: string }>(
      `SELECT current_setting('hnsw.ef_search') AS ef, current_setting('hnsw.iterative_scan') AS it`,
    );
    assert.equal(gucs.rows[0]?.ef, '40');
    assert.equal(gucs.rows[0]?.it, 'off');
    await db.exec('RESET enable_seqscan; RESET enable_bitmapscan;');
  });

  test('legacy RPC definitions unchanged after 0407', async () => {
    const catalogAfter = await catalogRpcOids(db, ['match_documents_by_workspace', 'match_document_chunks']);
    assert.equal(catalogAfter, catalogBefore);
  });
});

for (const mode of ['multi-tenant', 'single-tenant'] as DeploymentMode[]) {
  describe(`hybrid_search_chunks grants in PGlite (${mode})`, () => {
    let fixture: FixtureDatabase;

    before(async () => {
      fixture = await createFixtureDatabase({ deploymentMode: mode, corpusDir: REAL_CORPUS });
    });

    after(async () => {
      await fixture.db.close();
    });

    test('anon and authenticated are refused with 42501; service_role succeeds', async () => {
      const tenant = mode === 'multi-tenant' ? `u:${FIXTURE_USER_ID}` : 's:default';
      const params = [tenant, LEGACY, vec(), ['test'], 1, 0];
      for (const role of ['anon', 'authenticated'] as const) {
        await assert.rejects(
          () =>
            asRole(fixture.db, role, () =>
              fixture.db.query('SELECT 1 FROM hybrid_search_chunks(p_tenant_key => $1, p_profile_id => $2, p_query_embedding => $3::vector, p_lexical_tokens => $4::text[], p_dense_limit => $5, p_lexical_limit => $6)', params),
            ),
          (error: unknown) => {
            const message = messageOf(error);
            return codeOf(error) === '42501' && message.includes('hybrid_search_chunks');
          },
        );
      }
      await asRole(fixture.db, 'service_role', () =>
        fixture.db.query('SELECT 1 FROM hybrid_search_chunks(p_tenant_key => $1, p_profile_id => $2, p_query_embedding => $3::vector, p_lexical_tokens => $4::text[], p_dense_limit => $5, p_lexical_limit => $6) LIMIT 1', params),
      );
    });
  });
}