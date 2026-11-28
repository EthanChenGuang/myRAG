import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 03.3 verification G5 (hand-off 03.3-24-tenant-delete): deleting an organization removes that tenant's Phase 3.3 rule and attribute
 * data (rag_tenant_rule_data_delete through deleteTenantRuleData) before the organization row goes. A failed rule-data delete answers 503
 * and keeps the organization, so the owner can retry; a caller who is not the owner reaches neither delete.
 */
const OWNER = '00000000-0000-4000-8000-000000330501';
const OTHER = '00000000-0000-4000-8000-000000330502';
const ORG = '00000000-0000-4000-8000-000000330511';

let identity: { id: string } | null;
let events: string[];
let ruleDelete: ReturnType<typeof vi.fn>;

function makeClient(kind: 'user' | 'service') {
  return {
    auth: { getUser: async () => ({ data: { user: identity }, error: null }) },
    from(table: string) {
      let op = 'select';
      const filters: Record<string, unknown> = {};
      const run = () => {
        if (table !== 'organizations') return { data: null, error: null };
        if (op === 'delete') {
          events.push(`${kind}:organizations.delete:${String(filters.id)}`);
          return { data: null, error: null };
        }
        return filters.id === ORG ? { data: { owner_id: OWNER }, error: null } : { data: null, error: null };
      };
      const builder: Record<string, unknown> = {
        select: () => builder,
        delete: () => {
          op = 'delete';
          return builder;
        },
        eq: (column: string, value: unknown) => {
          filters[column] = value;
          return builder;
        },
        single: () => Promise.resolve(run()),
        then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(run()).then(resolve, reject),
      };
      return builder;
    },
  };
}

type Handler = (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;

async function load(): Promise<{ DELETE: Handler }> {
  vi.resetModules();
  vi.doMock('@/lib/deployment-mode', () => ({ requireMultiTenant: () => undefined }));
  vi.doMock('@/lib/auth/organization-handler', () => ({ isPersonalOrganization: async () => false }));
  vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => makeClient('user') }));
  vi.doMock('@/lib/supabase', () => ({ getSupabaseAdmin: () => makeClient('service') }));
  vi.doMock('@/lib/rag', () => ({ deleteTenantRuleData: ruleDelete }));
  return (await import('@/app/api/organizations/[id]/route')) as unknown as { DELETE: Handler };
}

const params = { params: Promise.resolve({ id: ORG }) };
const del = () => new Request('http://localhost/api/organizations/x', { method: 'DELETE' });

beforeEach(() => {
  identity = null;
  events = [];
  ruleDelete = vi.fn(async (tenantKey: string) => {
    events.push(`rule-data:${tenantKey}`);
    return { ok: true, deleted: {} };
  });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const name of ['@/lib/deployment-mode', '@/lib/auth/organization-handler', '@/lib/supabase/server', '@/lib/supabase', '@/lib/rag']) {
    vi.doUnmock(name);
  }
});

describe('DELETE /api/organizations/[id] tenant rule data', () => {
  it('deletes the tenant rule data for o:<id> before the organization row', async () => {
    identity = { id: OWNER };
    const { DELETE } = await load();
    const response = await DELETE(del(), params);

    expect(response.status).toBe(200);
    expect(ruleDelete).toHaveBeenCalledTimes(1);
    expect(ruleDelete.mock.calls[0][0]).toBe(`o:${ORG}`);
    expect(events).toEqual([`rule-data:o:${ORG}`, `service:organizations.delete:${ORG}`]);
  });

  it('a failed rule-data delete answers 503 and keeps the organization', async () => {
    identity = { id: OWNER };
    ruleDelete.mockImplementation(async () => ({ ok: false, reason: 'unavailable' }));
    const { DELETE } = await load();
    const response = await DELETE(del(), params);

    expect(response.status).toBe(503);
    expect(events).toEqual([]);
  });

  it('a caller who is not the owner reaches neither delete', async () => {
    identity = { id: OTHER };
    const { DELETE } = await load();
    const response = await DELETE(del(), params);

    expect(response.status).toBe(403);
    expect(ruleDelete).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });
});
