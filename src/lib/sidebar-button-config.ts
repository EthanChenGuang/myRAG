export interface SidebarButtonConfig {
  text: string;
  url: string;
}

type SidebarButtonField = keyof SidebarButtonConfig;

export const SIDEBAR_BUTTON_DEFAULTS: Readonly<SidebarButtonConfig> = {
  text: 'myRAG',
  url: 'https://myrag.laoxiang.app/',
};

export const SIDEBAR_BUTTON_STORAGE_KEYS: Readonly<Record<SidebarButtonField, string>> = {
  text: 'SIDEBAR_BUTTON_TEXT',
  url: 'SIDEBAR_BUTTON_URL',
};

const SIDEBAR_BUTTON_ENV_NAMES: Readonly<Record<SidebarButtonField, string>> = {
  text: 'NEXT_PUBLIC_SIDEBAR_BUTTON_TEXT',
  url: 'NEXT_PUBLIC_SIDEBAR_BUTTON_URL',
};

const FIELDS: readonly SidebarButtonField[] = ['text', 'url'];

export type SidebarButtonStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export type SidebarButtonFetch = (input: string) => Promise<Pick<Response, 'ok' | 'json'>>;

export function readCachedSidebarButtonConfig(storage: SidebarButtonStorage): SidebarButtonConfig {
  const config: SidebarButtonConfig = { ...SIDEBAR_BUTTON_DEFAULTS };
  for (const field of FIELDS) {
    const saved = storage.getItem(SIDEBAR_BUTTON_STORAGE_KEYS[field]);
    if (saved) config[field] = saved;
  }
  return config;
}

export async function syncSidebarButtonConfig(
  storage: SidebarButtonStorage,
  fetchImpl: SidebarButtonFetch,
): Promise<SidebarButtonConfig> {
  const config = readCachedSidebarButtonConfig(storage);
  for (const field of FIELDS) {
    try {
      const response = await fetchImpl(`/api/config/get-env?var=${SIDEBAR_BUTTON_ENV_NAMES[field]}`);
      if (!response.ok) continue;
      const data = await response.json();
      if (data.value) {
        config[field] = data.value;
        storage.setItem(SIDEBAR_BUTTON_STORAGE_KEYS[field], data.value);
      }
    } catch {
      console.error('[Sidebar] failed to load the sidebar button setting');
    }
  }
  return config;
}
