import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SIDEBAR_BUTTON_STORAGE_KEYS,
  syncSidebarButtonConfig,
  type SidebarButtonFetch,
  type SidebarButtonStorage,
} from '@/lib/sidebar-button-config';

const STALE_TEXT = 'Stale Label';
const STALE_URL = 'https://stale.example.test/';
const FRESH_TEXT = 'Fresh Label';
const FRESH_URL = 'https://fresh.example.test/';

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

function expectNoCache(storage: ReturnType<typeof memoryStorage>) {
  expect(storage.data.has(SIDEBAR_BUTTON_STORAGE_KEYS.text)).toBe(false);
  expect(storage.data.has(SIDEBAR_BUTTON_STORAGE_KEYS.url)).toBe(false);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sidebar button config', () => {
  it('hides the button and clears the stale cache when both server values are empty', async () => {
    const storage = staleStorage();
    expect(await syncSidebarButtonConfig(storage, serverAnswering({}))).toBeNull();
    expectNoCache(storage);
  });

  it('hides the button when only the text is set', async () => {
    const storage = staleStorage();
    const config = await syncSidebarButtonConfig(storage, serverAnswering({ NEXT_PUBLIC_SIDEBAR_BUTTON_TEXT: FRESH_TEXT }));
    expect(config).toBeNull();
    expectNoCache(storage);
  });

  it('hides the button when only the URL is set', async () => {
    const storage = staleStorage();
    const config = await syncSidebarButtonConfig(storage, serverAnswering({ NEXT_PUBLIC_SIDEBAR_BUTTON_URL: FRESH_URL }));
    expect(config).toBeNull();
    expectNoCache(storage);
  });

  it('treats whitespace-only values as empty', async () => {
    const config = await syncSidebarButtonConfig(
      memoryStorage(),
      serverAnswering({ NEXT_PUBLIC_SIDEBAR_BUTTON_TEXT: '   ', NEXT_PUBLIC_SIDEBAR_BUTTON_URL: FRESH_URL }),
    );
    expect(config).toBeNull();
  });

  it('shows the button when both values are set and writes nothing to storage', async () => {
    const storage = staleStorage();
    const config = await syncSidebarButtonConfig(
      storage,
      serverAnswering({ NEXT_PUBLIC_SIDEBAR_BUTTON_TEXT: FRESH_TEXT, NEXT_PUBLIC_SIDEBAR_BUTTON_URL: FRESH_URL }),
    );
    expect(config).toEqual({ text: FRESH_TEXT, url: FRESH_URL });
    expectNoCache(storage);
  });

  it('accepts a same-site path as the URL', async () => {
    const config = await syncSidebarButtonConfig(
      memoryStorage(),
      serverAnswering({ NEXT_PUBLIC_SIDEBAR_BUTTON_TEXT: FRESH_TEXT, NEXT_PUBLIC_SIDEBAR_BUTTON_URL: '/help' }),
    );
    expect(config).toEqual({ text: FRESH_TEXT, url: '/help' });
  });

  it.each(['javascript:void(0)', '//other.example.test/', 'not a url', 'ftp://files.example.test/'])(
    'hides the button for the URL %s',
    async (url) => {
      const config = await syncSidebarButtonConfig(
        memoryStorage(),
        serverAnswering({ NEXT_PUBLIC_SIDEBAR_BUTTON_TEXT: FRESH_TEXT, NEXT_PUBLIC_SIDEBAR_BUTTON_URL: url }),
      );
      expect(config).toBeNull();
    },
  );

  describe('when the request fails it hides the button and never shows the cached values', () => {
    const failures: Record<string, SidebarButtonFetch> = {
      'non-OK response': async () => ({ ok: false, json: async () => ({ value: FRESH_TEXT }) }),
      'network error': async () => {
        throw new Error('offline');
      },
      'bad JSON': async () => ({
        ok: true,
        json: async () => {
          throw new SyntaxError('Unexpected token');
        },
      }),
    };

    it.each(Object.keys(failures))('%s', async (kind) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const storage = staleStorage();
      expect(await syncSidebarButtonConfig(storage, failures[kind])).toBeNull();
      expectNoCache(storage);
    });

    it('a failure on one of the two values hides the button', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const good = serverAnswering({ NEXT_PUBLIC_SIDEBAR_BUTTON_TEXT: FRESH_TEXT, NEXT_PUBLIC_SIDEBAR_BUTTON_URL: FRESH_URL });
      const urlFails: SidebarButtonFetch = async (input) =>
        input.includes('NEXT_PUBLIC_SIDEBAR_BUTTON_URL') ? { ok: false, json: async () => ({}) } : good(input);
      expect(await syncSidebarButtonConfig(staleStorage(), urlFails)).toBeNull();
    });
  });
});
