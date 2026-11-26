import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';

/**
 * 0473 terminology mining (D-25, D-26, D-07): the miss log and the candidate table are tenant-scoped, expire after 30 days without any
 * schedule, count corpus document frequency on the tenant's current, ready chunks only, and are service_role only.
 * Terms are the D-37 placeholders; the language code comes from the registry (D-35).
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATION = 'supabase/migrations/0473_terminology_mining.sql';
const ANON_KEY = 'fixture-anon-key-placeholder';
const SERVICE_KEY = 'fixture-service-role-key-placeholder';

const ADMIN_A = '00000000-0000-4000-8000-00000000a0a1';
const ADMIN_B = '00000000-0000-4000-8000-00000000b0b1';
const NON_ADMIN = '00000000-0000-4000-8000-00000000c0c1';
const TENANT_A = `u:${ADMIN_A}`;
const TENANT_B = `u:${ADMIN_B}`;

const REGISTRY = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'config/rag/language-packs.json'), 'utf8')) as { packs: { code: string }[] };
const LANG = REGISTRY.packs[0]!.code;

const PUBLIC_FUNCTIONS = [
  'public.rag_term_record_miss(text, jsonb)',
  'public.rag_term_purge_misses(integer)',
  'public.rag_term_read_misses(text, integer)',
  'public.rag_term_corpus_df(text, text[])',
  'public.rag_term_upsert_candidates(text, jsonb)',
  'public.rag_term_list_candidates(uuid, text, integer, integer)',
  'public.rag_term_decide_candidate(uuid, uuid, text, uuid)',
];

type Json = Record<string, unknown>;

function miss(overrides: Json = {}): Json {
  return {
    source: 'miss_log',
    query_masked: 'where is termalpha described',
    language: LANG,
    status: 'empty',
    reason: 'no_candidates',
    top_score: 0.12,
    dictionary_version: 's1',
    retrieval_config_hash: 'a'.repeat(64),
    profile: 'chat',
    ...overrides,
  };
}

function candidate(overrides: Json = {}): Json {
  return { term: 'termalpha', language: LANG, support: 3, examples: ['where is termalpha described'], corpus_df: 0, ...overrides };
}

function sqlState(error: unknown): string {
  return typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : '';
}

async function rejectsCode(db: PGlite, run: () => Promise<unknown>, code: string): Promise<void> {
  await db.exec('SAVEPOINT expected_failure');
  await assert.rejects(run, (error: unknown) => {
    assert.equal(sqlState(error), 'P0001', `expected P0001, got ${sqlState(error)}: ${String((error as Error)?.message)}`);
    assert.equal((error as Error).message, code);
    return true;
  });
  await db.exec('ROLLBACK TO SAVEPOINT expected_failure');
}

async function rejectsAny(db: PGlite, run: () => Promise<unknown>): Promise<void> {
  await db.exec('SAVEPOINT expected_failure');
  await assert.rejects(run);
  await db.exec('ROLLBACK TO SAVEPOINT expected_failure');
}

async function asService(db: PGlite, run: () => Promise<void>): Promise<void> {
  await db.exec('BEGIN');
  try {
    await db.exec('SET LOCAL ROLE service_role');
    await run();
  } finally {
    await db.exec('ROLLBACK');
  }
}

/** Owner-side setup that service_role may not do itself (backdating rows, seeding documents). */
async function asOwner(db: PGlite, run: () => Promise<void>): Promise<void> {
  await db.exec('RESET ROLE');
  try {
    await run();
  } finally {
    await db.exec('SET LOCAL ROLE service_role');
  }
}

async function record(db: PGlite, tenant: string, row: Json): Promise<string> {
  const result = await db.query<{ id: string }>('SELECT public.rag_term_record_miss($1, $2::jsonb)::text AS id', [tenant, JSON.stringify(row)]);
  return result.rows[0]!.id;
}

async function missCount(db: PGlite, tenant: string): Promise<number> {
  const result = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.rag_term_misses WHERE tenant_key = $1', [tenant]);
  return result.rows[0]!.n;
}

async function readMisses(db: PGlite, tenant: string, days: number): Promise<string[]> {
  const result = await db.query<{ query_masked: string }>('SELECT query_masked FROM public.rag_term_read_misses($1, $2) ORDER BY query_masked', [tenant, days]);
  return result.rows.map((row) => row.query_masked);
}

async function backdate(db: PGlite, id: string, days: number): Promise<void> {
  await asOwner(db, async () => {
    await db.query(`UPDATE public.rag_term_misses SET created_at = now() - make_interval(days => $2) WHERE id = $1`, [id, days]);
  });
}

async function df(db: PGlite, tenant: string, tokens: string[]): Promise<Record<string, number>> {
  const result = await db.query<{ token: string; df: number }>('SELECT token, df::int AS df FROM public.rag_term_corpus_df($1, $2::text[])', [tenant, tokens]);
  return Object.fromEntries(result.rows.map((row) => [row.token, row.df]));
}

async function upsertCandidates(db: PGlite, tenant: string, rows: Json[]): Promise<number> {
  const result = await db.query<{ n: number }>('SELECT public.rag_term_upsert_candidates($1, $2::jsonb)::int AS n', [tenant, JSON.stringify(rows)]);
  return result.rows[0]!.n;
}

interface CandidateRow {
  id: string;
  term: string;
  status: string;
  support: number;
  examples: string[];
  entry_id: string | null;
  decided_by: string | null;
  last_seen: string;
}

async function candidateRow(db: PGlite, tenant: string, term: string): Promise<CandidateRow | undefined> {
  const result = await db.query<CandidateRow>(
    'SELECT id::text AS id, term, status, support, examples, entry_id::text AS entry_id, decided_by::text AS decided_by, last_seen::text AS last_seen FROM public.rag_term_candidates WHERE tenant_key = $1 AND term = $2',
    [tenant, term],
  );
  return result.rows[0];
}

async function decide(db: PGlite, actor: string, id: string, action: string, entryId: string | null = null): Promise<{ status: string; entry_id: string | null }> {
  const result = await db.query<{ status: string; entry_id: string | null }>(
    'SELECT status, entry_id::text AS entry_id FROM public.rag_term_decide_candidate(p_actor => $1, p_candidate_id => $2, p_action => $3, p_entry_id => $4)',
    [actor, id, action, entryId],
  );
  return result.rows[0]!;
}

async function auditOf(db: PGlite, layer: string): Promise<{ action: string; entry_id: string | null; actor: string; after: Json | null }[]> {
  const result = await db.query<{ action: string; entry_id: string | null; actor: string; after: Json | null }>(
    'SELECT action, entry_id::text AS entry_id, actor::text AS actor, after FROM public.rag_term_audit WHERE layer_key = $1 ORDER BY created_at, id',
    [layer],
  );
  return result.rows;
}

async function seedActors(db: PGlite, mode: DeploymentMode): Promise<void> {
  await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4), ($5, $6) ON CONFLICT DO NOTHING', [
    ADMIN_A,
    'admin-a@example.invalid',
    ADMIN_B,
    'admin-b@example.invalid',
    NON_ADMIN,
    'member@example.invalid',
  ]);
  await db.query('INSERT INTO admin_users (id) VALUES ($1), ($2)', [ADMIN_A, ADMIN_B]);
  void mode;
}

interface ChunkSeed {
  tenant: string;
  owner: string;
  text: string;
  isCurrent?: boolean;
  status?: string;
}

async function seedChunk(db: PGlite, mode: DeploymentMode, seed: ChunkSeed): Promise<string> {
  const docId = crypto.randomUUID();
  if (mode === 'multi-tenant') {
    await db.query("INSERT INTO documents (id, filename, content, user_id, is_current, status) VALUES ($1, 'synthetic.md', $2, $3, true, 'ready')", [docId, seed.text, seed.owner]);
  } else {
    await db.query("INSERT INTO documents (id, filename, content, is_current, status) VALUES ($1, 'synthetic.md', $2, true, 'ready')", [docId, seed.text]);
  }
  await db.query(
    'INSERT INTO document_chunks (id, document_id, content, lexical_text, tenant_key, is_current, status) VALUES ($1, $2, $3, $3, $4, $5, $6)',
    [crypto.randomUUID(), docId, seed.text, seed.tenant, seed.isCurrent ?? true, seed.status ?? 'ready'],
  );
  return docId;
}

describe('terminology mining 0473 (multi-tenant)', () => {
  let db: PGlite;

  before(async () => {
    db = (await createEmptyFixtureDatabase({ deploymentMode: 'multi-tenant' })).db;
    await seedActors(db, 'multi-tenant');
    await seedChunk(db, 'multi-tenant', { tenant: TENANT_A, owner: ADMIN_A, text: 'termalpha appears here' });
    await seedChunk(db, 'multi-tenant', { tenant: TENANT_A, owner: ADMIN_A, text: 'termalpha appears again' });
    await seedChunk(db, 'multi-tenant', { tenant: TENANT_A, owner: ADMIN_A, text: 'termalpha superseded text', isCurrent: false });
    await seedChunk(db, 'multi-tenant', { tenant: TENANT_A, owner: ADMIN_A, text: 'termalpha processing text', status: 'processing' });
    await seedChunk(db, 'multi-tenant', { tenant: TENANT_B, owner: ADMIN_B, text: 'termalpha appears here' });
    await seedChunk(db, 'multi-tenant', { tenant: TENANT_B, owner: ADMIN_B, text: 'termgamma only in b' });
  });

  after(async () => {
    await db?.close();
  });

  test('record_miss inserts; an over-long query or an unknown profile is rejected', async () => {
    await asService(db, async () => {
      const id = await record(db, TENANT_A, miss());
      assert.match(id, /^[0-9a-f-]{36}$/);
      const stored = await db.query<Json>('SELECT tenant_key, source, query_masked, status, profile, dictionary_version FROM public.rag_term_misses WHERE id = $1', [id]);
      assert.deepEqual(stored.rows[0], { tenant_key: TENANT_A, source: 'miss_log', query_masked: 'where is termalpha described', status: 'empty', profile: 'chat', dictionary_version: 's1' });
      await record(db, TENANT_A, miss({ dictionary_version: null, profile: 'voice' }));
      await record(db, TENANT_A, miss({ profile: 'embed', query_masked: 'x'.repeat(500) }));
      await rejectsCode(db, () => record(db, TENANT_A, miss({ query_masked: 'x'.repeat(501) })), 'invalid_miss');
      await rejectsCode(db, () => record(db, TENANT_A, miss({ profile: 'eval' })), 'invalid_miss');
      await rejectsCode(db, () => record(db, TENANT_A, miss({ source: 'other' })), 'invalid_miss');
      await rejectsCode(db, () => record(db, TENANT_A, miss({ query_masked: '' })), 'invalid_miss');
      await rejectsAny(db, () => record(db, 's:default', miss()));
      assert.equal(await missCount(db, TENANT_A), 3);
    });
  });

  test('corpus_df counts only that tenant\'s current, ready chunks', async () => {
    await asService(db, async () => {
      assert.deepEqual(await df(db, TENANT_A, ['termalpha', 'zzzz']), { termalpha: 2, zzzz: 0 });
      assert.deepEqual(await df(db, TENANT_A, ['termgamma']), { termgamma: 0 });
      assert.deepEqual(await df(db, TENANT_B, ['termalpha', 'termgamma']), { termalpha: 1, termgamma: 1 });
      await rejectsAny(db, () => df(db, 's:default', ['termalpha']));
    });
  });

  test('purge_misses deletes rows older than the window and keeps newer ones; purge_misses(0) raises', async () => {
    await asService(db, async () => {
      const old = await record(db, TENANT_A, miss({ query_masked: 'old query' }));
      await record(db, TENANT_A, miss({ query_masked: 'new query' }));
      await backdate(db, old, 31);
      const purged = await db.query<{ n: number }>('SELECT public.rag_term_purge_misses(30)::int AS n');
      assert.equal(purged.rows[0]!.n, 1);
      assert.deepEqual(await readMisses(db, TENANT_A, 30), ['new query']);
      await rejectsCode(db, () => db.query('SELECT public.rag_term_purge_misses(0)'), 'invalid_window');
    });
  });

  test('record_miss for A deletes A\'s old rows only; every read ignores B\'s old row until B records', async () => {
    await asService(db, async () => {
      const oldA = await record(db, TENANT_A, miss({ query_masked: 'old a' }));
      const oldB = await record(db, TENANT_B, miss({ query_masked: 'old b' }));
      await backdate(db, oldA, 31);
      await backdate(db, oldB, 31);
      await record(db, TENANT_A, miss({ query_masked: 'fresh a' }));
      const ids = await db.query<{ id: string }>('SELECT id::text AS id FROM public.rag_term_misses ORDER BY id');
      assert.ok(!ids.rows.some((row) => row.id === oldA), "A's old row is gone");
      assert.ok(ids.rows.some((row) => row.id === oldB), "B's old row stays until B records");
      assert.deepEqual(await readMisses(db, TENANT_B, 30), []);
      assert.deepEqual(await readMisses(db, TENANT_B, 90), [], 'the window never reaches past 30 days');
      assert.deepEqual(await readMisses(db, TENANT_A, 14), ['fresh a']);
      await record(db, TENANT_B, miss({ query_masked: 'fresh b' }));
      assert.equal(await missCount(db, TENANT_B), 1);
    });
  });

  test('upsert_candidates keeps a dismissed or accepted status and updates support and last_seen', async () => {
    await asService(db, async () => {
      assert.equal(await upsertCandidates(db, TENANT_A, [candidate(), candidate({ term: 'termbeta', support: 4 })]), 2);
      const first = await candidateRow(db, TENANT_A, 'termalpha');
      assert.equal(first?.status, 'pending');
      await decide(db, ADMIN_A, first!.id, 'dismiss');
      await asOwner(db, async () => {
        await db.query("UPDATE public.rag_term_candidates SET last_seen = now() - interval '2 days' WHERE id = $1", [first!.id]);
      });
      const before = await candidateRow(db, TENANT_A, 'termalpha');
      await upsertCandidates(db, TENANT_A, [candidate({ support: 9, examples: ['a', 'b', 'c'] })]);
      const afterRow = await candidateRow(db, TENANT_A, 'termalpha');
      assert.equal(afterRow?.status, 'dismissed');
      assert.equal(afterRow?.support, 9);
      assert.ok(new Date(afterRow!.last_seen) > new Date(before!.last_seen));
      await rejectsCode(db, () => upsertCandidates(db, TENANT_A, [candidate({ examples: ['a', 'b', 'c', 'd'] })]), 'invalid_candidate');
      await rejectsCode(db, () => upsertCandidates(db, TENANT_A, [candidate({ status: 'accepted' })]), 'invalid_candidate');
      assert.equal((await candidateRow(db, TENANT_B, 'termalpha')), undefined);
    });
  });

  test('upsert_candidates clears the examples of candidates not seen for 30 days', async () => {
    await asService(db, async () => {
      await upsertCandidates(db, TENANT_A, [candidate({ term: 'termstale', examples: ['stale masked query'] })]);
      await asOwner(db, async () => {
        await db.query("UPDATE public.rag_term_candidates SET last_seen = now() - interval '31 days' WHERE term = 'termstale'");
      });
      await upsertCandidates(db, TENANT_A, [candidate({ term: 'termother' })]);
      assert.deepEqual((await candidateRow(db, TENANT_A, 'termstale'))?.examples, []);
    });
  });

  test('decide_candidate: another tenant answers not_found; dismiss and accept write one audit row each', async () => {
    await asService(db, async () => {
      await upsertCandidates(db, TENANT_A, [candidate(), candidate({ term: 'termbeta' })]);
      await upsertCandidates(db, TENANT_B, [candidate({ term: 'termgamma' })]);
      const a = (await candidateRow(db, TENANT_A, 'termalpha'))!;
      const a2 = (await candidateRow(db, TENANT_A, 'termbeta'))!;
      const b = (await candidateRow(db, TENANT_B, 'termgamma'))!;

      await rejectsCode(db, () => decide(db, ADMIN_A, b.id, 'dismiss'), 'not_found');
      await rejectsCode(db, () => decide(db, ADMIN_A, crypto.randomUUID(), 'dismiss'), 'not_found');
      await rejectsCode(db, () => decide(db, NON_ADMIN, a.id, 'dismiss'), 'not_admin');
      await rejectsCode(db, () => decide(db, ADMIN_A, a.id, 'other'), 'invalid_action');
      assert.equal((await candidateRow(db, TENANT_B, 'termgamma'))?.status, 'pending');

      const dismissed = await decide(db, ADMIN_A, a.id, 'dismiss');
      assert.deepEqual(dismissed, { status: 'dismissed', entry_id: null });
      const auditA = await auditOf(db, TENANT_A);
      assert.equal(auditA.length, 1);
      assert.equal(auditA[0]?.action, 'candidate_dismiss');
      assert.equal(auditA[0]?.actor, ADMIN_A);
      assert.equal(auditA[0]?.after?.candidate_id, a.id);
      await rejectsCode(db, () => decide(db, ADMIN_A, a.id, 'dismiss'), 'not_pending');

      const bEntry = await db.query<{ entry_id: string }>(
        "SELECT entry_id::text AS entry_id FROM public.rag_term_upsert_entry($1, $2, $3::jsonb, 0)",
        [ADMIN_B, TENANT_B, JSON.stringify({ canonical: 'term gamma delta', variants: ['termgamma'], normalized_variants: ['termgamma'], language: 'any', kind: 'synonym' })],
      );
      await rejectsCode(db, () => decide(db, ADMIN_A, a2.id, 'accept', bEntry.rows[0]!.entry_id), 'not_found');
      await rejectsCode(db, () => decide(db, ADMIN_A, a2.id, 'accept', null), 'not_found');
      const shared = await db.query<{ entry_id: string }>(
        "SELECT entry_id::text AS entry_id FROM public.rag_term_upsert_entry($1, 'shared', $2::jsonb, 0)",
        [ADMIN_A, JSON.stringify({ canonical: 'term alpha beta', variants: ['termbeta'], normalized_variants: ['termbeta'], language: 'any', kind: 'synonym' })],
      );
      const accepted = await decide(db, ADMIN_A, a2.id, 'accept', shared.rows[0]!.entry_id);
      assert.deepEqual(accepted, { status: 'accepted', entry_id: shared.rows[0]!.entry_id });
      const row = await candidateRow(db, TENANT_A, 'termbeta');
      assert.equal(row?.decided_by, ADMIN_A);
      const audit = await auditOf(db, TENANT_A);
      // created_at ties inside one transaction and id is a random uuid, so compare without order.
      const byAction = (a: [string, string | null], b: [string, string | null]) => a[0].localeCompare(b[0]);
      assert.deepEqual(
        audit.map((r): [string, string | null] => [r.action, r.entry_id]).sort(byAction),
        ([['candidate_accept', shared.rows[0]!.entry_id], ['candidate_dismiss', null]] as [string, string | null][]).sort(byAction),
      );
    });
  });

  test('list_candidates returns only the layer the admin administers', async () => {
    await asService(db, async () => {
      await upsertCandidates(db, TENANT_A, [candidate(), candidate({ term: 'termbeta', support: 7 })]);
      await upsertCandidates(db, TENANT_B, [candidate({ term: 'termgamma' })]);
      const listed = await db.query<{ term: string; total_count: number }>(
        'SELECT term, total_count::int AS total_count FROM public.rag_term_list_candidates($1, $2, 1, 0)',
        [ADMIN_A, TENANT_A],
      );
      assert.deepEqual(listed.rows, [{ term: 'termbeta', total_count: 2 }]);
      await rejectsCode(db, () => db.query('SELECT * FROM public.rag_term_list_candidates($1, $2, 10, 0)', [ADMIN_A, TENANT_B]), 'not_admin_of_layer');
      await rejectsCode(db, () => db.query('SELECT * FROM public.rag_term_list_candidates($1, $2, 10, 0)', [NON_ADMIN, TENANT_A]), 'not_admin');
    });
  });

  test('anon and authenticated cannot execute any function or read either table', async () => {
    for (const signature of PUBLIC_FUNCTIONS) {
      const privileges = await db.query<{ anon: boolean; authenticated: boolean; service: boolean; definer: boolean; config: string[] | null }>(
        `SELECT has_function_privilege('anon', $1, 'EXECUTE') AS anon, has_function_privilege('authenticated', $1, 'EXECUTE') AS authenticated,
                has_function_privilege('service_role', $1, 'EXECUTE') AS service, p.prosecdef AS definer, p.proconfig AS config
           FROM pg_catalog.pg_proc p WHERE p.oid = $1::regprocedure`,
        [signature],
      );
      assert.deepEqual(privileges.rows[0], { anon: false, authenticated: false, service: true, definer: true, config: ['search_path=""'] }, signature);
    }
    for (const table of ['public.rag_term_misses', 'public.rag_term_candidates']) {
      const privileges = await db.query<{ anon: boolean; authenticated: boolean; rls: boolean; policies: number }>(
        `SELECT has_table_privilege('anon', $1, 'SELECT') AS anon, has_table_privilege('authenticated', $1, 'SELECT') AS authenticated,
                c.relrowsecurity AS rls, (SELECT count(*)::int FROM pg_catalog.pg_policy p WHERE p.polrelid = c.oid) AS policies
           FROM pg_catalog.pg_class c WHERE c.oid = $1::regclass`,
        [table],
      );
      assert.deepEqual(privileges.rows[0], { anon: false, authenticated: false, rls: true, policies: 0 }, table);
    }

    let edge: FakeEdge | undefined;
    try {
      edge = await startFakeEdge({ db, serviceKeys: [SERVICE_KEY], anonKey: ANON_KEY });
      const calls: [string, Json][] = [
        ['rag_term_record_miss', { p_tenant_key: TENANT_A, p_row: miss() }],
        ['rag_term_purge_misses', { p_older_than_days: 30 }],
        ['rag_term_read_misses', { p_tenant_key: TENANT_A, p_window_days: 14 }],
        ['rag_term_corpus_df', { p_tenant_key: TENANT_A, p_tokens: ['termalpha'] }],
        ['rag_term_upsert_candidates', { p_tenant_key: TENANT_A, p_rows: [candidate()] }],
        ['rag_term_list_candidates', { p_actor: ADMIN_A, p_layer_key: TENANT_A, p_limit: 10, p_offset: 0 }],
        ['rag_term_decide_candidate', { p_actor: ADMIN_A, p_candidate_id: ADMIN_A, p_action: 'dismiss', p_entry_id: null }],
      ];
      for (const [name, body] of calls) {
        const res: Response = await fetch(`${edge.url}/rest/v1/rpc/${name}`, {
          method: 'POST',
          headers: { apikey: ANON_KEY, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        assert.equal(res.status, 403, name);
        assert.equal(((await res.json()) as { code?: string }).code, '42501', name);
      }
      for (const table of ['rag_term_misses', 'rag_term_candidates']) {
        const res: Response = await fetch(`${edge.url}/rest/v1/${table}?select=*`, { headers: { apikey: ANON_KEY } });
        assert.notEqual(res.status, 200, table);
        await res.text();
      }
      const listed = await fetch(`${edge.url}/rest/v1/rpc/rag_term_corpus_df`, {
        method: 'POST',
        headers: { apikey: SERVICE_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ p_tenant_key: TENANT_A, p_tokens: ['termalpha'] }),
      });
      assert.equal(listed.status, 200);
      await listed.text();
    } finally {
      await edge?.close();
    }
  });

  test('applying 0473 a second time succeeds and keeps the grants', async () => {
    const sql = fs.readFileSync(path.join(REPO_ROOT, MIGRATION), 'utf8');
    await db.exec(sql);
    await db.exec(sql);
    const privileges = await db.query<{ anon: boolean; service: boolean }>(
      "SELECT has_function_privilege('anon', 'public.rag_term_record_miss(text, jsonb)', 'EXECUTE') AS anon, has_function_privilege('service_role', 'public.rag_term_record_miss(text, jsonb)', 'EXECUTE') AS service",
    );
    assert.deepEqual(privileges.rows[0], { anon: false, service: true });
  });
});

describe('terminology mining 0473 (single-tenant)', () => {
  let db: PGlite;

  before(async () => {
    db = (await createEmptyFixtureDatabase({ deploymentMode: 'single-tenant' })).db;
    await seedActors(db, 'single-tenant');
    await seedChunk(db, 'single-tenant', { tenant: 's:default', owner: ADMIN_A, text: 'termalpha appears here' });
  });

  after(async () => {
    await db?.close();
  });

  test('record, read, df, candidates and decisions work on s:default', async () => {
    await asService(db, async () => {
      await record(db, 's:default', miss());
      await rejectsCode(db, () => record(db, 's:default', miss({ profile: 'eval' })), 'invalid_miss');
      await rejectsAny(db, () => record(db, TENANT_A, miss()));
      assert.deepEqual(await readMisses(db, 's:default', 30), ['where is termalpha described']);
      assert.deepEqual(await df(db, 's:default', ['termalpha']), { termalpha: 1 });
      await upsertCandidates(db, 's:default', [candidate()]);
      const row = (await candidateRow(db, 's:default', 'termalpha'))!;
      const listed = await db.query<{ term: string }>('SELECT term FROM public.rag_term_list_candidates($1, $2, 10, 0)', [ADMIN_B, 's:default']);
      assert.deepEqual(listed.rows, [{ term: 'termalpha' }]);
      assert.deepEqual(await decide(db, ADMIN_B, row.id, 'dismiss'), { status: 'dismissed', entry_id: null });
      assert.equal((await auditOf(db, 's:default')).length, 1);
    });
  });
});
