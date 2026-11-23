import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  mintScope,
  rowMatchesPredicate,
  scopeKey,
  tenantPredicate,
  workspaceRpcArgs,
  type TenantScope,
} from '@/lib/rag/tenant/scope';

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const USER_B = '00000000-0000-4000-8000-0000000000b1';
const ORG_O = '00000000-0000-4000-8000-0000000000c1';

describe('tenantPredicate', () => {
  test('single has no predicate and matches every row', () => {
    const predicate = tenantPredicate(mintScope('single', null, null));
    expect(predicate).toEqual({ kind: 'none' });
    expect(rowMatchesPredicate(predicate, { user_id: USER_B, organization_id: ORG_O })).toBe(true);
    expect(rowMatchesPredicate(predicate, { user_id: null, organization_id: null })).toBe(true);
  });

  test('personal needs the user and no organization', () => {
    const predicate = tenantPredicate(mintScope('personal', USER_A, null));
    expect(predicate).toEqual({ kind: 'personal', userId: USER_A });
    expect(rowMatchesPredicate(predicate, { user_id: USER_A, organization_id: null })).toBe(true);
    expect(rowMatchesPredicate(predicate, { user_id: USER_A, organization_id: ORG_O })).toBe(false);
    expect(rowMatchesPredicate(predicate, { user_id: USER_B, organization_id: null })).toBe(false);
    expect(rowMatchesPredicate(predicate, { user_id: null, organization_id: null })).toBe(false);
  });

  test('org matches the organization regardless of the user', () => {
    for (const userId of [null, USER_A, USER_B]) {
      const predicate = tenantPredicate(mintScope('org', userId, ORG_O));
      expect(predicate).toEqual({ kind: 'org', organizationId: ORG_O });
      expect(rowMatchesPredicate(predicate, { user_id: USER_B, organization_id: ORG_O })).toBe(true);
      expect(rowMatchesPredicate(predicate, { user_id: USER_A, organization_id: null })).toBe(false);
    }
  });
});

describe('workspaceRpcArgs', () => {
  test('personal sends a null organization and the user', () => {
    expect(workspaceRpcArgs(mintScope('personal', USER_A, null))).toEqual({ p_org_id: null, p_user_id: USER_A });
  });

  test('org sends the organization and the user the caller supplied', () => {
    expect(workspaceRpcArgs(mintScope('org', USER_A, ORG_O))).toEqual({ p_org_id: ORG_O, p_user_id: USER_A });
    expect(workspaceRpcArgs(mintScope('org', null, ORG_O))).toEqual({ p_org_id: ORG_O, p_user_id: null });
  });

  test('single has no workspace arguments', () => {
    expect(() => workspaceRpcArgs(mintScope('single', null, null))).toThrow();
  });

  test('a forged scope is refused by every accessor', () => {
    const forged = { kind: 'org', userId: null, organizationId: ORG_O } as unknown as TenantScope;
    expect(() => workspaceRpcArgs(forged)).toThrow('[RAG Tenant] unminted scope');
    expect(() => tenantPredicate(forged)).toThrow('[RAG Tenant] unminted scope');
    expect(() => scopeKey(forged)).toThrow('[RAG Tenant] unminted scope');
  });
});

describe('predicate equals match_documents_by_workspace on the two-tenant fixture', () => {
  type Db = Awaited<ReturnType<(typeof import('../../eval/harness/two-tenant.mts'))['createTwoTenantDatabase']>>;
  let fixture: Db;
  let embedLiteral: string;

  beforeAll(async () => {
    const { createTwoTenantDatabase } = await import('../../eval/harness/two-tenant.mts');
    const { embedText } = await import('../../eval/harness/fixture-embedder.mts');
    fixture = await createTwoTenantDatabase();
    embedLiteral = `[${embedText('two tenant isolation canary phrase').join(',')}]`;
  });

  afterAll(async () => {
    await fixture?.db.close();
  });

  test('each scope returns exactly the chunks its predicate selects', async () => {
    const owners = await fixture.db.query<{ id: string; user_id: string | null; organization_id: string | null }>(
      'SELECT dc.id, d.user_id, d.organization_id FROM document_chunks dc INNER JOIN documents d ON d.id = dc.document_id WHERE dc.embedding IS NOT NULL',
    );
    const scopes = [mintScope('personal', USER_A, null), mintScope('personal', USER_B, null), mintScope('org', USER_A, ORG_O), mintScope('org', null, ORG_O)];
    for (const scope of scopes) {
      const args = workspaceRpcArgs(scope);
      const predicate = tenantPredicate(scope);
      const rpc = await fixture.db.query<{ id: string }>(
        'SELECT id FROM match_documents_by_workspace(p_query_embedding => $1, p_match_count => $2, p_min_similarity => $3, p_org_id => $4, p_user_id => $5)',
        [embedLiteral, 100000, -1, args.p_org_id, args.p_user_id],
      );
      const expected = owners.rows.filter((row) => rowMatchesPredicate(predicate, row)).map((row) => row.id).sort();
      expect(rpc.rows.map((row) => row.id).sort(), scopeKey(scope)).toEqual(expected);
    }
  });
});
