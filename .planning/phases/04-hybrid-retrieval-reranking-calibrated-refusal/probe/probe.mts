import fs from 'node:fs';
import { createTwoTenantDatabase, TWO_TENANT_IDS as ids } from '/home/user/myRAG/eval/harness/two-tenant.mts';
import { FIXTURE_USER_ID } from '/home/user/myRAG/eval/harness/pglite-supabase.mts';
import { embedText } from '/home/user/myRAG/eval/harness/fixture-embedder.mts';

const out: Record<string, unknown> = {};
const vec = (t: string) => `[${embedText(t).join(',')}]`;

async function tryq(db: any, label: string, sql: string, params: unknown[] = []) {
  try {
    const r = await db.query(sql, params);
    out[label] = r.rows;
  } catch (e: any) {
    out[label] = { error: e.code ?? null, message: String(e.message).slice(0, 160) };
  }
}

const fx = await createTwoTenantDatabase();
const db = fx.db;
await tryq(db, 'version', `select version() as v, (select extversion from pg_extension where extname='vector') as pgvector`);

// Phase 3 stand-in columns (names from 03-CONTEXT D-07/D-08, D-36)
await db.exec(`
ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS tenant_key text, ADD COLUMN IF NOT EXISTS is_current boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'ready', ADD COLUMN IF NOT EXISTS doc_type text DEFAULT 'general',
  ADD COLUMN IF NOT EXISTS doc_date date, ADD COLUMN IF NOT EXISTS language text, ADD COLUMN IF NOT EXISTS source text,
  ADD COLUMN IF NOT EXISTS lexical_text text;
UPDATE document_chunks c SET tenant_key = CASE WHEN d.organization_id IS NOT NULL THEN 'o:' || d.organization_id::text ELSE 'u:' || d.user_id::text END
  FROM documents d WHERE d.id = c.document_id;
CREATE INDEX IF NOT EXISTS ch_tk ON document_chunks (tenant_key);
CREATE TABLE embedding_profiles (id text PRIMARY KEY, dims integer, storage text, status text);
INSERT INTO embedding_profiles VALUES ('openai-3-small-1536', 1536, 'legacy_column', 'active');
CREATE TABLE chunk_embeddings (chunk_id uuid, profile_id text, tenant_key text, embedding halfvec, PRIMARY KEY (chunk_id, profile_id));
`);
await db.exec(fs.readFileSync(new URL('./pattern1.sql', import.meta.url), 'utf8'));

// F-1: Postgres parser over application tokens
await tryq(db, 'F1_parser', `select to_tsvector('simple', '型号 xr-2000 xr2000 设备')::text as parsed, public.rag_lexical_tsvector('型号 xr-2000 xr2000 设备')::text as verbatim`);
await tryq(db, 'F1_parser_match', `select to_tsvector('simple', 'xr-2000') @@ '''xr-2000'''::tsquery as parser_hit, public.rag_lexical_tsvector('xr-2000') @@ '''xr-2000'''::tsquery as verbatim_hit`);

// lexical text for the three canary chunks
for (const [id, marker] of [[ids.chunkA, 'alpha'], [ids.chunkB, 'bravo'], [ids.chunkO, 'organization']] as const) {
  await db.query(`UPDATE document_chunks SET lexical_text = $2 WHERE id = $1`, [id, `two tenant isolation canary phrase xr-2000 xr2000 ${marker}`]);
}
await tryq(db, 'trigger_filled', `select count(*)::int n from document_chunks where lexical_tsv is not null`);

const call = (key: string, extra = '') =>
  `select leg, rank, chunk_id, dense_mode from public.hybrid_search_chunks(p_tenant_key => '${key}', p_profile_id => 'openai-3-small-1536',
     p_query_embedding => $1::vector, p_lexical_tokens => $2::text[], p_dense_limit => 5, p_lexical_limit => 5 ${extra}) order by leg, rank`;
const q = vec('Two tenant isolation canary phrase');
const toks = ['canary', 'xr-2000'];
await tryq(db, 'tenant_userA', call(`u:${ids.userA}`), [q, toks]);
await tryq(db, 'tenant_userB', call(`u:${ids.userB}`), [q, toks]);
await tryq(db, 'tenant_orgO', call(`o:${ids.orgO}`), [q, toks]);
await tryq(db, 'tenant_upper', call(`u:${ids.userA.toUpperCase()}`), [q, toks]);
await tryq(db, 'tenant_single_in_multi', call(`s:default`), [q, toks]);
await tryq(db, 'tenant_inject', call(`u:${ids.userA}'' OR ''1''=''1`), [q, toks]);
await tryq(db, 'foreign_doc_filter', call(`u:${ids.userA}`, `, p_document_ids => ARRAY['${ids.docB}']::uuid[]`), [q, toks]);
await tryq(db, 'empty_array_filter', call(`u:${ids.userA}`, `, p_sources => '{}'::text[]`), [q, toks]);
await tryq(db, 'token_injection', call(`u:${ids.userA}`), [q, ["a'b", 'x & y', ':*', '!', 'drop table', 'canary']]);
await tryq(db, 'exact_cutoff', call(`u:${ids.userA}`, `, p_exact_scan_cutoff => 100`), [q, []]);
await tryq(db, 'gucs_after', `select current_setting('hnsw.ef_search') ef, current_setting('hnsw.iterative_scan') it`);
await tryq(db, 'hnsw_reserved_prefix', `select set_config('hnsw.no_such_setting', 'x', true)`);

// roles
await db.exec(`ALTER ROLE service_role BYPASSRLS; GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
  GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;`);
for (const role of ['anon', 'authenticated', 'service_role']) {
  try {
    const r = await db.transaction(async (tx: any) => {
      await tx.exec(`SET LOCAL ROLE ${role}`);
      return (await tx.query(call(`u:${ids.userA}`), [q, toks])).rows.length;
    });
    out[`role_${role}`] = { rows: r };
  } catch (e: any) {
    out[`role_${role}`] = { error: e.code, message: String(e.message).slice(0, 120) };
  }
}

// P-1: ef_search cap with the HNSW index forced
for (let i = 0; i < 60; i++) {
  const t = `synthetic filler chunk number ${i} about warranty periods and device models`;
  await db.query(
    `INSERT INTO document_chunks (id, document_id, content, embedding, chunk_index, metadata, tenant_key)
     SELECT gen_random_uuid(), d.id, $1, $2::vector, 100 + $3::int, '{}'::jsonb, 'u:' || d.user_id::text FROM documents d WHERE d.user_id = $4 AND d.organization_id IS NULL LIMIT 1`,
    [t, vec(t), i, FIXTURE_USER_ID],
  );
}
await tryq(db, 'fixture_tenant_rows', `select count(*)::int n from document_chunks where tenant_key = $1`, [`u:${FIXTURE_USER_ID}`]);
await db.exec(`SET enable_seqscan = off; SET enable_bitmapscan = off;`);
await tryq(db, 'raw_ann_default_ef', `select count(*)::int n from (select id from document_chunks order by embedding <=> $1::vector limit 75) s`, [vec('warranty period')]);
await tryq(db, 'raw_ann_plan', `explain select id from document_chunks order by embedding <=> $1::vector limit 75`, [vec('warranty period')]);
await tryq(db, 'fn_dense_75',
  `select count(*)::int n, min(dense_mode) m from public.hybrid_search_chunks(p_tenant_key => 'u:${FIXTURE_USER_ID}', p_profile_id => 'openai-3-small-1536',
     p_query_embedding => $1::vector, p_lexical_tokens => '{}'::text[], p_dense_limit => 75, p_lexical_limit => 0)`, [vec('warranty period')]);

// ts_rank_cd needs positions
await tryq(db, 'rank_positions', `select ts_rank_cd(array_to_tsvector('{a,b}'), 'a'::tsquery) no_pos, ts_rank_cd(public.rag_lexical_tsvector('a b'), 'a'::tsquery) with_pos`);

console.log(JSON.stringify(out, null, 1));
await db.close();
