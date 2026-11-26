import { after, before, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';

/**
 * T-0411-34, D-22: the preview and import routes on a multi-tenant fixture database, called in process through the fake edge. Only the
 * token check is faked; admin_users, organization membership, rag_term_effective and the 0472 writers are real SQL.
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
const ORG_A = '00000000-0000-4000-8000-0000000000e1';
const ORG_B = '00000000-0000-4000-8000-0000000000e2';
const TOKENS: Record<string, string> = { 'token-a': ADMIN_A, 'token-b': ADMIN_B };
const HEADER = 'canonical,variants,language,kind,mode,enabled,note,source_language,target_language';

const db: PGlite = (await createEmptyFixtureDatabase({ deploymentMode: 'multi-tenant' })).db;
const edge: FakeEdge = await startFakeEdge({ db });
Object.assign(process.env, fixtureProcessEnv(edge.url));
// D-36: the supported languages are set explicitly for this test, never taken from a shipped default.
process.env.RAG_SUPPORTED_LANGUAGES = [HAN, LATIN].join(',');
process.env.RAG_PRIMARY_LANGUAGE = LATIN;
process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
process.env.MYRAG_DEPLOYMENT_MODE = 'multi-tenant';

const supabaseModule = await import('@/lib/supabase');
const listRoute = await import('@/app/api/rag/admin/terminology/route');
const versionsRoute = await import('@/app/api/rag/admin/terminology/versions/route');
const previewRoute = await import('@/app/api/rag/admin/terminology/preview/route');
const importRoute = await import('@/app/api/rag/admin/terminology/import/route');
const { invalidateTerminologyCache } = await import('@/lib/rag/terminology/load');
const { resetLanguageSettingsForTests } = await import('@/lib/rag/lang/settings');

interface Answer {
  status: number;
  body: Record<string, any>;
}

const BASE = 'http://localhost/api/rag/admin/terminology';

function request(url: string, token: string, init: { method?: string; body?: unknown } = {}): Request {
  return new Request(url, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

async function answer(response: Response): Promise<Answer> {
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

async function version(token: string, layer: 'shared' | 'workspace', organizationId: string | null = null): Promise<number> {
  const query = organizationId ? `?organization_id=${organizationId}` : '';
  const body = (await answer(await versionsRoute.GET(request(`${BASE}/versions${query}`, token)))).body;
  return (layer === 'shared' ? body.shared : body.workspace).version as number;
}

async function create(token: string, body: Record<string, unknown>): Promise<Answer> {
  return answer(await listRoute.POST(request(BASE, token, { method: 'POST', body })));
}

async function preview(token: string, body: Record<string, unknown>): Promise<Answer> {
  return answer(await previewRoute.POST(request(`${BASE}/preview`, token, { method: 'POST', body })));
}

const synonym = (canonical: string, variant: string) => ({ canonical, variants: [variant], language: LATIN, kind: 'synonym' });

describe('terminology preview and import across two tenants (T-0411-34)', () => {
  let workspaceEntryOfA = '';

  before(async () => {
    await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4) ON CONFLICT DO NOTHING', [
      ADMIN_A,
      'admin-a@example.invalid',
      ADMIN_B,
      'admin-b@example.invalid',
    ]);
    await db.query('INSERT INTO admin_users (id) VALUES ($1), ($2) ON CONFLICT DO NOTHING', [ADMIN_A, ADMIN_B]);
    await db.query('INSERT INTO organizations (id, name, slug, owner_id, is_personal) VALUES ($1, $2, $3, $4, false), ($5, $6, $7, $8, false)', [
      ORG_A,
      'Tenant A',
      'tenant-a',
      ADMIN_A,
      ORG_B,
      'Tenant B',
      'tenant-b',
      ADMIN_B,
    ]);
    await db.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'owner'), ($3, $4, 'owner')", [ORG_A, ADMIN_A, ORG_B, ADMIN_B]);
    const admin = supabaseModule.getSupabaseAdmin() as unknown as { auth: { getUser: (token: string) => Promise<unknown> } };
    mock.method(admin.auth, 'getUser', async (token: string) => {
      const id = TOKENS[token];
      return id ? { data: { user: { id } }, error: null } : { data: { user: null }, error: { message: 'invalid' } };
    });
    invalidateTerminologyCache('all');
    resetLanguageSettingsForTests();

    const shared = await create('token-a', { layer: 'shared', expected_version: 0, ...synonym('term alpha beta', 'termalpha') });
    assert.equal(shared.status, 201, JSON.stringify(shared.body));
    const own = await create('token-a', { layer: 'workspace', expected_version: 0, ...synonym('term gamma delta', 'termgamma') });
    assert.equal(own.status, 201, JSON.stringify(own.body));
    workspaceEntryOfA = own.body.entry_id as string;
    const override = await create('token-a', { layer: 'workspace', expected_version: 1, ...synonym('term alpha beta', 'alpha beta') });
    assert.equal(override.status, 201, JSON.stringify(override.body));
  });

  test("A's preview in u:A shows its own entry and its override", async () => {
    const seen = await preview('token-a', { layer: 'workspace', query: 'termgamma and alpha beta' });
    assert.equal(seen.status, 200, JSON.stringify(seen.body));
    assert.ok(seen.body.matches.some((match: { entry_id: string }) => match.entry_id === workspaceEntryOfA));
    assert.equal(seen.body.overrides.length, 1);
    assert.match(seen.body.version, /^s1\.w2$/);
  });

  test("B previewing in o:B gets no match from A's entry and no A override", async () => {
    for (const layer of ['workspace', 'shared'] as const) {
      const seen = await preview('token-b', { layer, organization_id: ORG_B, query: 'termgamma and alpha beta and termalpha' });
      assert.equal(seen.status, 200, JSON.stringify(seen.body));
      assert.ok(!seen.body.matches.some((match: { entry_id: string; canonical: string }) => match.entry_id === workspaceEntryOfA || match.canonical === 'term gamma delta'));
      assert.ok(seen.body.matches.every((match: { layer: string }) => match.layer === 'shared'));
      assert.deepEqual(seen.body.overrides, []);
      assert.equal(seen.body.version, 's1');
    }
  });

  test('B previewing the workspace layer of a tenant B does not administer is 403', async () => {
    for (const layer of ['workspace', 'shared'] as const) {
      const refused = await preview('token-b', { layer, organization_id: ORG_A, query: 'termgamma' });
      assert.equal(refused.status, 403);
    }
  });

  test("B's import dry run in o:B reports no A entries in its diff", async () => {
    const csv = [HEADER, `term gamma delta,termgamma,${LATIN},synonym,one_way,true,,,`].join('\n');
    const dry = await answer(
      await importRoute.POST(
        request(`${BASE}/import`, 'token-b', { method: 'POST', body: { layer: 'workspace', organization_id: ORG_B, mode: 'replace', csv } }),
      ),
    );
    assert.equal(dry.status, 200, JSON.stringify(dry.body));
    assert.deepEqual(dry.body.report, { applied: false, create: 1, update: 0, unchanged: 0, delete: 0, issues: [], layer_version_seen: 0 });
    assert.equal(await version('token-b', 'workspace', ORG_B), 0);
  });

  test("B importing into A's organization is 403 and writes nothing", async () => {
    const csv = [HEADER, `term eta theta,termeta,${LATIN},synonym,one_way,true,,,`].join('\n');
    const refused = await importRoute.POST(
      request(`${BASE}/import`, 'token-b', { method: 'POST', body: { layer: 'workspace', organization_id: ORG_A, csv, dry_run: false, expected_version: 0 } }),
    );
    assert.equal(refused.status, 403);
    const rows = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM public.rag_term_entries WHERE layer_key = 'o:' || $1", [ORG_A]);
    assert.equal(rows.rows[0]!.n, 0);
  });

  test("A applies an import in o:A; the preview there sees it at once and B's preview in o:B does not", async () => {
    const csv = [HEADER, `term eta theta,termeta,${LATIN},synonym,one_way,true,,,`].join('\n');
    const applied = await answer(
      await importRoute.POST(
        request(`${BASE}/import`, 'token-a', { method: 'POST', body: { layer: 'workspace', organization_id: ORG_A, csv, dry_run: false, expected_version: 0 } }),
      ),
    );
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    assert.equal(applied.body.report.applied, true);
    const ofA = await preview('token-a', { layer: 'workspace', organization_id: ORG_A, query: 'about termeta' });
    assert.ok(ofA.body.matches.some((match: { canonical: string }) => match.canonical === 'term eta theta'));
    const ofB = await preview('token-b', { layer: 'workspace', organization_id: ORG_B, query: 'about termeta' });
    assert.deepEqual(ofB.body.matches, []);
  });
});

after(async () => {
  mock.restoreAll();
  await edge?.close();
  await db?.close();
});
