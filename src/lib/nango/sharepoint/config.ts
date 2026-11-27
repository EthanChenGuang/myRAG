export type SharePointProvider = 'sharepoint-online' | 'one-drive';

export function isSharePointEnabled(): boolean {
    throw new Error('not implemented');
}

export function sharePointIntegrationKey(_provider: SharePointProvider): string {
    throw new Error('not implemented');
}
