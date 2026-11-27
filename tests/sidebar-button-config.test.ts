import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SIDEBAR_BUTTON_DEFAULTS,
  SIDEBAR_BUTTON_STORAGE_KEYS,
  readCachedSidebarButtonConfig,
  syncSidebarButtonConfig,
  type SidebarButtonFetch,
  type SidebarButtonStorage,
} from '@/lib/sidebar-button-config';

const STALE_TEXT = 'Stale Label';
const STALE_URL = 'https://stale.example.test/';

function memoryStorage(initial: Record<string, string> = {}): SidebarButtonStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, String(value));
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

function serverAnswering(values: Record<string, string>): SidebarButtonFetch {
  return async (input) => {
    const name = new URL(input, 'http://localhost').searchParams.get('var') ?? '';
    return { ok: true, json: async () => ({ success: true, value: values[name] ?? '' }) };
  };
}

function staleStorage() {
  return memoryStorage({
    [SIDEBAR_BUTTON_STORAGE_KEYS.text]: STALE_TEXT,
    [SIDEBAR_BUTTON_STORAGE_KEYS.url]: STALE_URL,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sidebar button config', () => {
  it('renders the cached values first', () => {
    expect(readCachedSidebarButtonConfig(staleStorage())).toEqual({ text: STALE_TEXT, url: STALE_URL });
  });

  it('falls back to the defaults and clears both keys when the server answers empty values', async () => {
    const storage = staleStorage();
    const config = await syncSidebarButtonConfig(storage, serverAnswering({}));

    expect(config).toEqual(SIDEBAR_BUTTON_DEFAULTS);
    expect(storage.data.has(SIDEBAR_BUTTON_STORAGE_KEYS.text)).toBe(false);
    expect(storage.data.has(SIDEBAR_BUTTON_STORAGE_KEYS.url)).toBe(false);
  });

  it('resets only the field whose server value is empty', async () => {
    const storage = staleStorage();
    const config = await syncSidebarButtonConfig(
      storage,
      serverAnswering({ NEXT_PUBLIC_SIDEBAR_BUTTON_TEXT: 'Fresh Label' }),
    );

    expect(config).toEqual({ text: 'Fresh Label', url: SIDEBAR_BUTTON_DEFAULTS.url });
    expect(storage.data.get(SIDEBAR_BUTTON_STORAGE_KEYS.text)).toBe('Fresh Label');
    expect(storage.data.has(SIDEBAR_BUTTON_STORAGE_KEYS.url)).toBe(false);
  });

  it('stores and shows non-empty server values as before', async () => {
    const storage = staleStorage();
    const config = await syncSidebarButtonConfig(
      storage,
      serverAnswering({
        NEXT_PUBLIC_SIDEBAR_BUTTON_TEXT: 'Fresh Label',
        NEXT_PUBLIC_SIDEBAR_BUTTON_URL: 'https://fresh.example.test/',
      }),
    );

    expect(config).toEqual({ text: 'Fresh Label', url: 'https://fresh.example.test/' });
    expect(storage.data.get(SIDEBAR_BUTTON_STORAGE_KEYS.text)).toBe('Fresh Label');
    expect(storage.data.get(SIDEBAR_BUTTON_STORAGE_KEYS.url)).toBe('https://fresh.example.test/');
  });

  it('keeps the cached values when the request fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const storage = staleStorage();
    const notOk: SidebarButtonFetch = async () => ({ ok: false, json: async () => ({}) });
    const offline: SidebarButtonFetch = async () => {
      throw new Error('offline');
    };

    expect(await syncSidebarButtonConfig(storage, notOk)).toEqual({ text: STALE_TEXT, url: STALE_URL });
    expect(await syncSidebarButtonConfig(storage, offline)).toEqual({ text: STALE_TEXT, url: STALE_URL });
    expect(storage.data.get(SIDEBAR_BUTTON_STORAGE_KEYS.text)).toBe(STALE_TEXT);
    expect(storage.data.get(SIDEBAR_BUTTON_STORAGE_KEYS.url)).toBe(STALE_URL);
  });
});
