import { describe, expect, it, vi } from 'vitest';
import fixture from '../fixtures/nango/drive-permissions.json';
import dropbox from '../fixtures/nango/dropbox-members.json';
import notion from '../fixtures/nango/notion-page.json';
import type { AccessServiceDeps, ApplyConnectorAccessInput, ConnectorAccessResult, ConnectorPrincipal, TenantScope } from '@/lib/rag';

import { logger } from '@/lib/logger';
import { notionWorkspaceId, syncSourcePermissions } from '@/lib/nango/permission-sync';

const OWNER = '00000000-0000-4000-8000-0000000000a1';
const MEMBER = '00000000-0000-4000-8000-0000000000a2';
const GROUP_A = '00000000-0000-4000-8000-0000000000b1';
const GROUP_C = '00000000-0000-4000-8000-0000000000b3';
const DOCUMENT = '00000000-0000-4000-8000-0000000000d1';
const SCOPE = { mode: 'single', kind: 'single' } as unknown as TenantScope;
const ACCESS = { db: () => null, signal: new AbortController().signal } as AccessServiceDeps;

type Page = { permissions?: unknown[]; nextPageToken?: string };

const MEMBERS: Record<string, string> = { 'owner@example.org': OWNER, 'member-1@example.org': MEMBER };
const GROUP_MAP: Record<string, string> = {
  'source-group-1@example.org': GROUP_A,
  'source-group-3@example.org': GROUP_C,
  'g:source-group-1': GROUP_A,
  'g:source-group-2': GROUP_C,
};
const WORKSPACE_MAP: Record<string, string> = { 'workspace-1': GROUP_A };

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
function fakeApply(options: { domainRule?: boolean; anyoneRule?: boolean; publicRule?: boolean } = {}) {
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
      } else if (principal.kind === 'workspace') {
        const group = WORKSPACE_MAP[principal.id];
        if (!group) return { keys: owner, failClosed: true, reason: 'unmapped_source' };
        keys.add(`g:${group}`);
      } else if (principal.kind === 'public') {
        if (!options.publicRule) return { keys: owner, failClosed: true, reason: 'unmapped_source' };
        keys.add('all');
      } else {
        return { keys: owner, failClosed: true, reason: 'unmapped_source' };
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
    const provider = 'box' as unknown as 'dropbox';
    const summary = await syncSourcePermissions({ ...input(), provider }, { access: ACCESS, nango, matchMembers, applyAccess: apply });
    expect(calls).toHaveLength(0);
    expect(inputs[0]).toMatchObject({ status: 'source_error', principals: [] });
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

/** Answers Dropbox RPC calls by route: file members (with continue) and folder members (with continue). */
function dropboxProxy(routes: { file?: unknown[] | (() => never); folder?: unknown[] }) {
  const calls: Array<Record<string, unknown>> = [];
  const proxy = vi.fn(async (config: Record<string, unknown>) => {
    calls.push(config);
    const endpoint = String(config.endpoint);
    const data = (config.data ?? {}) as Record<string, unknown>;
    const pages = endpoint.startsWith('/2/sharing/list_file_members') ? routes.file : routes.folder;
    if (typeof pages === 'function') return pages();
    const index = endpoint.endsWith('/continue') ? Number(String(data.cursor).replace(/^cursor-\w+-/, '')) - 1 : 0;
    return { data: (pages ?? [])[index] };
  });
  return { nango: { proxy }, calls };
}

function dropboxInput(extra: Record<string, unknown> = {}) {
  return { ...input(), provider: 'dropbox' as const, fileId: 'id:file-1', ...extra };
}

describe('syncSourcePermissions: Dropbox (D-20)', () => {
  it('follows the continue cursor and maps users and invitees by address and groups by group id', async () => {
    const { nango, calls } = dropboxProxy({ file: dropbox.file_two_pages });
    const { apply, inputs } = fakeApply();
    const summary = await syncSourcePermissions(dropboxInput(), { access: ACCESS, nango, matchMembers, applyAccess: apply });

    expect(calls.map((call) => call.endpoint)).toEqual(['/2/sharing/list_file_members', '/2/sharing/list_file_members/continue']);
    expect(calls[0]).toMatchObject({ providerConfigKey: 'dropbox', method: 'POST', data: { file: 'id:file-1', include_inherited: true, limit: 300 } });
    expect(calls[1]).toMatchObject({ data: { cursor: 'cursor-file-2' } });
    expect(calls.every((call) => Number(call.retries) > 0)).toBe(true);
    expect(matchMembers).toHaveBeenLastCalledWith(SCOPE, ['owner@example.org', 'member-1@example.org', 'invitee-1@example.org'], ACCESS);
    expect(inputs[0].status).toBe('ok');
    expect(inputs[0].principals).toEqual([
      { kind: 'user', memberId: OWNER },
      { kind: 'user', memberId: MEMBER },
      { kind: 'user', memberId: null },
      { kind: 'group', id: 'g:source-group-1' },
    ]);
    expect(summary).toMatchObject({ failClosed: true, reason: 'unmapped_source', counts: { user: 3, group: 1 } });
  });

  it('reads the shared folder members of a file inside a shared folder', async () => {
    const { nango, calls } = dropboxProxy({ file: [dropbox.file_two_pages[1]], folder: dropbox.folder_one_page });
    const { apply, inputs } = fakeApply();
    await syncSourcePermissions(dropboxInput({ parentSharedFolderId: '84528192421' }), { access: ACCESS, nango, matchMembers, applyAccess: apply });

    expect(calls.map((call) => call.endpoint)).toEqual(['/2/sharing/list_file_members', '/2/sharing/list_folder_members']);
    expect(calls[1]).toMatchObject({ data: { shared_folder_id: '84528192421', limit: 1000 } });
    expect(inputs[0].principals).toEqual(expect.arrayContaining([{ kind: 'group', id: 'g:source-group-2' }]));
  });

  it('fails closed on a missing sharing.read scope', async () => {
    const { nango } = dropboxProxy({
      file: () => {
        throw Object.assign(new Error('missing scope'), { response: dropbox.missing_scope_error });
      },
    });
    const { apply, inputs } = fakeApply();
    const summary = await syncSourcePermissions(dropboxInput(), { access: ACCESS, nango, matchMembers, applyAccess: apply });
    expect(inputs[0]).toMatchObject({ status: 'source_error', principals: [] });
    expect(summary).toMatchObject({ failClosed: true, reason: 'source_error', sourceError: 'missing_scope' });
  });

  it('fails closed when a continue page fails or an invitee carries no address', async () => {
    let call = 0;
    const flaky = {
      proxy: vi.fn(async () => {
        call += 1;
        if (call === 1) return { data: dropbox.file_two_pages[0] };
        throw new Error('continue failed');
      }),
    };
    const first = fakeApply();
    const partial = await syncSourcePermissions(dropboxInput(), { access: ACCESS, nango: flaky, matchMembers, applyAccess: first.apply });
    expect(first.inputs[0]).toMatchObject({ status: 'source_error', principals: [] });
    expect(partial.sourceError).toBe('fetch_failed');

    const { nango } = dropboxProxy({ file: dropbox.invitee_without_address });
    const second = fakeApply();
    const malformed = await syncSourcePermissions(dropboxInput(), { access: ACCESS, nango, matchMembers, applyAccess: second.apply });
    expect(malformed).toMatchObject({ failClosed: true, sourceError: 'malformed' });
  });

  it('keeps addresses out of the summary and the logs', async () => {
    logged.length = 0;
    const { nango } = dropboxProxy({ file: dropbox.file_two_pages });
    const summary = await syncSourcePermissions(dropboxInput(), { access: ACCESS, nango, matchMembers, applyAccess: fakeApply().apply });
    expect(addressesIn(summary)).toEqual([]);
    expect(addressesIn(logged)).toEqual([]);
  });
});

function notionInput(extra: Record<string, unknown> = {}) {
  return { ...input(), provider: 'notion' as const, fileId: 'page-1', ...extra };
}

function notionNango(page: unknown, connection: unknown | (() => never)) {
  const calls: Array<Record<string, unknown>> = [];
  const getConnection = vi.fn(async (_key: string, _id: string) => (typeof connection === 'function' ? (connection as () => never)() : connection));
  const proxy = vi.fn(async (config: Record<string, unknown>) => {
    calls.push(config);
    return { data: page };
  });
  return { nango: { proxy, getConnection }, calls, getConnection };
}

describe('syncSourcePermissions: Notion (D-21)', () => {
  it('notionWorkspaceId reads credentials.raw.workspace_id of the Notion connection', async () => {
    const { nango, getConnection } = notionNango(null, notion.connection);
    await expect(notionWorkspaceId('conn-1', nango)).resolves.toBe('workspace-1');
    expect(getConnection).toHaveBeenCalledWith('notion', 'conn-1');
    for (const record of [notion.connection_without_workspace, notion.connection_numeric_workspace, notion.connection_api_key, {}]) {
      await expect(notionWorkspaceId('conn-1', notionNango(null, record).nango)).resolves.toBeNull();
    }
    const throwing = notionNango(null, () => {
      throw new Error('nango down');
    });
    await expect(notionWorkspaceId('conn-1', throwing.nango)).resolves.toBeNull();
  });

  it('maps a private page of a mapped workspace to its group, reading the page with retries', async () => {
    const { nango, calls } = notionNango(notion.private_page, notion.connection);
    const { apply, inputs } = fakeApply();
    const summary = await syncSourcePermissions(notionInput(), { access: ACCESS, nango, matchMembers, applyAccess: apply });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ providerConfigKey: 'notion', method: 'GET', endpoint: '/v1/pages/page-1' });
    expect(Number(calls[0].retries)).toBeGreaterThan(0);
    expect(inputs[0]).toMatchObject({ status: 'ok', principals: [{ kind: 'workspace', id: 'workspace-1' }] });
    expect(summary).toMatchObject({ failClosed: false, reason: 'source_mapped' });
  });

  it('adds a public principal for a published page, which needs an enabled rule', async () => {
    const { nango } = notionNango(notion.published_page, notion.connection);
    const closed = fakeApply();
    const summary = await syncSourcePermissions(notionInput({ notionPage: notion.published_page }), { access: ACCESS, nango, matchMembers, applyAccess: closed.apply });
    expect(closed.inputs[0].principals).toEqual([{ kind: 'workspace', id: 'workspace-1' }, { kind: 'public' }]);
    expect(summary).toMatchObject({ failClosed: true, reason: 'unmapped_source' });

    const open = fakeApply({ publicRule: true });
    const mapped = await syncSourcePermissions(notionInput({ notionPage: notion.published_page }), { access: ACCESS, nango, matchMembers, applyAccess: open.apply });
    expect(mapped.reason).toBe('source_mapped');
  });

  it('falls back to the owner when the workspace is not mapped', async () => {
    const other = { credentials: { ...notion.connection.credentials, raw: { workspace_id: 'workspace-unmapped' } } };
    const { nango } = notionNango(notion.private_page, other);
    const { apply } = fakeApply();
    const summary = await syncSourcePermissions(notionInput(), { access: ACCESS, nango, matchMembers, applyAccess: apply });
    expect(summary).toMatchObject({ failClosed: true, reason: 'unmapped_source' });
  });

  it('fails every page closed when the workspace id is missing, malformed or unreadable, never mapping an empty id', async () => {
    const throwing = () => {
      throw new Error('nango down');
    };
    for (const record of [notion.connection_without_workspace, notion.connection_numeric_workspace, notion.connection_api_key, throwing]) {
      const { nango } = notionNango(notion.private_page, record);
      const { apply, inputs } = fakeApply();
      const summary = await syncSourcePermissions(notionInput(), { access: ACCESS, nango, matchMembers, applyAccess: apply });
      expect(inputs).toHaveLength(1);
      expect(inputs[0]).toMatchObject({ status: 'source_error', principals: [] });
      expect(summary).toMatchObject({ failClosed: true, reason: 'source_error', sourceError: 'workspace_unknown' });
    }
  });

  it('uses the per-run workspace reader and rejects a malformed public_url', async () => {
    const reader = vi.fn(async () => 'workspace-1');
    const { nango, getConnection } = notionNango(notion.malformed_page, notion.connection);
    const { apply, inputs } = fakeApply();
    const summary = await syncSourcePermissions(notionInput(), { access: ACCESS, nango, matchMembers, applyAccess: apply, notionWorkspace: reader });
    expect(reader).toHaveBeenCalledTimes(1);
    expect(getConnection).not.toHaveBeenCalled();
    expect(inputs[0]).toMatchObject({ status: 'source_error' });
    expect(summary.sourceError).toBe('malformed');
  });
});
