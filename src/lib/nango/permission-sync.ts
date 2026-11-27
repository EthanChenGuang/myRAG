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
    | { kind: 'anyone' };

export type SourcePrincipalKind = SourcePrincipal['kind'];

/** Why the source sharing could not be used. Never carries a provider message, an address or a file id. */
export type SourceErrorKind = 'fetch_failed' | 'missing_scope' | 'malformed' | 'incomplete' | 'too_many' | 'match_failed' | 'unsupported_provider' | 'apply_failed';

export interface PermissionProxy {
    proxy(_config: Record<string, unknown>): Promise<{ data: unknown }>;
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

async function readSourcePrincipals(provider: ConnectorProvider, nango: PermissionProxy, connectionId: string, fileId: string): Promise<SourcePrincipal[]> {
    if (provider === 'google-drive') return mapDrivePermissions(await fetchDrivePermissions(nango, connectionId, fileId));
    throw new SourceReadError('unsupported_provider');
}

export interface SyncSourcePermissionsInput {
    provider: ConnectorProvider;
    connectionId: string;
    fileId: string;
    documentId: string;
    ownerUserId: string;
    scope: TenantScope;
}

export interface PermissionSyncDeps {
    access: AccessServiceDeps;
    nango?: PermissionProxy;
    matchMembers?: typeof matchConnectorMembers;
    applyAccess?: typeof applyConnectorAccess;
}

export interface PermissionSyncSummary {
    /** Source entries per principal kind (deleted entries excluded). */
    counts: Record<SourcePrincipalKind, number>;
    failClosed: boolean;
    reason: ConnectorAccessReason;
    sourceError: SourceErrorKind | null;
}

function emptyCounts(): Record<SourcePrincipalKind, number> {
    return { user: 0, group: 0, domain: 0, anyone: 0 };
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
        const source = await readSourcePrincipals(input.provider, nango, input.connectionId, input.fileId);
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
