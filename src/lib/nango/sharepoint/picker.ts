import type { SharePointProvider } from './config';
import type { GraphTransport } from './graph';

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

export function isGraphId(_value: string): boolean {
    return false;
}

export async function listSites(_connection: PickerConnection, _query: string, _cursor: string | null, _options: PickerOptions = {}): Promise<PickerPage> {
    throw new Error('not implemented');
}

export async function listDrives(_connection: PickerConnection, _siteId: string | null, _cursor: string | null = null, _options: PickerOptions = {}): Promise<PickerPage> {
    throw new Error('not implemented');
}

export async function listFolders(
    _connection: PickerConnection,
    _driveId: string,
    _itemId: string | null,
    _cursor: string | null,
    _options: PickerOptions = {},
): Promise<PickerPage> {
    throw new Error('not implemented');
}
