import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCorpus } from '../eval/harness/corpus.mts';
import { embedText } from '../eval/harness/fixture-embedder.mts';
import { FIXTURE_USER_ID } from '../eval/harness/pglite-supabase.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../eval/harness/two-tenant.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL_CORPUS = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const QUERY = 'two tenant isolation canary phrase';

describe('two-tenant multi-tenant fixture', () => {
  let fixture: TwoTenantDatabase;

  before(async () => {
    fixture = await createTwoTenantDatabase();
  });
  after(async () => {
    await fixture?.db.close();
  });

  const workspaceChunks = async (orgId: string | null, userId: string | null): Promise<string[]> => {
    const result = await fixture.db.query<{ id: string }>(
      'SELECT id FROM match_documents_by_workspace(p_query_embedding => $1, p_match_count => $2, p_min_similarity => $3, p_org_id => $4, p_user_id => $5) ORDER BY id',
      [`[${embedText(QUERY).join(',')}]`, 100, -1, orgId, userId],
    );
    return result.rows.map((row) => row.id);
  };

  test('ids are fixed zero-padded UUIDs and the three users and org exist', async () => {
    const ids = Object.values(TWO_TENANT_IDS);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) assert.match(id, /^00000000-0000-4000-8000-[0-9a-f]{12}$/);
    const users = await fixture.db.query<{ id: string; email: string }>('SELECT id, email FROM auth.users WHERE id = ANY($1::uuid[]) ORDER BY id', [
      [TWO_TENANT_IDS.userA, TWO_TENANT_IDS.userB],
    ]);
    assert.equal(users.rows.length, 2);
    assert.ok(users.rows.every((row) => row.email.endsWith('@example.invalid')));
  });

  test('organization O has A as member and B is not a member', async () => {
    const members = await fixture.db.query<{ user_id: string; role: string }>('SELECT user_id, role FROM organization_members WHERE organization_id = $1', [
      TWO_TENANT_IDS.orgO,
    ]);
    assert.deepEqual(members.rows, [{ user_id: TWO_TENANT_IDS.userA, role: 'member' }]);
  });

  test('the query matches all three tenant chunks before any tenant filter', async () => {
    const result = await fixture.db.query<{ id: string }>(
      'SELECT dc.id FROM document_chunks dc WHERE dc.id = ANY($1::uuid[]) AND 1 - (dc.embedding <=> $2::vector) > 0.1',
      [[TWO_TENANT_IDS.chunkA, TWO_TENANT_IDS.chunkB, TWO_TENANT_IDS.chunkO], `[${embedText(QUERY).join(',')}]`],
    );
    assert.equal(result.rows.length, 3);
  });

  test('(null, A) returns only A personal chunks', async () => {
    assert.deepEqual(await workspaceChunks(null, TWO_TENANT_IDS.userA), [TWO_TENANT_IDS.chunkA]);
  });

  test('(O, A) returns only organization O chunks', async () => {
    assert.deepEqual(await workspaceChunks(TWO_TENANT_IDS.orgO, TWO_TENANT_IDS.userA), [TWO_TENANT_IDS.chunkO]);
  });

  test('(null, B) returns only B personal chunks', async () => {
    assert.deepEqual(await workspaceChunks(null, TWO_TENANT_IDS.userB), [TWO_TENANT_IDS.chunkB]);
  });

  test('(null, null) returns nothing', async () => {
    assert.deepEqual(await workspaceChunks(null, null), []);
  });

  test('the default corpus is untouched and stays owned by the fixture user', async () => {
    assert.equal(fixture.corpusSha256, loadCorpus(REAL_CORPUS).corpusSha256);
    const fixtureRows = await workspaceChunks(null, FIXTURE_USER_ID);
    const tenantChunks = new Set<string>([TWO_TENANT_IDS.chunkA, TWO_TENANT_IDS.chunkB, TWO_TENANT_IDS.chunkO]);
    assert.ok(fixtureRows.length > 0);
    assert.ok(fixtureRows.every((id) => !tenantChunks.has(id)));
  });
});
