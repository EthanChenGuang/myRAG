export interface SidebarButtonConfig {
  text: string;
  url: string;
}

type SidebarButtonField = keyof SidebarButtonConfig;

export const SIDEBAR_BUTTON_STORAGE_KEYS: Readonly<Record<SidebarButtonField, string>> = {
  text: 'SIDEBAR_BUTTON_TEXT',
  url: 'SIDEBAR_BUTTON_URL',
};

const SIDEBAR_BUTTON_ENV_NAMES: Readonly<Record<SidebarButtonField, string>> = {
  text: 'NEXT_PUBLIC_SIDEBAR_BUTTON_TEXT',
  url: 'NEXT_PUBLIC_SIDEBAR_BUTTON_URL',
};

export type SidebarButtonStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export type SidebarButtonFetch = (input: string) => Promise<Pick<Response, 'ok' | 'json'>>;

export function clearSidebarButtonCache(storage: SidebarButtonStorage): void {
  try {
    storage.removeItem(SIDEBAR_BUTTON_STORAGE_KEYS.text);
    storage.removeItem(SIDEBAR_BUTTON_STORAGE_KEYS.url);
  } catch {
    // storage can be unavailable (private mode); nothing is read from it
  }
}

export function isSafeSidebarButtonUrl(url: string): boolean {
  if (url.startsWith('/')) return !url.startsWith('//') && !url.startsWith('/\\');
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

async function fetchServerValue(fetchImpl: SidebarButtonFetch, field: SidebarButtonField): Promise<string | null> {
  try {
    const response = await fetchImpl(`/api/config/get-env?var=${SIDEBAR_BUTTON_ENV_NAMES[field]}`);
    if (!response.ok) return null;
    const data: unknown = await response.json();
    const value = (data as { value?: unknown } | null)?.value;
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  } catch {
    console.error('[Sidebar] failed to load the sidebar button setting');
    return null;
  }
}

/**
 * Returns the button only when this page load's server answers confirm both a text and a safe URL; anything else hides it.
 * Values are never cached: the legacy localStorage keys are removed on every call.
 */
export async function syncSidebarButtonConfig(
  storage: SidebarButtonStorage,
  fetchImpl: SidebarButtonFetch,
): Promise<SidebarButtonConfig | null> {
  clearSidebarButtonCache(storage);
  const [text, url] = await Promise.all([fetchServerValue(fetchImpl, 'text'), fetchServerValue(fetchImpl, 'url')]);
  if (!text || !url || !isSafeSidebarButtonUrl(url)) return null;
  return { text, url };
}
