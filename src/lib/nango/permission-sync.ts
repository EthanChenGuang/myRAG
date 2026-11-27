import { getNango } from './client';
import { PROVIDER_CONFIG } from './types';
import { logger } from '@/lib/logger';
import {
    applyConnectorAccess,
    matchConnectorMembers,
    type AccessServiceDeps,
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

interface DrivePermission {
    id?: string;
    type?: string;
    role?: string;
    emailAddress?: string;
    domain?: string;
    deleted?: boolean;
}

interface PermissionProxy {
    proxy(config: Record<string, unknown>): Promise<{ data: unknown }>;
}

const DRIVE_PERMISSION_FIELDS = 'nextPageToken,permissions(id,type,role,emailAddress,domain,deleted,allowFileDiscovery,permissionDetails)';

/** Reads a Drive file's sharing (permissions.list, read-only). */
export async function fetchDrivePermissions(nango: PermissionProxy, connectionId: string, fileId: string): Promise<DrivePermission[]> {
    const response = await nango.proxy({
        providerConfigKey: PROVIDER_CONFIG['google-drive'].integrationId,
        connectionId,
        method: 'GET',
        endpoint: `/drive/v3/files/${encodeURIComponent(fileId)}/permissions`,
        params: { supportsAllDrives: 'true', fields: DRIVE_PERMISSION_FIELDS },
    });
    const data = response.data as { permissions?: DrivePermission[] };
    return data.permissions ?? [];
}

function normalise(value: string): string {
    return value.trim().toLowerCase();
}

/** Maps Drive permissions to principals. */
export function mapDrivePermissions(permissions: readonly DrivePermission[]): SourcePrincipal[] {
    return permissions.map((permission): SourcePrincipal => {
        if (permission.type === 'user') return { kind: 'user', address: normalise(permission.emailAddress ?? '') };
        if (permission.type === 'group') return { kind: 'group', id: normalise(permission.emailAddress ?? '') };
        if (permission.type === 'domain') return { kind: 'domain', id: normalise(permission.domain ?? '') };
        return { kind: 'anyone' };
    });
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
    keys: string[];
    failClosed: boolean;
    reason: string;
}

/** D-20: reads the source sharing of one synced file, maps it and applies it to the document's access label; any error fails closed. */
export async function syncSourcePermissions(input: SyncSourcePermissionsInput, deps: PermissionSyncDeps): Promise<PermissionSyncSummary> {
    const apply = deps.applyAccess ?? applyConnectorAccess;
    const match = deps.matchMembers ?? matchConnectorMembers;
    let principals: ConnectorPrincipal[] = [];
    let status: 'ok' | 'source_error' = 'ok';
    try {
        const nango = deps.nango ?? (getNango() as unknown as PermissionProxy);
        const source = mapDrivePermissions(await fetchDrivePermissions(nango, input.connectionId, input.fileId));
        const addresses = source.flatMap((principal) => (principal.kind === 'user' ? [principal.address] : []));
        const members = await match(input.scope, addresses, deps.access);
        let next = 0;
        principals = source.map((principal): ConnectorPrincipal => {
            if (principal.kind === 'user') return { kind: 'user', memberId: members[next++] ?? null };
            return principal;
        });
    } catch {
        logger.error('Nango', 'Source permission read failed');
        principals = [];
        status = 'source_error';
    }
    const result = await apply(
        input.scope,
        { documentId: input.documentId, provider: input.provider, principals, ownerId: input.ownerUserId, status },
        deps.access
    );
    return { keys: result.keys, failClosed: result.failClosed, reason: result.reason };
}
