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
});
