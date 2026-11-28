/**
 * SharePoint Online and OneDrive for Business connector settings (Phase 6.3, D-24, D-40). Read at call time so the
 * switch and the integration ids follow the environment; off by default.
 */
export type SharePointProvider = 'sharepoint-online' | 'one-drive';

export const SHAREPOINT_PROVIDERS: readonly SharePointProvider[] = ['sharepoint-online', 'one-drive'];

export function isSharePointProvider(provider: string): provider is SharePointProvider {
    return (SHAREPOINT_PROVIDERS as readonly string[]).includes(provider);
}

export function isSharePointEnabled(): boolean {
    return (process.env.NEXT_PUBLIC_NANGO_SHAREPOINT_ENABLED || 'false') === 'true';
}

/** The Nango integration id (providerConfigKey); defaults to the Nango provider id. */
export function sharePointIntegrationKey(provider: SharePointProvider): string {
    const configured = provider === 'sharepoint-online' ? process.env.NANGO_SHAREPOINT_INTEGRATION_KEY : process.env.NANGO_ONEDRIVE_INTEGRATION_KEY;
    const trimmed = (configured || '').trim();
    return trimmed || provider;
}
