import { sharePointIntegrationKey, type SharePointProvider } from './config';
import { graphEndpointOf, graphGet, nangoGraphTransport, pathAndQueryOf, type GraphTransport } from './graph';

/**
 * Listing levels of the SharePoint / OneDrive scope picker (Phase 6.3, D-22). Each call is one Graph page; the next page
 * is handed out as an opaque cursor that only this module reads back, bound to the exact listing path it came from, so
 * a browser-supplied cursor can never steer a request to another path family or host (T-06.3-33).
 */
export interface PickerConnection {
    connectionId: string;
    provider: SharePointProvider;
}

export interface PickerItem {
    id: string;
    name: string;
    has_children: boolean;
}

export interface PickerPage {
    items: PickerItem[];
    cursor: string | null;
}

export interface PickerOptions {
    transport?: GraphTransport;
    signal?: AbortSignal;
}

export class PickerCursorError extends Error {
    constructor() {
        super('invalid_cursor');
        this.name = 'PickerCursorError';
    }
}

const CURSOR_PREFIX = 'spc1.';
const MAX_CURSOR_LENGTH = 4096;
const PICKER_DEADLINE_MS = 15_000;
const PICKER_MAX_TOTAL_WAIT_MS = 10_000;
const GRAPH_ID = /^[A-Za-z0-9!_.,-]{1,256}$/;

const SITE_SELECT = '$select=id,name,displayName';
const DRIVE_SELECT = '$select=id,name';
const CHILD_SELECT = '$select=id,name,folder,file&$top=200';

/** A Graph site, drive or item id: no separators, no encoding, not a dot segment. */
export function isGraphId(value: string): boolean {
    return GRAPH_ID.test(value) && !/^\.+$/.test(value);
}

function encodeCursor(nextLink: unknown): string | null {
    if (typeof nextLink !== 'string' || nextLink === '') return null;
    return `${CURSOR_PREFIX}${Buffer.from(pathAndQueryOf(nextLink), 'utf8').toString('base64url')}`;
}

/** The Graph path and query of a cursor, accepted only for the listing path it was issued for. */
function decodeCursor(cursor: string, expectedPath: string): string {
    if (cursor.length > MAX_CURSOR_LENGTH || !cursor.startsWith(CURSOR_PREFIX)) throw new PickerCursorError();
    const encoded = cursor.slice(CURSOR_PREFIX.length);
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new PickerCursorError();
    const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
    let endpoint: string;
    try {
        endpoint = graphEndpointOf(decoded);
    } catch {
        throw new PickerCursorError();
    }
    const queryAt = endpoint.indexOf('?');
    const path = queryAt === -1 ? endpoint : endpoint.slice(0, queryAt);
    if (path !== expectedPath || queryAt === -1) throw new PickerCursorError();
    return endpoint;
}

function assertId(value: string): string {
    if (!isGraphId(value)) throw new PickerCursorError();
    return value;
}

interface GraphListBody {
    value?: unknown;
    '@odata.nextLink'?: unknown;
}

async function fetchPage(connection: PickerConnection, endpoint: string, options: PickerOptions): Promise<{ values: Record<string, unknown>[]; cursor: string | null }> {
    const transport = options.transport ?? nangoGraphTransport(sharePointIntegrationKey(connection.provider), connection.connectionId);
    const response = await graphGet(transport, endpoint, {
        signal: options.signal,
        deadline: Date.now() + PICKER_DEADLINE_MS,
        maxTotalWaitMs: PICKER_MAX_TOTAL_WAIT_MS,
    });
    const body = (response.data ?? {}) as GraphListBody;
    const values = Array.isArray(body.value) ? (body.value.filter((entry) => entry && typeof entry === 'object') as Record<string, unknown>[]) : [];
    return { values, cursor: encodeCursor(body['@odata.nextLink']) };
}

function textOf(...candidates: unknown[]): string {
    for (const candidate of candidates) if (typeof candidate === 'string' && candidate !== '') return candidate;
    return '';
}

function hasId(entry: Record<string, unknown>): entry is Record<string, unknown> & { id: string } {
    return typeof entry.id === 'string' && entry.id !== '';
}

export async function listSites(connection: PickerConnection, query: string, cursor: string | null, options: PickerOptions = {}): Promise<PickerPage> {
    const term = query.trim();
    const endpoint = cursor
        ? decodeCursor(cursor, '/v1.0/sites')
        : term.length >= 2
          ? `/v1.0/sites?search=${encodeURIComponent(term)}&${SITE_SELECT}`
          : `/v1.0/sites?${SITE_SELECT}`;
    const page = await fetchPage(connection, endpoint, options);
    return {
        items: page.values.filter(hasId).map((site) => ({ id: site.id, name: textOf(site.displayName, site.name, site.id), has_children: true })),
        cursor: page.cursor,
    };
}

/** Libraries of a SharePoint site, or the user's OneDrive libraries (`siteId` null). */
export async function listDrives(connection: PickerConnection, siteId: string | null, cursor: string | null = null, options: PickerOptions = {}): Promise<PickerPage> {
    const path = siteId === null ? '/v1.0/me/drives' : `/v1.0/sites/${assertId(siteId)}/drives`;
    const endpoint = cursor ? decodeCursor(cursor, path) : `${path}?${DRIVE_SELECT}`;
    const page = await fetchPage(connection, endpoint, options);
    return {
        items: page.values.filter(hasId).map((drive) => ({ id: drive.id, name: textOf(drive.name, drive.id), has_children: true })),
        cursor: page.cursor,
    };
}

/** Folders directly under a drive root (`itemId` null) or under a folder; files are left out. */
export async function listFolders(
    connection: PickerConnection,
    driveId: string,
    itemId: string | null,
    cursor: string | null,
    options: PickerOptions = {},
): Promise<PickerPage> {
    const path = itemId === null ? `/v1.0/drives/${assertId(driveId)}/root/children` : `/v1.0/drives/${assertId(driveId)}/items/${assertId(itemId)}/children`;
    const endpoint = cursor ? decodeCursor(cursor, path) : `${path}?${CHILD_SELECT}`;
    const page = await fetchPage(connection, endpoint, options);
    const items: PickerItem[] = [];
    for (const entry of page.values) {
        if (!hasId(entry) || !entry.folder || typeof entry.folder !== 'object') continue;
        const childCount = (entry.folder as { childCount?: unknown }).childCount;
        items.push({ id: entry.id, name: textOf(entry.name, entry.id), has_children: typeof childCount === 'number' && childCount > 0 });
    }
    return { items, cursor: page.cursor };
}
