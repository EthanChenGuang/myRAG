import { after, before, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';

/**
 * D-02, D-03, D-33: the admin routes on a multi-tenant fixture database, called in process through the fake edge. Only the token check is
 * faked (auth.getUser on the service client); admin_users, organization membership, the 0472 writers and rag_term_effective are real SQL.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// D-35: the languages come from the registry; D-37: placeholder terms only.
const REGISTRY = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'config/rag/language-packs.json'), 'utf8')) as {
  packs: { code: string; script: string }[];
};
const HAN = REGISTRY.packs.find((pack) => pack.script === 'Hani')!.code;
const LATIN = REGISTRY.packs.find((pack) => pack.script === 'Latn')!.code;

const ADMIN_A = '00000000-0000-4000-8000-00000000a001';
const ADMIN_B = '00000000-0000-4000-8000-00000000b002';
const ORG_X = '00000000-0000-4000-8000-0000000000e1';
const TOKENS: Record<string, string> = { 'token-a': ADMIN_A, 'token-b': ADMIN_B };

const multiDb: PGlite = (await createEmptyFixtureDatabase({ deploymentMode: 'multi-tenant' })).db;
const edge: FakeEdge = await startFakeEdge({ db: multiDb });
Object.assign(process.env, fixtureProcessEnv(edge.url));
// D-36: the supported languages are set explicitly for this test, never taken from a shipped default.
process.env.RAG_SUPPORTED_LANGUAGES = [HAN, LATIN].join(',');
process.env.RAG_PRIMARY_LANGUAGE = LATIN;
process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
process.env.MYRAG_DEPLOYMENT_MODE = 'multi-tenant';

const envModule = await import('@/lib/env');
const supabaseModule = await import('@/lib/supabase');
const listRoute = await import('@/app/api/rag/admin/terminology/route');
const entryRoute = await import('@/app/api/rag/admin/terminology/[id]/route');
const suppressionsRoute = await import('@/app/api/rag/admin/terminology/suppressions/route');
const versionsRoute = await import('@/app/api/rag/admin/terminology/versions/route');
const auditRoute = await import('@/app/api/rag/admin/terminology/audit/route');
const { getTerminologyLexicon, resetTerminologyLexiconForTests } = await import('@/lib/rag/terminology/lexicon');
const { invalidateTerminologyCache, loadEffectiveDictionary } = await import('@/lib/rag/terminology/load');
const { resetLanguageSettingsForTests } = await import('@/lib/rag/lang/settings');
const { normalizeLexical } = await import('@/lib/rag/lexical/tokenize');
const { mintScope, scopeKey } = await import('@/lib/rag/tenant/scope');

const scopeA = mintScope('personal', ADMIN_A, null);
const scopeB = mintScope('personal', ADMIN_B, null);
const scopeX = mintScope('org', ADMIN_A, ORG_X);
const keyB = scopeKey(scopeB);

function fakeTokens(): void {
  const admin = supabaseModule.getSupabaseAdmin() as unknown as { auth: { getUser: (token: string) => Promise<unknown> } };
  mock.method(admin.auth, 'getUser', async (token: string) => {
    const id = TOKENS[token];
    return id ? { data: { user: { id } }, error: null } : { data: { user: null }, error: { message: 'invalid' } };
  });
}

async function seedActors(db: PGlite, multiTenant: boolean): Promise<void> {
  await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4) ON CONFLICT DO NOTHING', [
    ADMIN_A,
    'admin-a@example.invalid',
    ADMIN_B,
    'admin-b@example.invalid',
  ]);
  await db.query('INSERT INTO admin_users (id) VALUES ($1), ($2) ON CONFLICT DO NOTHING', [ADMIN_A, ADMIN_B]);
  if (multiTenant) {
    await db.query('INSERT INTO organizations (id, name, slug, owner_id, is_personal) VALUES ($1, $2, $3, $4, false)', [ORG_X, 'Tenant X', 'tenant-x', ADMIN_A]);
    await db.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING", [ORG_X, ADMIN_A]);
  }
}

interface Answer {
  status: number;
  body: Record<string, unknown>;
}

const BASE = 'http://localhost/api/rag/admin/terminology';

async function answer(response: Response): Promise<Answer> {
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function request(url: string, token: string, init: { method?: string; body?: unknown } = {}): Request {
  return new Request(url, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const orgQuery = (organizationId: string | null) => (organizationId ? `&organization_id=${organizationId}` : '');

async function versions(token: string, organizationId: string | null = null): Promise<Answer> {
  return answer(await versionsRoute.GET(request(`${BASE}/versions?${orgQuery(organizationId).slice(1)}`, token)));
}

async function sharedVersion(token: string): Promise<number> {
  return ((await versions(token)).body.shared as { version: number }).version;
}

async function workspaceVersion(token: string, organizationId: string | null = null): Promise<number> {
  return ((await versions(token, organizationId)).body.workspace as { version: number }).version;
}

async function create(token: string, body: Record<string, unknown>): Promise<Answer> {
  return answer(await listRoute.POST(request(BASE, token, { method: 'POST', body })));
}

function synonym(canonical: string, variant: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { canonical, variants: [variant], language: LATIN, kind: 'synonym', ...extra };
}

function resetCaches(): void {
  invalidateTerminologyCache('all');
  resetTerminologyLexiconForTests();
  resetLanguageSettingsForTests();
}

describe('terminology admin routes on a multi-tenant fixture database (D-02, D-03, D-33)', () => {
  let entryOfA = '';
  let sharedEntry = '';

  before(async () => {
    await seedActors(multiDb, true);
    fakeTokens();
    resetCaches();
  });

  test('A creates a workspace entry in o:X; B cannot list, read the audit or versions, update, delete or suppress there (403)', async () => {
    const created = await create('token-a', { layer: 'workspace', organization_id: ORG_X, expected_version: 0, ...synonym('termine alfa beta', 'voce alfa') });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    entryOfA = created.body.entry_id as string;
    assert.equal(created.body.layer_version, 1);

    const listedByA = await answer(await listRoute.GET(request(`${BASE}?layer=workspace${orgQuery(ORG_X)}`, 'token-a')));
    assert.equal(listedByA.status, 200);
    assert.deepEqual((listedByA.body.items as Array<{ id: string }>).map((item) => item.id), [entryOfA]);
    assert.deepEqual(listedByA.body.enabled_languages, [HAN, LATIN]);

    const refused = [
      await listRoute.GET(request(`${BASE}?layer=workspace${orgQuery(ORG_X)}`, 'token-b')),
      await auditRoute.GET(request(`${BASE}/audit?layer=workspace${orgQuery(ORG_X)}`, 'token-b')),
      await versionsRoute.GET(request(`${BASE}/versions?organization_id=${ORG_X}`, 'token-b')),
      await entryRoute.PATCH(
        request(`${BASE}/${entryOfA}`, 'token-b', { method: 'PATCH', body: { layer: 'workspace', organization_id: ORG_X, expected_version: 1, enabled: false } }),
        params(entryOfA),
      ),
      await entryRoute.DELETE(request(`${BASE}/${entryOfA}?layer=workspace&organization_id=${ORG_X}&expected_version=1`, 'token-b', { method: 'DELETE' }), params(entryOfA)),
      await suppressionsRoute.POST(
        request(`${BASE}/suppressions`, 'token-b', { method: 'POST', body: { organization_id: ORG_X, shared_entry_id: entryOfA, suppressed: true, expected_version: 1 } }),
      ),
    ];
    for (const response of refused) assert.equal(response.status, 403);

    const rows = await multiDb.query<{ n: number }>("SELECT count(*)::int AS n FROM public.rag_term_entries WHERE layer_key = 'o:' || $1", [ORG_X]);
    assert.equal(rows.rows[0]!.n, 1);
  });

  test("B naming A's entry id in its own workspace gets 404, and A's entry is unchanged", async () => {
    const patched = await answer(
      await entryRoute.PATCH(request(`${BASE}/${entryOfA}`, 'token-b', { method: 'PATCH', body: { layer: 'workspace', expected_version: 0, enabled: false } }), params(entryOfA)),
    );
    assert.equal(patched.status, 404);
    const deleted = await entryRoute.DELETE(request(`${BASE}/${entryOfA}?layer=workspace&expected_version=0`, 'token-b', { method: 'DELETE' }), params(entryOfA));
    assert.equal(deleted.status, 404);
    const row = await multiDb.query<{ enabled: boolean }>('SELECT enabled FROM public.rag_term_entries WHERE id = $1', [entryOfA]);
    assert.equal(row.rows[0]!.enabled, true);
  });

  test("A's shared write is in B's effective dictionary at once (the writing instance invalidates every tenant)", async () => {
    const before = await getTerminologyLexicon(scopeB);
    assert.ok(!before.terms.some((term) => term.normalized === normalizeLexical('termalpha')));

    const created = await create('token-a', { layer: 'shared', expected_version: await sharedVersion('token-a'), ...synonym('term alpha beta', 'termalpha') });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    sharedEntry = created.body.entry_id as string;

    const dictionary = await loadEffectiveDictionary(scopeB);
    assert.equal(dictionary.tenantKey, keyB);
    assert.ok(dictionary.entries.some((entry) => entry.entryId === sharedEntry && entry.layer === 'shared'));
    assert.ok(!dictionary.entries.some((entry) => entry.entryId === entryOfA));

    const after = await getTerminologyLexicon(scopeB);
    assert.ok(after.terms.some((term) => term.normalized === normalizeLexical('termalpha')));
    assert.ok(!after.terms.some((term) => term.normalized === normalizeLexical('voce alfa')));
  });

  test("A's shared translation pair is in B's lexicon with includeTranslations, and not without it (D-32, D-33)", async () => {
    const created = await create('token-a', {
      layer: 'shared',
      expected_version: await sharedVersion('token-a'),
      canonical: 'term gamma delta',
      variants: ['术语甲乙丙'],
      language: HAN,
      kind: 'translation',
      source_language: HAN,
      target_language: LATIN,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const withPairs = await getTerminologyLexicon(scopeB, { includeTranslations: true });
    const pair = withPairs.translations.find((item) => item.entry_id === created.body.entry_id);
    assert.ok(pair, 'B sees the shared pair');
    assert.deepEqual(
      { source_language: pair.source_language, target_language: pair.target_language, sources: pair.sources, target: pair.target },
      { source_language: HAN, target_language: LATIN, sources: ['术语甲乙丙'], target: 'term gamma delta' },
    );
    const withoutPairs = await getTerminologyLexicon(scopeB);
    assert.deepEqual(withoutPairs.translations, []);
    assert.ok(!withoutPairs.terms.some((term) => term.kind === 'translation'));
  });

  test("A suppresses a shared entry in o:X; o:X loses it and B's effective dictionary still has it", async () => {
    const suppressed = await answer(
      await suppressionsRoute.POST(
        request(`${BASE}/suppressions`, 'token-a', {
          method: 'POST',
          body: { organization_id: ORG_X, shared_entry_id: sharedEntry, suppressed: true, expected_version: await workspaceVersion('token-a', ORG_X) },
        }),
      ),
    );
    assert.equal(suppressed.status, 200, JSON.stringify(suppressed.body));
    assert.equal(suppressed.body.suppressed, true);

    const ofX = await loadEffectiveDictionary(scopeX);
    assert.ok(!ofX.entries.some((entry) => entry.entryId === sharedEntry));
    assert.ok(ofX.entries.some((entry) => entry.entryId === entryOfA));
    const ofB = await loadEffectiveDictionary(scopeB);
    assert.ok(ofB.entries.some((entry) => entry.entryId === sharedEntry));
    const ofA = await loadEffectiveDictionary(scopeA);
    assert.ok(ofA.entries.some((entry) => entry.entryId === sharedEntry));

    const audit = await answer(await auditRoute.GET(request(`${BASE}/audit?layer=workspace&organization_id=${ORG_X}`, 'token-a')));
    assert.equal(audit.status, 200);
    assert.deepEqual((audit.body.items as Array<{ action: string }>).map((item) => item.action), ['suppress', 'create']);
  });

  test('a stale expected_version is 409 with the current version, and a conflict is 422 with the issues', async () => {
    const current = await sharedVersion('token-a');
    const stale = await create('token-a', { layer: 'shared', expected_version: current - 1, ...synonym('term gamma delta', 'termgamma') });
    assert.equal(stale.status, 409);
    assert.deepEqual(stale.body, { success: false, error: 'version_conflict', current_version: current });

    const conflict = await create('token-a', { layer: 'shared', expected_version: current, ...synonym('term gamma delta', 'termalpha') });
    assert.equal(conflict.status, 422);
    assert.ok((conflict.body.issues as Array<{ code: string }>).some((issue) => issue.code === 'conflict'));
    assert.equal(await sharedVersion('token-a'), current);
  });

  test('B updates the shared entry with PATCH; the audit names B as the actor, never a body value', async () => {
    const version = await sharedVersion('token-b');
    const patched = await answer(
      await entryRoute.PATCH(
        request(`${BASE}/${sharedEntry}`, 'token-b', { method: 'PATCH', body: { layer: 'shared', expected_version: version, variants: ['termalpha', 'alpha beta'] } }),
        params(sharedEntry),
      ),
    );
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    const audit = await multiDb.query<{ actor: string; action: string }>(
      "SELECT actor::text, action FROM public.rag_term_audit WHERE layer_key = 'shared' AND entry_id = $1 ORDER BY layer_version DESC LIMIT 1",
      [sharedEntry],
    );
    assert.deepEqual(audit.rows[0], { actor: ADMIN_B, action: 'update' });
  });
});

describe('terminology admin routes on a single-tenant fixture database (D-03)', () => {
  let singleDb: PGlite;

  before(async () => {
    singleDb = (await createEmptyFixtureDatabase({ deploymentMode: 'single-tenant' })).db;
    await seedActors(singleDb, false);
    edge.useDatabase(singleDb);
    const env = envModule.env as Record<string, unknown>;
    env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'single-tenant';
    env.MYRAG_DEPLOYMENT_MODE = 'single-tenant';
    resetCaches();
  });

  after(async () => {
    await singleDb?.close();
  });

  test('the shared layer works', async () => {
    const created = await create('token-a', { layer: 'shared', expected_version: 0, ...synonym('term alpha beta', 'termalpha') });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const dictionary = await loadEffectiveDictionary(mintScope('single', null, null));
    assert.ok(dictionary.entries.some((entry) => entry.entryId === created.body.entry_id));
    const listed = await answer(await listRoute.GET(request(`${BASE}?layer=shared`, 'token-b')));
    assert.equal(listed.status, 200);
    assert.equal(listed.body.total, 1);
  });

  test('the workspace layer is refused with 400 workspace_layer_unavailable, and versions have no workspace', async () => {
    const created = await create('token-a', { layer: 'workspace', expected_version: 0, ...synonym('term gamma delta', 'termgamma') });
    assert.equal(created.status, 400);
    assert.equal(created.body.error, 'workspace_layer_unavailable');
    const suppressed = await suppressionsRoute.POST(
      request(`${BASE}/suppressions`, 'token-a', { method: 'POST', body: { shared_entry_id: ADMIN_A, suppressed: true, expected_version: 0 } }),
    );
    assert.equal(suppressed.status, 400);
    const state = await versions('token-a');
    assert.equal(state.status, 200);
    assert.equal(state.body.workspace, null);
    assert.equal((state.body.shared as { version: number }).version, 1);
    const rows = await singleDb.query<{ n: number }>("SELECT count(*)::int AS n FROM public.rag_term_entries WHERE layer_key <> 'shared'");
    assert.equal(rows.rows[0]!.n, 0);
  });
});

after(async () => {
  mock.restoreAll();
  await edge?.close();
  await multiDb?.close();
});
