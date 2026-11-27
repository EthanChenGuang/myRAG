import { describe, expect, it, vi } from 'vitest';
import fixture from '../fixtures/nango/drive-permissions.json';
import type { AccessServiceDeps, ApplyConnectorAccessInput, ConnectorAccessResult, ConnectorPrincipal, TenantScope } from '@/lib/rag';

import { logger } from '@/lib/logger';
import { syncSourcePermissions } from '@/lib/nango/permission-sync';

const OWNER = '00000000-0000-4000-8000-0000000000a1';
const MEMBER = '00000000-0000-4000-8000-0000000000a2';
const GROUP_A = '00000000-0000-4000-8000-0000000000b1';
const GROUP_C = '00000000-0000-4000-8000-0000000000b3';
const DOCUMENT = '00000000-0000-4000-8000-0000000000d1';
const SCOPE = { mode: 'single', kind: 'single' } as unknown as TenantScope;
const ACCESS = { db: () => null, signal: new AbortController().signal } as AccessServiceDeps;

type Page = { permissions?: unknown[]; nextPageToken?: string };

const MEMBERS: Record<string, string> = { 'owner@example.org': OWNER, 'member-1@example.org': MEMBER };
const GROUP_MAP: Record<string, string> = { 'source-group-1@example.org': GROUP_A, 'source-group-3@example.org': GROUP_C };

function fakeProxy(pages: Page[] | (() => never)) {
  const calls: Array<Record<string, unknown>> = [];
  const proxy = vi.fn(async (config: Record<string, unknown>) => {
    calls.push(config);
    if (typeof pages === 'function') return pages();
    const token = (config.params as Record<string, string> | undefined)?.pageToken;
    const index = token ? Number(token.replace('page-', '')) - 1 : 0;
    return { data: pages[index] };
  });
  return { nango: { proxy }, calls };
}

/** Mirrors rag_connector_apply_access (plan 30): every principal must map or the document falls back to its owner. */
function fakeApply(options: { domainRule?: boolean; anyoneRule?: boolean } = {}) {
  const inputs: ApplyConnectorAccessInput[] = [];
  const apply = vi.fn(async (_scope: TenantScope, input: ApplyConnectorAccessInput): Promise<ConnectorAccessResult> => {
    inputs.push(input);
    const owner = [`u:${input.ownerId}`];
    if (input.status === 'source_error') return { keys: owner, failClosed: true, reason: 'source_error' };
    const keys = new Set<string>();
    for (const principal of input.principals as ConnectorPrincipal[]) {
      if (principal.kind === 'user') {
        if (!principal.memberId) return { keys: owner, failClosed: true, reason: 'unmapped_source' };
        keys.add(`u:${principal.memberId}`);
      } else if (principal.kind === 'group') {
        const group = GROUP_MAP[principal.id];
        if (!group) return { keys: owner, failClosed: true, reason: 'unmapped_source' };
        keys.add(`g:${group}`);
      } else if (principal.kind === 'domain') {
        if (!options.domainRule) return { keys: owner, failClosed: true, reason: 'unmapped_source' };
        keys.add('all');
      } else if (principal.kind === 'anyone') {
        if (!options.anyoneRule) return { keys: owner, failClosed: true, reason: 'unmapped_source' };
        keys.add('all');
      }
    }
    if (keys.has('all')) return { keys: ['all'], failClosed: false, reason: 'source_mapped' };
    if (keys.size === 0) return { keys: owner, failClosed: false, reason: 'owner_only' };
    return { keys: [...keys].sort(), failClosed: false, reason: 'source_mapped' };
  });
  return { apply, inputs };
}

const matchMembers = vi.fn(async (_scope: TenantScope, addresses: readonly string[]) => addresses.map((address) => MEMBERS[address] ?? null));

function input() {
  return { provider: 'google-drive' as const, connectionId: 'conn-1', fileId: 'file-1', documentId: DOCUMENT, ownerUserId: OWNER, scope: SCOPE };
}

function addressesIn(value: unknown): string[] {
  return JSON.stringify(value).match(/[a-z0-9.-]+@example\.org/gi) ?? [];
}

const logged: unknown[][] = [];
for (const level of ['debug', 'error', 'warn', 'info'] as const) {
  vi.spyOn(logger, level).mockImplementation((...args: unknown[]) => {
    logged.push(args);
  });
}

describe('syncSourcePermissions: Google Drive (D-20)', () => {
  it('maps a file shared with a mapped group and a member to that group and those members', async () => {
    const { nango } = fakeProxy(fixture.shared_with_group);
    const { apply, inputs } = fakeApply();
    const summary = await syncSourcePermissions(input(), { access: ACCESS, nango, matchMembers, applyAccess: apply });

    expect(inputs).toHaveLength(1);
    expect(inputs[0].status).toBe('ok');
    expect(inputs[0].principals).toEqual(
      expect.arrayContaining([
        { kind: 'user', memberId: OWNER },
        { kind: 'group', id: 'source-group-1@example.org' },
        { kind: 'user', memberId: MEMBER },
      ])
    );
    expect(summary.failClosed).toBe(false);
    expect(summary.reason).toBe('source_mapped');
    expect(addressesIn(inputs[0])).toEqual(['source-group-1@example.org']);
    expect(addressesIn(summary)).toEqual([]);
  });

  it('falls back to the owner when one source group is not mapped', async () => {
    const { nango } = fakeProxy(fixture.unmapped_group);
    const { apply } = fakeApply();
    const summary = await syncSourcePermissions(input(), { access: ACCESS, nango, matchMembers, applyAccess: apply });
    expect(summary.failClosed).toBe(true);
    expect(summary.reason).toBe('unmapped_source');
  });

  it('applies source_error when the proxy call fails', async () => {
    const { nango } = fakeProxy(() => {
      throw new Error('proxy down');
    });
    const { apply, inputs } = fakeApply();
    const summary = await syncSourcePermissions(input(), { access: ACCESS, nango, matchMembers, applyAccess: apply });
    expect(inputs[0]).toMatchObject({ status: 'source_error', principals: [], ownerId: OWNER });
    expect(summary).toMatchObject({ failClosed: true, reason: 'source_error' });
    expect(logger.error).toHaveBeenCalled();
  });

  it('reads every page through nextPageToken with supportsAllDrives, explicit fields and retries, and never writes at the source', async () => {
    const { nango, calls } = fakeProxy(fixture.two_pages);
    const { apply, inputs } = fakeApply({ domainRule: true, anyoneRule: true });
    const summary = await syncSourcePermissions(input(), { access: ACCESS, nango, matchMembers, applyAccess: apply });

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.method).toBe('GET');
      expect(call.endpoint).toBe('/drive/v3/files/file-1/permissions');
      expect(call.retries).toEqual(expect.any(Number));
      expect(Number(call.retries)).toBeGreaterThan(0);
      const params = call.params as Record<string, string>;
      expect(params.supportsAllDrives).toBe('true');
      expect(params.pageSize).toBe('100');
      for (const field of ['id', 'type', 'role', 'emailAddress', 'domain', 'deleted', 'allowFileDiscovery', 'permissionDetails']) {
        expect(params.fields).toContain(field);
      }
      expect(params.fields).toContain('nextPageToken');
    }
    expect((calls[0].params as Record<string, string>).pageToken).toBeUndefined();
    expect((calls[1].params as Record<string, string>).pageToken).toBe('page-2');

    expect(inputs[0].principals).toEqual(
      expect.arrayContaining([{ kind: 'domain', id: 'example.org' }, { kind: 'anyone' }, { kind: 'group', id: 'source-group-3@example.org' }])
    );
    expect(summary.counts).toEqual({ user: 1, group: 2, domain: 1, anyone: 1 });
    expect(summary.failClosed).toBe(false);
  });

  it('ignores deleted entries and counts inherited shared-drive entries', async () => {
    const { nango } = fakeProxy(fixture.two_pages);
    const { apply, inputs } = fakeApply({ domainRule: true, anyoneRule: true });
    await syncSourcePermissions(input(), { access: ACCESS, nango, matchMembers, applyAccess: apply });
    const users = inputs[0].principals.filter((principal) => principal.kind === 'user');
    expect(users).toEqual([{ kind: 'user', memberId: OWNER }]);
    expect(matchMembers).not.toHaveBeenCalledWith(expect.anything(), expect.arrayContaining(['former-member@example.org']), expect.anything());
    expect(inputs[0].principals).toContainEqual({ kind: 'group', id: 'source-group-3@example.org' });
  });

  it('lets every role grant read', async () => {
    const { nango } = fakeProxy(fixture.every_role);
    const { apply, inputs } = fakeApply();
    const summary = await syncSourcePermissions(input(), { access: ACCESS, nango, matchMembers, applyAccess: apply });
    expect(inputs[0].principals).toHaveLength(4);
    expect(summary.counts).toEqual({ user: 1, group: 3, domain: 0, anyone: 0 });
  });

  it('fails closed on a 403 missing-scope answer', async () => {
    const { nango } = fakeProxy(() => {
      throw Object.assign(new Error('Request failed with status code 403'), { response: fixture.missing_scope_error });
    });
    const { apply, inputs } = fakeApply();
    const summary = await syncSourcePermissions(input(), { access: ACCESS, nango, matchMembers, applyAccess: apply });
    expect(inputs[0]).toMatchObject({ status: 'source_error', principals: [] });
    expect(summary).toMatchObject({ failClosed: true, reason: 'source_error', sourceError: 'missing_scope' });
  });

  it('fails closed on a malformed response', async () => {
    for (const pages of [fixture.malformed, [{ permissions: 'not-a-list' }], [{}], [null]] as unknown as Page[][]) {
      const { nango } = fakeProxy(pages);
      const { apply, inputs } = fakeApply();
      const summary = await syncSourcePermissions(input(), { access: ACCESS, nango, matchMembers, applyAccess: apply });
      expect(inputs[0]).toMatchObject({ status: 'source_error', principals: [] });
      expect(summary).toMatchObject({ failClosed: true, reason: 'source_error', sourceError: 'malformed' });
    }
  });

  it('fails closed when a later page fails, never applying a partial list', async () => {
    let call = 0;
    const proxy = vi.fn(async () => {
      call += 1;
      if (call === 1) return { data: fixture.two_pages[0] };
      throw new Error('proxy down');
    });
    const { apply, inputs } = fakeApply({ domainRule: true, anyoneRule: true });
    const summary = await syncSourcePermissions(input(), { access: ACCESS, nango: { proxy }, matchMembers, applyAccess: apply });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ status: 'source_error', principals: [] });
    expect(summary.failClosed).toBe(true);
  });

  it('fails closed when member matching fails', async () => {
    const { nango } = fakeProxy(fixture.shared_with_group);
    const { apply, inputs } = fakeApply();
    const failing = vi.fn(async () => {
      throw new Error('db down');
    });
    const summary = await syncSourcePermissions(input(), { access: ACCESS, nango, matchMembers: failing, applyAccess: apply });
    expect(inputs[0]).toMatchObject({ status: 'source_error', principals: [] });
    expect(summary).toMatchObject({ failClosed: true, reason: 'source_error', sourceError: 'match_failed' });
  });

  it('fails closed for a provider without a sharing reader', async () => {
    const { nango, calls } = fakeProxy(fixture.shared_with_group);
    const { apply, inputs } = fakeApply();
    const summary = await syncSourcePermissions({ ...input(), provider: 'dropbox' }, { access: ACCESS, nango, matchMembers, applyAccess: apply });
    expect(calls).toHaveLength(0);
    expect(inputs[0]).toMatchObject({ status: 'source_error', principals: [], provider: 'dropbox' });
    expect(summary).toMatchObject({ failClosed: true, sourceError: 'unsupported_provider' });
  });

  it('returns counts and the fail-closed flag only, and logs no address', async () => {
    logged.length = 0;
    for (const pages of [fixture.shared_with_group, fixture.unmapped_group, fixture.two_pages]) {
      const { nango } = fakeProxy(pages);
      const { apply } = fakeApply();
      const summary = await syncSourcePermissions(input(), { access: ACCESS, nango, matchMembers, applyAccess: apply });
      expect(Object.keys(summary).sort()).toEqual(['counts', 'failClosed', 'reason', 'sourceError']);
      expect(addressesIn(summary)).toEqual([]);
    }
    const { nango } = fakeProxy(() => {
      throw Object.assign(new Error('failed for owner@example.org'), { response: fixture.missing_scope_error, config: { url: 'x?owner@example.org' } });
    });
    await syncSourcePermissions(input(), { access: ACCESS, nango, matchMembers, applyAccess: fakeApply().apply });
    expect(logged.length).toBeGreaterThan(0);
    expect(addressesIn(logged)).toEqual([]);
  });

  it('runs and applies with RAG_DOC_ACCESS_GROUPS off (D-22)', async () => {
    vi.stubEnv('RAG_DOC_ACCESS_GROUPS', 'off');
    try {
      const { nango } = fakeProxy(fixture.shared_with_group);
      const { apply, inputs } = fakeApply();
      const summary = await syncSourcePermissions(input(), { access: ACCESS, nango, matchMembers, applyAccess: apply });
      expect(inputs).toHaveLength(1);
      expect(summary.reason).toBe('source_mapped');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('retries the apply closed when the mapped apply is refused, and rethrows when that also fails', async () => {
    const { nango } = fakeProxy(fixture.shared_with_group);
    const statuses: string[] = [];
    const refusing = vi.fn(async (_scope: TenantScope, value: ApplyConnectorAccessInput): Promise<ConnectorAccessResult> => {
      statuses.push(value.status);
      if (value.status === 'ok') throw new Error('refused');
      return { keys: [`u:${value.ownerId}`], failClosed: true, reason: 'source_error' };
    });
    const summary = await syncSourcePermissions(input(), { access: ACCESS, nango, matchMembers, applyAccess: refusing });
    expect(statuses).toEqual(['ok', 'source_error']);
    expect(summary).toMatchObject({ failClosed: true, reason: 'source_error', sourceError: 'apply_failed' });

    const down = vi.fn(async () => {
      throw new Error('db down');
    });
    await expect(syncSourcePermissions(input(), { access: ACCESS, nango, matchMembers, applyAccess: down })).rejects.toThrow();
  });
});
