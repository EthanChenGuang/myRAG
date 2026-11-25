import { beforeEach, describe, expect, test, vi } from 'vitest';
import { parseTenantKey, resetEmbedTenantLogForTests, resolveEmbedScope } from '@/lib/rag/tenant/embed';
import { scopeKey } from '@/lib/rag/tenant/scope';

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const ORG_O = '00000000-0000-4000-8000-0000000000c1';
const ORG_OTHER = '00000000-0000-4000-8000-0000000000c2';

interface RecordedCall {
  table: string;
  filters: Record<string, string>;
  columns: string | null;
  signal: AbortSignal | undefined;
}

function fakeAdmin(organizations: string[], failure?: string) {
  const calls: RecordedCall[] = [];
  const admin = {
    from(table: string) {
      const call: RecordedCall = { table, filters: {}, columns: null, signal: undefined };
      calls.push(call);
      const query = {
        select(columns: string) {
          call.columns = columns;
          return query;
        },
        eq(column: string, value: string) {
          call.filters[column] = value;
          return query;
        },
        abortSignal(signal: AbortSignal) {
          call.signal = signal;
          return query;
        },
        maybeSingle() {
          if (failure) return Promise.resolve({ data: null, error: { message: failure } });
          const found = table === 'organizations' && organizations.includes(call.filters.id);
          return Promise.resolve({ data: found ? { id: call.filters.id } : null, error: null });
        },
      };
      return query;
    },
  };
  return { admin: admin as never, calls };
}

const signal = () => new AbortController().signal;

beforeEach(() => {
  resetEmbedTenantLogForTests();
});

describe('parseTenantKey', () => {
  test('accepts exactly s:default, o:<uuid> and u:<uuid>', () => {
    expect(parseTenantKey('s:default')).toEqual({ kind: 'single' });
    expect(parseTenantKey(`o:${ORG_O}`)).toEqual({ kind: 'org', organizationId: ORG_O });
    expect(parseTenantKey(`u:${USER_A}`)).toEqual({ kind: 'personal', userId: USER_A });
  });

  test('normalises case and surrounding whitespace', () => {
    expect(parseTenantKey(`  o:${ORG_O.toUpperCase()} `)).toEqual({ kind: 'org', organizationId: ORG_O });
    expect(parseTenantKey('S:DEFAULT')).toEqual({ kind: 'single' });
  });

  test.each(['', 'default', 's:other', 'o:not-a-uuid', 'u:', `x:${ORG_O}`, `o:${ORG_O}:extra`, `org:${ORG_O}`, ORG_O, null, undefined, 42, {}])(
    'rejects %j',
    (value) => {
      expect(parseTenantKey(value)).toBeNull();
    },
  );
});

describe('resolveEmbedScope single-tenant', () => {
  test('empty configuration and s:default both give s:default', async () => {
    for (const configuredTenant of [undefined, '', '   ', 's:default']) {
      const result = await resolveEmbedScope({ rawBody: { messages: [] }, configuredTenant, deploymentMode: 'single-tenant', signal: signal() });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected a scope');
      expect(scopeKey(result.scope)).toBe('s:default');
    }
  });

  test.each([`o:${ORG_O}`, `u:${USER_A}`, 'garbage'])('configuration %j gives embed_tenant_invalid', async (configuredTenant) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await resolveEmbedScope({ rawBody: {}, configuredTenant, deploymentMode: 'single-tenant', signal: signal() });
    expect(result).toEqual({ ok: false, status: 'retrieval_error', reason: 'embed_tenant_invalid' });
    warn.mockRestore();
  });
});

describe('resolveEmbedScope multi-tenant', () => {
  test('unset configuration fails closed and logs once per process', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (const configuredTenant of [undefined, '']) {
      const result = await resolveEmbedScope({ rawBody: {}, configuredTenant, deploymentMode: 'multi-tenant', admin: null, signal: signal() });
      expect(result).toEqual({ ok: false, status: 'retrieval_error', reason: 'embed_tenant_unconfigured' });
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).toContain('embed_tenant_unconfigured');
    warn.mockRestore();
  });

  test('s:default is refused because it would search every tenant', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await resolveEmbedScope({ rawBody: {}, configuredTenant: 's:default', deploymentMode: 'multi-tenant', signal: signal() });
    expect(result).toEqual({ ok: false, status: 'retrieval_error', reason: 'embed_tenant_invalid' });
    warn.mockRestore();
  });

  test('an existing organization gives o:<O> after one existence query', async () => {
    const { admin, calls } = fakeAdmin([ORG_O]);
    const abort = signal();
    const result = await resolveEmbedScope({ rawBody: {}, configuredTenant: `o:${ORG_O}`, deploymentMode: 'multi-tenant', admin, signal: abort });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected a scope');
    expect(scopeKey(result.scope)).toBe(`o:${ORG_O}`);
    expect(result.scope.kind).toBe('org');
    expect(calls).toHaveLength(1);
    expect(calls[0].table).toBe('organizations');
    expect(calls[0].columns).toBe('id');
    expect(calls[0].filters).toEqual({ id: ORG_O });
    expect(calls[0].signal).toBe(abort);
  });

  test('an uppercase configured organization is normalised for the query and the scope', async () => {
    const { admin, calls } = fakeAdmin([ORG_O]);
    const result = await resolveEmbedScope({ rawBody: {}, configuredTenant: `o:${ORG_O.toUpperCase()}`, deploymentMode: 'multi-tenant', admin, signal: signal() });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected a scope');
    expect(scopeKey(result.scope)).toBe(`o:${ORG_O}`);
    expect(calls[0].filters.id).toBe(ORG_O);
  });

  test('a configured organization that does not exist fails closed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { admin } = fakeAdmin([ORG_OTHER]);
    const result = await resolveEmbedScope({ rawBody: {}, configuredTenant: `o:${ORG_O}`, deploymentMode: 'multi-tenant', admin, signal: signal() });
    expect(result).toEqual({ ok: false, status: 'retrieval_error', reason: 'embed_tenant_unknown' });
    warn.mockRestore();
  });

  test('an existence query error or a missing admin client fails closed with 503', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failing = fakeAdmin([ORG_O], 'connection reset');
    const failed = await resolveEmbedScope({ rawBody: {}, configuredTenant: `o:${ORG_O}`, deploymentMode: 'multi-tenant', admin: failing.admin, signal: signal() });
    expect(failed).toEqual({ ok: false, status: 503, reason: 'embed_tenant_unavailable' });
    const missing = await resolveEmbedScope({ rawBody: {}, configuredTenant: `o:${ORG_O}`, deploymentMode: 'multi-tenant', admin: null, signal: signal() });
    expect(missing).toEqual({ ok: false, status: 503, reason: 'embed_tenant_unavailable' });
    warn.mockRestore();
  });

  test('u:<uuid> gives the personal scope without a query', async () => {
    const { admin, calls } = fakeAdmin([]);
    const result = await resolveEmbedScope({ rawBody: {}, configuredTenant: `u:${USER_A}`, deploymentMode: 'multi-tenant', admin, signal: signal() });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected a scope');
    expect(result.scope.kind).toBe('personal');
    expect(scopeKey(result.scope)).toBe(`u:${USER_A}`);
    expect(calls).toHaveLength(0);
  });
});

describe('resolveEmbedScope raw body workspace keys', () => {
  const configured = { configuredTenant: `o:${ORG_O}`, deploymentMode: 'multi-tenant' as const };

  test.each([
    { organizationId: ORG_OTHER },
    { workspaceId: ORG_OTHER },
    { tenant: `o:${ORG_OTHER}` },
    { tenant: `u:${USER_A}` },
    { tenant: 's:default' },
    { tenant: 'garbage' },
    { organizationId: 12345 },
    { workspaceId: { id: ORG_O } },
  ])('body %j that differs from the configuration gets 403 before any query', async (rawBody) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { admin, calls } = fakeAdmin([ORG_O]);
    const result = await resolveEmbedScope({ rawBody, ...configured, admin, signal: signal() });
    expect(result).toEqual({ ok: false, status: 403, reason: 'workspace_mismatch' });
    expect(calls).toHaveLength(0);
    warn.mockRestore();
  });

  test.each([
    { organizationId: ORG_O },
    { organizationId: ORG_O.toUpperCase() },
    { workspaceId: ORG_O },
    { tenant: `o:${ORG_O}` },
    { tenant: `O:${ORG_O.toUpperCase()}` },
    { organizationId: null, workspaceId: undefined, tenant: '' },
    { organizationId: 'null' },
    { messages: [{ role: 'user', content: 'hello' }], model: 'x' },
    {},
  ])('body %j that matches the configuration or names no workspace is allowed', async (rawBody) => {
    const { admin } = fakeAdmin([ORG_O]);
    const result = await resolveEmbedScope({ rawBody, ...configured, admin, signal: signal() });
    expect(result.ok).toBe(true);
  });

  test('a body that is not an object names no workspace', async () => {
    const { admin } = fakeAdmin([ORG_O]);
    for (const rawBody of [null, undefined, 'text', 7, [ORG_OTHER]]) {
      const result = await resolveEmbedScope({ rawBody, ...configured, admin, signal: signal() });
      expect(result.ok).toBe(true);
    }
  });

  test('single-tenant: any named organization differs from s:default and gets 403', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await resolveEmbedScope({ rawBody: { organizationId: ORG_O }, deploymentMode: 'single-tenant', signal: signal() });
    expect(result).toEqual({ ok: false, status: 403, reason: 'workspace_mismatch' });
    const same = await resolveEmbedScope({ rawBody: { tenant: 's:default' }, deploymentMode: 'single-tenant', signal: signal() });
    expect(same.ok).toBe(true);
    warn.mockRestore();
  });

  test('the 403 log carries the reason only, never the requested ids', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await resolveEmbedScope({ rawBody: { organizationId: ORG_OTHER }, ...configured, admin: fakeAdmin([ORG_O]).admin, signal: signal() });
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('[RAG Tenant]');
    expect(logged).not.toContain(ORG_OTHER);
    expect(logged).not.toContain(ORG_O);
    warn.mockRestore();
  });
});
