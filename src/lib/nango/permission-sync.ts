import { getNango } from './client';
import { PROVIDER_CONFIG } from './types';
import { logger } from '@/lib/logger';
import {
    applyConnectorAccess,
    CONNECTOR_MAX_PRINCIPALS,
    matchConnectorMembers,
    type AccessServiceDeps,
    type ConnectorAccessReason,
    type ConnectorPrincipal,
    type ConnectorProvider,
    type TenantScope,
} from '@/lib/rag';

/** One sharing entry read at the source, before user addresses are matched. Addresses never leave this module. */
export type SourcePrincipal =
    | { kind: 'user'; address: string }
    | { kind: 'group'; id: string }
    | { kind: 'domain'; id: string }
    | { kind: 'anyone' }
    | { kind: 'workspace'; id: string }
    | { kind: 'public' };

export type SourcePrincipalKind = SourcePrincipal['kind'];

/** Why the source sharing could not be used. Never carries a provider message, an address or a file id. */
export type SourceErrorKind =
    | 'fetch_failed'
    | 'missing_scope'
    | 'malformed'
    | 'incomplete'
    | 'too_many'
    | 'match_failed'
    | 'unsupported_provider'
    | 'apply_failed'
    | 'workspace_unknown';

export interface PermissionProxy {
    proxy(_config: Record<string, unknown>): Promise<{ data: unknown }>;
    getConnection?(_providerConfigKey: string, _connectionId: string): Promise<unknown>;
}

class SourceReadError extends Error {
    constructor(readonly kind: SourceErrorKind) {
        super(`source permission read failed: ${kind}`);
    }
}

const DRIVE_PERMISSION_FIELDS = 'nextPageToken,permissions(id,type,role,emailAddress,domain,deleted,allowFileDiscovery,permissionDetails)';
const DRIVE_PAGE_SIZE = '100';
/** Most permission pages read for one file; more means the list is cut short and the document fails closed. */
const DRIVE_MAX_PAGES = 50;
const PROXY_RETRIES = 3;
const DRIVE_TYPES = new Set(['user', 'group', 'domain', 'anyone']);

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function proxyErrorKind(error: unknown): SourceErrorKind {
    const response = isRecord(error) && isRecord(error.response) ? error.response : null;
    const status = response ? Number(response.status) : NaN;
    if (status === 401 || status === 403) {
        const body = JSON.stringify(response?.data ?? '').toLowerCase();
        if (body.includes('insufficient') || body.includes('scope')) return 'missing_scope';
    }
    return 'fetch_failed';
}

/**
 * Reads every permission of a Drive file through permissions.list (read-only; shared drives included). Any failed or cut-short page throws:
 * a partial list could leave out an entry that would have closed the document.
 */
export async function fetchDrivePermissions(nango: PermissionProxy, connectionId: string, fileId: string): Promise<Record<string, unknown>[]> {
    const permissions: Record<string, unknown>[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < DRIVE_MAX_PAGES; page++) {
        let data: unknown;
        try {
            const response = await nango.proxy({
                providerConfigKey: PROVIDER_CONFIG['google-drive'].integrationId,
                connectionId,
                method: 'GET',
                endpoint: `/drive/v3/files/${encodeURIComponent(fileId)}/permissions`,
                retries: PROXY_RETRIES,
                params: {
                    supportsAllDrives: 'true',
                    fields: DRIVE_PERMISSION_FIELDS,
                    pageSize: DRIVE_PAGE_SIZE,
                    ...(pageToken ? { pageToken } : {}),
                },
            });
            data = response?.data;
        } catch (error) {
            throw new SourceReadError(proxyErrorKind(error));
        }
        if (!isRecord(data) || !Array.isArray(data.permissions)) throw new SourceReadError('malformed');
        for (const entry of data.permissions) {
            if (!isRecord(entry)) throw new SourceReadError('malformed');
            permissions.push(entry);
        }
        if (permissions.length > CONNECTOR_MAX_PRINCIPALS) throw new SourceReadError('too_many');
        const next = data.nextPageToken;
        if (next === undefined || next === null || next === '') return permissions;
        if (typeof next !== 'string') throw new SourceReadError('malformed');
        pageToken = next;
    }
    throw new SourceReadError('incomplete');
}

function identifier(value: unknown): string {
    const normalised = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (normalised === '') throw new SourceReadError('malformed');
    return normalised;
}

/**
 * Maps Drive permissions to principals: deleted entries are ignored, any role grants read, inherited shared-drive entries count like direct
 * ones. A group's id is its address, trimmed and lower-cased. An entry of an unknown type or without its identifier makes the read malformed.
 */
export function mapDrivePermissions(permissions: readonly Record<string, unknown>[]): SourcePrincipal[] {
    const principals: SourcePrincipal[] = [];
    const seen = new Set<string>();
    for (const permission of permissions) {
        if (permission.deleted === true) continue;
        const type = permission.type;
        if (typeof type !== 'string' || !DRIVE_TYPES.has(type)) throw new SourceReadError('malformed');
        let principal: SourcePrincipal;
        if (type === 'user') principal = { kind: 'user', address: identifier(permission.emailAddress) };
        else if (type === 'group') principal = { kind: 'group', id: identifier(permission.emailAddress) };
        else if (type === 'domain') principal = { kind: 'domain', id: identifier(permission.domain) };
        else principal = { kind: 'anyone' };
        const key = principal.kind === 'user' ? `user:${principal.address}` : principal.kind === 'anyone' ? 'anyone' : `${principal.kind}:${principal.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        principals.push(principal);
    }
    return principals;
}

/** Most member pages read per listing (file or folder); more means the list is cut short and the document fails closed. */
const DROPBOX_MAX_PAGES = 50;
/** The per-request maxima of the official Dropbox API spec: list_file_members 1..300, list_folder_members 1..1000. */
const DROPBOX_FILE_MEMBERS_LIMIT = 300;
const DROPBOX_FOLDER_MEMBERS_LIMIT = 1000;

export interface DropboxMembers {
    users: Record<string, unknown>[];
    groups: Record<string, unknown>[];
    invitees: Record<string, unknown>[];
}

async function dropboxCall(nango: PermissionProxy, connectionId: string, endpoint: string, data: Record<string, unknown>): Promise<unknown> {
    try {
        const response = await nango.proxy({
            providerConfigKey: PROVIDER_CONFIG.dropbox.integrationId,
            connectionId,
            method: 'POST',
            endpoint,
            retries: PROXY_RETRIES,
            data,
        });
        return response?.data;
    } catch (error) {
        throw new SourceReadError(proxyErrorKind(error));
    }
}

async function readDropboxListing(
    nango: PermissionProxy,
    connectionId: string,
    endpoint: string,
    first: Record<string, unknown>,
    into: DropboxMembers,
): Promise<void> {
    let body: Record<string, unknown> = first;
    let path = endpoint;
    for (let page = 0; page < DROPBOX_MAX_PAGES; page++) {
        const data = await dropboxCall(nango, connectionId, path, body);
        if (!isRecord(data)) throw new SourceReadError('malformed');
        for (const field of ['users', 'groups', 'invitees'] as const) {
            const list = data[field];
            if (list === undefined) continue;
            if (!Array.isArray(list)) throw new SourceReadError('malformed');
            for (const entry of list) {
                if (!isRecord(entry)) throw new SourceReadError('malformed');
                into[field].push(entry);
            }
        }
        if (into.users.length + into.groups.length + into.invitees.length > CONNECTOR_MAX_PRINCIPALS) throw new SourceReadError('too_many');
        const cursor = data.cursor;
        if (cursor === undefined || cursor === null || cursor === '') return;
        if (typeof cursor !== 'string') throw new SourceReadError('malformed');
        path = `${endpoint}/continue`;
        body = { cursor };
    }
    throw new SourceReadError('incomplete');
}

/**
 * Reads every member of a Dropbox file through sharing/list_file_members (inherited members included) and, for a file inside a shared
 * folder, sharing/list_folder_members of that folder, each followed through its continue route (scope sharing.read, read-only).
 */
export async function fetchDropboxMembers(
    nango: PermissionProxy,
    connectionId: string,
    fileId: string,
    parentSharedFolderId?: string | null,
): Promise<DropboxMembers> {
    const members: DropboxMembers = { users: [], groups: [], invitees: [] };
    await readDropboxListing(nango, connectionId, '/2/sharing/list_file_members', { file: fileId, include_inherited: true, limit: DROPBOX_FILE_MEMBERS_LIMIT }, members);
    if (typeof parentSharedFolderId === 'string' && parentSharedFolderId.trim() !== '') {
        await readDropboxListing(
            nango,
            connectionId,
            '/2/sharing/list_folder_members',
            { shared_folder_id: parentSharedFolderId.trim(), limit: DROPBOX_FOLDER_MEMBERS_LIMIT },
            members,
        );
    }
    return members;
}

function pushUnique(principals: SourcePrincipal[], seen: Set<string>, principal: SourcePrincipal): void {
    const key = principal.kind === 'user' ? `user:${principal.address}` : 'id' in principal ? `${principal.kind}:${principal.id}` : principal.kind;
    if (seen.has(key)) return;
    seen.add(key);
    principals.push(principal);
}

/**
 * Maps Dropbox members: users and email invitees are user principals by address, groups are group principals by group_id (mapped through
 * the admin table). Any access type grants read. An entry without its identifier, or an invitee that is not an address, makes the read malformed.
 */
export function mapDropboxMembers(members: DropboxMembers): SourcePrincipal[] {
    const principals: SourcePrincipal[] = [];
    const seen = new Set<string>();
    for (const entry of members.users) {
        const user = entry.user;
        if (!isRecord(user)) throw new SourceReadError('malformed');
        pushUnique(principals, seen, { kind: 'user', address: identifier(user.email) });
    }
    for (const entry of members.invitees) {
        const invitee = entry.invitee;
        if (!isRecord(invitee) || invitee['.tag'] !== 'email') throw new SourceReadError('malformed');
        pushUnique(principals, seen, { kind: 'user', address: identifier(invitee.email) });
    }
    for (const entry of members.groups) {
        const group = entry.group;
        if (!isRecord(group) || typeof group.group_id !== 'string' || group.group_id.trim() === '') throw new SourceReadError('malformed');
        pushUnique(principals, seen, { kind: 'group', id: group.group_id.trim() });
    }
    return principals;
}

/**
 * The Notion workspace of a connection: workspace_id of the Notion OAuth token response, which Nango keeps as credentials.raw of the
 * connection's OAuth2 credentials. Anything else (no OAuth2 credentials, a missing or non-string value, a failed read) is null, which
 * fails every page of the sync closed. The id is never logged.
 */
export async function notionWorkspaceId(connectionId: string, nango?: PermissionProxy): Promise<string | null> {
    try {
        const client = nango ?? (getNango() as unknown as PermissionProxy);
        if (!client.getConnection) return null;
        const connection = await client.getConnection(PROVIDER_CONFIG.notion.integrationId, connectionId);
        const credentials = isRecord(connection) ? connection.credentials : null;
        if (!isRecord(credentials) || credentials.type !== 'OAUTH2' || !isRecord(credentials.raw)) return null;
        const id = credentials.raw.workspace_id;
        if (typeof id !== 'string' || id.trim() === '') return null;
        return id.trim();
    } catch {
        return null;
    }
}

/** Reads one Notion page object (GET /v1/pages/{id}, read-only) when the caller did not already hold it. */
async function fetchNotionPage(nango: PermissionProxy, connectionId: string, pageId: string): Promise<Record<string, unknown>> {
    let data: unknown;
    try {
        const response = await nango.proxy({
            providerConfigKey: PROVIDER_CONFIG.notion.integrationId,
            connectionId,
            method: 'GET',
            endpoint: `/v1/pages/${encodeURIComponent(pageId)}`,
            retries: PROXY_RETRIES,
        });
        data = response?.data;
    } catch (error) {
        throw new SourceReadError(proxyErrorKind(error));
    }
    if (!isRecord(data)) throw new SourceReadError('malformed');
    return data;
}

/**
 * D-21: a Notion page has no per-page member list; it maps to the connection's workspace (an admin maps the workspace to a group) and, when
 * it is published to the web (public_url set), to a public principal that needs an enabled sharing rule. Nothing else.
 */
export function notionPrincipals(page: Record<string, unknown>, workspaceId: string | null): SourcePrincipal[] {
    if (workspaceId === null || workspaceId.trim() === '') throw new SourceReadError('workspace_unknown');
    const publicUrl = page.public_url;
    if (publicUrl !== undefined && publicUrl !== null && typeof publicUrl !== 'string') throw new SourceReadError('malformed');
    const principals: SourcePrincipal[] = [{ kind: 'workspace', id: workspaceId.trim() }];
    if (typeof publicUrl === 'string' && publicUrl.trim() !== '') principals.push({ kind: 'public' });
    return principals;
}

async function readSourcePrincipals(
    input: SyncSourcePermissionsInput,
    nango: PermissionProxy,
    deps: PermissionSyncDeps,
): Promise<SourcePrincipal[]> {
    if (input.provider === 'google-drive') return mapDrivePermissions(await fetchDrivePermissions(nango, input.connectionId, input.fileId));
    if (input.provider === 'dropbox') {
        return mapDropboxMembers(await fetchDropboxMembers(nango, input.connectionId, input.fileId, input.parentSharedFolderId));
    }
    if (input.provider === 'notion') {
        const workspaceId = deps.notionWorkspace ? await deps.notionWorkspace() : await notionWorkspaceId(input.connectionId, nango);
        logger.debug('Nango', 'Notion workspace of the connection', { found: workspaceId !== null });
        if (workspaceId === null) throw new SourceReadError('workspace_unknown');
        const page = input.notionPage ?? (await fetchNotionPage(nango, input.connectionId, input.fileId));
        return notionPrincipals(page, workspaceId);
    }
    throw new SourceReadError('unsupported_provider');
}

export interface SyncSourcePermissionsInput {
    provider: ConnectorProvider;
    connectionId: string;
    fileId: string;
    documentId: string;
    ownerUserId: string;
    scope: TenantScope;
    /** Dropbox: the shared folder that holds the file (files/list_folder sharing_info.parent_shared_folder_id), when there is one. */
    parentSharedFolderId?: string | null;
    /** Notion: the page object the sync already read; otherwise it is read here. */
    notionPage?: Record<string, unknown>;
}

export interface PermissionSyncDeps {
    access: AccessServiceDeps;
    nango?: PermissionProxy;
    matchMembers?: typeof matchConnectorMembers;
    applyAccess?: typeof applyConnectorAccess;
    /** Notion: the connection's workspace id, read once per sync run (notionWorkspaceId) and shared by every page of that run. */
    notionWorkspace?: () => Promise<string | null>;
}

export interface PermissionSyncSummary {
    /** Source entries per principal kind (deleted entries excluded). */
    counts: Record<SourcePrincipalKind, number>;
    failClosed: boolean;
    reason: ConnectorAccessReason;
    sourceError: SourceErrorKind | null;
}

function emptyCounts(): Record<SourcePrincipalKind, number> {
    return { user: 0, group: 0, domain: 0, anyone: 0, workspace: 0, public: 0 };
}

/**
 * D-20: reads the source sharing of one synced file, maps it to principals and applies it to the document's access label in one step. Any
 * fetch or mapping error applies source_error, which leaves the document to its owner and the tenant admins. Runs whatever the
 * RAG_DOC_ACCESS_GROUPS value (D-22). User addresses are matched here and never returned, stored or logged.
 */
export async function syncSourcePermissions(input: SyncSourcePermissionsInput, deps: PermissionSyncDeps): Promise<PermissionSyncSummary> {
    const apply = deps.applyAccess ?? applyConnectorAccess;
    const match = deps.matchMembers ?? matchConnectorMembers;
    const counts = emptyCounts();
    let principals: ConnectorPrincipal[] = [];
    let sourceError: SourceErrorKind | null = null;
    try {
        const nango = deps.nango ?? (getNango() as unknown as PermissionProxy);
        const source = await readSourcePrincipals(input, nango, deps);
        const addresses = source.flatMap((principal) => (principal.kind === 'user' ? [principal.address] : []));
        let members: Array<string | null>;
        try {
            members = await match(input.scope, addresses, deps.access);
        } catch {
            throw new SourceReadError('match_failed');
        }
        if (!Array.isArray(members) || members.length !== addresses.length) throw new SourceReadError('match_failed');
        let next = 0;
        principals = source.map((principal): ConnectorPrincipal => {
            counts[principal.kind] += 1;
            if (principal.kind === 'user') return { kind: 'user', memberId: members[next++] ?? null };
            return principal;
        });
    } catch (error) {
        sourceError = error instanceof SourceReadError ? error.kind : 'fetch_failed';
        principals = [];
        Object.assign(counts, emptyCounts());
        logger.error('Nango', 'Source permission read failed; document falls back to its owner', { provider: input.provider, kind: sourceError });
    }

    const base = { documentId: input.documentId, provider: input.provider, ownerId: input.ownerUserId };
    let result;
    if (sourceError === null) {
        try {
            result = await apply(input.scope, { ...base, principals, status: 'ok' }, deps.access);
        } catch {
            sourceError = 'apply_failed';
            logger.error('Nango', 'Source permission apply refused; retrying closed', { provider: input.provider });
        }
    }
    if (!result) result = await apply(input.scope, { ...base, principals: [], status: 'source_error' }, deps.access);

    const summary: PermissionSyncSummary = { counts, failClosed: result.failClosed, reason: result.reason, sourceError };
    logger.debug('Nango', 'Source permissions applied', { provider: input.provider, ...summary });
    return summary;
}
