import { after, before, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';

/**
 * D-26: candidate mining and review on a multi-tenant fixture database. Misses go in through rag_term_record_miss; the miner, the 0473
 * functions, rag_term_effective and the admin routes run as real SQL through the fake edge. The one table read of the miner (listing the
 * tenants with misses) runs on PGlite as service_role, because the fake edge serves a fixed table list. Only the token check is faked.
 * D-37: placeholder terms; the corpus is tests/fixtures/terminology-corpus (plan 05) plus synthetic sentences; D-35: registry languages.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REGISTRY = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'config/rag/language-packs.json'), 'utf8')) as {
  packs: { code: string; script: string }[];
};
const HAN = REGISTRY.packs.find((pack) => pack.script === 'Hani')!.code;
const LATIN = REGISTRY.packs.find((pack) => pack.script === 'Latn')!.code;
const CORPUS_DIR = path.join(REPO_ROOT, 'tests/fixtures/terminology-corpus');

const ADMIN_A = '00000000-0000-4000-8000-00000000a011';
const ADMIN_B = '00000000-0000-4000-8000-00000000b022';
const ORG_A = '00000000-0000-4000-8000-0000000000e7';
const ORG_B = '00000000-0000-4000-8000-0000000000e8';
const TENANT_A = `u:${ADMIN_A}`;
const TENANT_B = `o:${ORG_B}`;
const TOKENS: Record<string, string> = { 'token-a': ADMIN_A, 'token-b': ADMIN_B };

const LATIN_TERM = 'termdelta';
const HAN_TERM = '术语丁戊';
const LATIN_QUERIES = ['where is termdelta configured', 'termdelta rollout steps', 'who owns termdelta today'];
const HAN_QUERIES = ['术语丁戊怎么申请', '请说明术语丁戊流程', '术语丁戊在哪里找'];

const db: PGlite = (await createEmptyFixtureDatabase({ deploymentMode: 'multi-tenant' })).db;
const edge: FakeEdge = await startFakeEdge({ db });
Object.assign(process.env, fixtureProcessEnv(edge.url));
// D-36: the supported languages are set explicitly for this test, never taken from a shipped default.
process.env.RAG_SUPPORTED_LANGUAGES = [HAN, LATIN].join(',');
process.env.RAG_PRIMARY_LANGUAGE = LATIN;
process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
process.env.MYRAG_DEPLOYMENT_MODE = 'multi-tenant';

await import('@/lib/env');
const supabaseModule = await import('@/lib/supabase');
const listRoute = await import('@/app/api/rag/admin/terminology/candidates/route');
const decideRoute = await import('@/app/api/rag/admin/terminology/candidates/[id]/route');
const entriesRoute = await import('@/app/api/rag/admin/terminology/route');
const { mineCandidates } = await import('@/lib/rag/terminology/mine/mine');
type MinerDb = import('@/lib/rag/terminology/mine/mine').MinerDb;
const { invalidateTerminologyCache } = await import('@/lib/rag/terminology/load');
const { resetLanguageSettingsForTests } = await import('@/lib/rag/lang/settings');
const { lexicalTokens } = await import('@/lib/rag/lexical/tokenize');
const { mintScope, scopeKey } = await import('@/lib/rag/tenant/scope');
type TenantScope = import('@/lib/rag/tenant/scope').TenantScope;

const SCOPES = new Map<string, TenantScope>([
  [TENANT_A, mintScope('personal', ADMIN_A, null)],
  [TENANT_B, mintScope('org', null, ORG_B)],
]);
assert.equal(scopeKey(SCOPES.get(TENANT_B)!), TENANT_B);
const resolveScope = async (tenantKey: string) => SCOPES.get(tenantKey) ?? null;

type Row = Record<string, unknown>;

function fakeTokens(): void {
  const admin = supabaseModule.getSupabaseAdmin() as unknown as { auth: { getUser: (token: string) => Promise<unknown> } };
  mock.method(admin.auth, 'getUser', async (token: string) => {
    const id = TOKENS[token];
    return id ? { data: { user: { id } }, error: null } : { data: { user: null }, error: { message: 'invalid' } };
  });
}

/** The miner's client: every RPC through the fake edge; the tenant listing of readMisses on PGlite as service_role. */
function minerDb(): MinerDb {
  const service = supabaseModule.getSupabaseAdmin() as unknown as MinerDb;
  return {
    rpc: (fn, args) => service.rpc(fn, args),
    from(table: string) {
      assert.equal(table, 'rag_term_misses');
      const state: { since?: string; after?: string; limit?: number } = {};
      const builder = {
        select: () => builder,
        gte(_column: string, value: string) {
          state.since = value;
          return builder;
        },
        gt(_column: string, value: string) {
          state.after = value;
          return builder;
        },
        order: () => builder,
        limit(count: number) {
          state.limit = count;
          return builder;
        },
        abortSignal: () => builder,
        then(onFulfilled: (value: { data: unknown; error: null }) => unknown, onRejected?: (reason: unknown) => unknown) {
          const run = db.transaction(async (tx) => {
            await tx.query('SET LOCAL ROLE service_role');
            const result = await tx.query<Row>(
              `SELECT DISTINCT tenant_key FROM public.rag_term_misses
                WHERE created_at >= $1::timestamptz AND ($2::text IS NULL OR tenant_key > $2::text)
                ORDER BY tenant_key LIMIT $3`,
              [state.since ?? '1970-01-01T00:00:00Z', state.after ?? null, state.limit ?? 1000],
            );
            return { data: result.rows, error: null };
          });
          return run.then(onFulfilled, onRejected);
        },
      };
      return builder;
    },
  };
}

async function seedActors(): Promise<void> {
  await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4) ON CONFLICT DO NOTHING', [
    ADMIN_A,
    'admin-a@example.invalid',
    ADMIN_B,
    'admin-b@example.invalid',
  ]);
  await db.query('INSERT INTO admin_users (id) VALUES ($1), ($2) ON CONFLICT DO NOTHING', [ADMIN_A, ADMIN_B]);
  await db.query('INSERT INTO organizations (id, name, slug, owner_id, is_personal) VALUES ($1, $2, $3, $4, false), ($5, $6, $7, $8, false)', [
    ORG_A,
    'Tenant A org',
    'tenant-a-org',
    ADMIN_A,
    ORG_B,
    'Tenant B',
    'tenant-b',
    ADMIN_B,
  ]);
  await db.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'owner'), ($3, $4, 'owner') ON CONFLICT DO NOTHING", [
    ORG_A,
    ADMIN_A,
    ORG_B,
    ADMIN_B,
  ]);
}

async function seedChunk(tenant: string, owner: string, organizationId: string | null, text: string): Promise<void> {
  const docId = crypto.randomUUID();
  await db.query("INSERT INTO documents (id, filename, content, user_id, organization_id, is_current, status) VALUES ($1, 'synthetic.md', $2, $3, $4, true, 'ready')", [
    docId,
    text,
    owner,
    organizationId,
  ]);
  await db.query("INSERT INTO document_chunks (id, document_id, content, lexical_text, tenant_key, is_current, status) VALUES ($1, $2, $3, $4, $5, true, 'ready')", [
    crypto.randomUUID(),
    docId,
    text,
    lexicalTokens(text).join(' '),
    tenant,
  ]);
}

function corpusChunks(): string[] {
  const chunks: string[] = [];
  for (const dir of fs.readdirSync(CORPUS_DIR).sort()) {
    for (const file of fs.readdirSync(path.join(CORPUS_DIR, dir)).sort()) {
      const text = fs.readFileSync(path.join(CORPUS_DIR, dir, file), 'utf8').replace(/<!--\s*fixture-meta[\s\S]*?-->/g, '');
      chunks.push(...text.split('<!-- chunk -->').map((part) => part.trim()).filter(Boolean));
    }
  }
  return chunks;
}

async function recordMiss(tenant: string, query: string, language: string): Promise<void> {
  const service = supabaseModule.getSupabaseAdmin();
  const { error } = await service.rpc('rag_term_record_miss', {
    p_tenant_key: tenant,
    p_row: { query_masked: query, language, status: 'empty', reason: 'no_candidates', retrieval_config_hash: 'a'.repeat(64), profile: 'chat' },
  });
  assert.equal(error, null);
}

async function candidates(tenant: string): Promise<Row[]> {
  return (
    await db.query<Row>('SELECT id, term, language, support, corpus_df, status, entry_id, decided_by FROM public.rag_term_candidates WHERE tenant_key = $1 ORDER BY term', [tenant])
  ).rows;
}

interface Answer {
  status: number;
  body: Row;
}

async function answer(response: Response): Promise<Answer> {
  return { status: response.status, body: (await response.json()) as Row };
}

function request(url: string, token: string, init: { method?: string; body?: unknown } = {}): Request {
  return new Request(url, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

const BASE = 'http://localhost/api/rag/admin/terminology';
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const listAs = async (token: string, query = '') => answer(await listRoute.GET(request(`${BASE}/candidates${query}`, token)));
const decideAs = async (token: string, id: string, body: Row) =>
  answer(await decideRoute.PATCH(request(`${BASE}/candidates/${id}`, token, { method: 'PATCH', body }), params(id)));

async function workspaceVersion(tenant: string): Promise<number> {
  const rows = (await db.query<{ version: number }>('SELECT version::int AS version FROM public.rag_term_layers WHERE layer_key = $1', [tenant])).rows;
  return rows[0]?.version ?? 0;
}

async function createEntry(token: string, tenant: string, organizationId: string | null, canonical: string, variant: string): Promise<string> {
  const created = await answer(
    await entriesRoute.POST(
      request(BASE, token, {
        method: 'POST',
        body: {
          layer: 'workspace',
          ...(organizationId ? { organization_id: organizationId } : {}),
          expected_version: await workspaceVersion(tenant),
          canonical,
          variants: [variant],
          language: LATIN,
          kind: 'synonym',
        },
      }),
    ),
  );
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.entry_id as string;
}

describe('terminology mining: two tenants (D-26)', () => {
  before(async () => {
    resetLanguageSettingsForTests();
    invalidateTerminologyCache('all');
    fakeTokens();
    await seedActors();
    for (const chunk of corpusChunks()) {
      await seedChunk(TENANT_A, ADMIN_A, null, chunk);
      await seedChunk(TENANT_B, ADMIN_B, ORG_B, chunk);
    }
    for (const text of ['termdelta is described here', 'termdelta appears again', 'termdelta in a third document', '术语丁戊是第一个说明', '术语丁戊再次出现', '术语丁戊第三次出现']) {
      await seedChunk(TENANT_B, ADMIN_B, ORG_B, text);
    }
    for (const query of LATIN_QUERIES) await recordMiss(TENANT_A, query, LATIN);
    for (const query of HAN_QUERIES) await recordMiss(TENANT_A, query, HAN);
  });

  after(async () => {
    mock.restoreAll();
    await edge.close();
    await db.close();
  });

  test("misses in u:A only give candidates in u:A only, with df ignoring o:B's chunks", async () => {
    const report = await mineCandidates({ db: minerDb(), resolveScope });
    assert.deepEqual(
      report.tenants.map((tenant) => tenant.tenantKey),
      [TENANT_A],
    );
    const rowsA = await candidates(TENANT_A);
    assert.equal(report.tenants[0]!.upserted, rowsA.length, 'the upsert count comes back from the scalar RPC');
    assert.equal(report.purged, 0);
    const latin = rowsA.find((row) => row.term === LATIN_TERM);
    const han = rowsA.find((row) => row.term === HAN_TERM);
    assert.ok(latin, 'Latin placeholder candidate');
    assert.ok(han, 'Han placeholder candidate');
    assert.deepEqual({ support: latin.support, corpus_df: latin.corpus_df, status: latin.status, language: latin.language }, { support: 3, corpus_df: 0, status: 'pending', language: LATIN });
    assert.deepEqual({ support: han.support, corpus_df: han.corpus_df, status: han.status, language: han.language }, { support: 3, corpus_df: 0, status: 'pending', language: HAN });
    assert.deepEqual(await candidates(TENANT_B), []);
    const entries = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.rag_term_entries');
    assert.equal(entries.rows[0]!.n, 0, 'the miner never writes entries');
  });

  test('o:B with the same misses sees its own corpus: the terms in three of its documents are no candidates', async () => {
    for (const query of LATIN_QUERIES) await recordMiss(TENANT_B, query, LATIN);
    for (const query of HAN_QUERIES) await recordMiss(TENANT_B, query, HAN);
    await mineCandidates({ db: minerDb(), resolveScope, tenantKey: TENANT_B });
    const termsB = (await candidates(TENANT_B)).map((row) => row.term);
    assert.ok(!termsB.includes(LATIN_TERM));
    assert.ok(!termsB.includes(HAN_TERM));
    assert.ok((await candidates(TENANT_A)).some((row) => row.term === LATIN_TERM), "A's candidates are untouched");
  });

  test("admin B cannot list or decide A's candidates", async () => {
    const own = await listAs('token-b', `?organization_id=${ORG_B}`);
    assert.equal(own.status, 200);
    assert.ok(!(own.body.items as Row[]).some((item) => item.term === LATIN_TERM || item.term === HAN_TERM));
    const personal = await listAs('token-b');
    assert.equal(personal.status, 200);
    assert.deepEqual(personal.body.items, []);
    assert.equal((await listAs('token-b', `?organization_id=${ORG_A}`)).status, 403);
    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.query('SET LOCAL ROLE service_role');
        await tx.query('SELECT * FROM public.rag_term_list_candidates($1::uuid, $2, 50, 0)', [ADMIN_B, TENANT_A]);
      }),
      /not_admin_of_layer/,
    );
    const target = (await candidates(TENANT_A)).find((row) => row.term === LATIN_TERM)!;
    const crossed = await decideAs('token-b', target.id as string, { action: 'dismiss' });
    assert.equal(crossed.status, 404);
    assert.equal((await candidates(TENANT_A)).find((row) => row.term === LATIN_TERM)!.status, 'pending');
  });

  test("admin A lists, accepts with an own entry (not B's) and dismisses; each decision is audited; re-mining keeps the decisions", async () => {
    const listed = await listAs('token-a');
    assert.equal(listed.status, 200);
    const items = listed.body.items as Row[];
    assert.deepEqual(
      items.map((item) => item.term).sort(),
      [HAN_TERM, LATIN_TERM].sort(),
    );
    const latin = items.find((item) => item.term === LATIN_TERM)!;
    const han = items.find((item) => item.term === HAN_TERM)!;
    assert.ok((latin.examples as string[]).length >= 1 && (latin.examples as string[]).length <= 3);

    const entryB = await createEntry('token-b', TENANT_B, ORG_B, 'term canon b', 'termdelta b');
    assert.equal((await decideAs('token-a', latin.id as string, { action: 'accept', entry_id: entryB })).status, 404);

    const entryA = await createEntry('token-a', TENANT_A, null, 'term canon a', LATIN_TERM);
    const accepted = await decideAs('token-a', latin.id as string, { action: 'accept', entry_id: entryA });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.deepEqual(accepted.body, { success: true, candidate_id: latin.id, status: 'accepted', entry_id: entryA });
    const dismissed = await decideAs('token-a', han.id as string, { action: 'dismiss' });
    assert.equal(dismissed.status, 200);
    assert.equal((await decideAs('token-a', han.id as string, { action: 'dismiss' })).status, 409);

    const audit = await db.query<Row>(
      "SELECT layer_key, action, actor::text AS actor FROM public.rag_term_audit WHERE action IN ('candidate_accept', 'candidate_dismiss') ORDER BY action",
    );
    assert.deepEqual(audit.rows, [
      { layer_key: TENANT_A, action: 'candidate_accept', actor: ADMIN_A },
      { layer_key: TENANT_A, action: 'candidate_dismiss', actor: ADMIN_A },
    ]);
    const rowsA = await candidates(TENANT_A);
    assert.equal(rowsA.find((row) => row.term === LATIN_TERM)!.decided_by, ADMIN_A);

    await recordMiss(TENANT_A, '术语丁戊还有别的说明吗', HAN);
    invalidateTerminologyCache('all');
    await mineCandidates({ db: minerDb(), resolveScope, tenantKey: TENANT_A });
    const after = await candidates(TENANT_A);
    assert.deepEqual(
      { status: after.find((row) => row.term === HAN_TERM)!.status, support: after.find((row) => row.term === HAN_TERM)!.support },
      { status: 'dismissed', support: 4 },
    );
    const latinAfter = after.find((row) => row.term === LATIN_TERM)!;
    assert.deepEqual({ status: latinAfter.status, entry_id: latinAfter.entry_id }, { status: 'accepted', entry_id: entryA });
    assert.deepEqual(((await listAs('token-a')).body.items as Row[]).filter((item) => item.term === LATIN_TERM || item.term === HAN_TERM), []);
  });
});
