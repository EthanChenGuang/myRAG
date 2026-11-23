import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  asAdmin,
  asPlainUser,
  makeEnvDir,
  mockAdminGuard,
  newGuardState,
  request,
  silenceConsole,
  type AdminGuardState,
} from '../helpers/admin-guard-fixture';

let state: AdminGuardState;

const ENV_FILE = [
  'NEXT_PUBLIC_AI_PROVIDER=openrouter',
  'NEXT_PUBLIC_OPENAI_MODELS=[{"id":"m1","displayName":"M1"}]',
  'RAG_PRE_CONTEXT=original pre',
  'OPENAI_API_KEY=placeholder-secret-openai',
  '',
].join('\n');

const MODELS_BODY = {
  provider: 'openai',
  openaiModels: [{ id: 'changed', displayName: 'Changed' }],
  openrouterModels: [],
  groqModels: [],
};

async function load<T>(modulePath: string): Promise<T> {
  vi.resetModules();
  mockAdminGuard(state);
  return (await import(modulePath)) as T;
}

function uploadRequest(url: string, field: string, name: string, extra: Record<string, string>) {
  const form = new FormData();
  form.set(field, new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' }));
  for (const [key, value] of Object.entries(extra)) form.set(key, value);
  return new NextRequest(`http://localhost${url}`, { method: 'POST', body: form });
}

function publicFiles(dir: string): string[] {
  const root = path.join(dir, 'public');
  if (!fs.existsSync(root)) return [];
  const found: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else found.push(full);
    }
  };
  walk(root);
  return found;
}

beforeEach(() => {
  state = newGuardState();
  silenceConsole();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('@/lib/supabase/server');
  vi.doUnmock('@/lib/supabase');
  vi.doUnmock('@supabase/supabase-js');
});

describe('/api/config/models', () => {
  it('POST answers 401 without a session and does not touch the env file', async () => {
    const env = makeEnvDir(ENV_FILE);
    const route = await load<typeof import('@/app/api/config/models/route')>('@/app/api/config/models/route');

    const response = await route.POST(request('/api/config/models', { method: 'POST', body: MODELS_BODY }));

    expect(response.status).toBe(401);
    expect(env.read()).toBe(ENV_FILE);
  });

  it('POST answers 403 for a signed-in non-admin and 503 when auth is down', async () => {
    const env = makeEnvDir(ENV_FILE);
    asPlainUser(state);
    const route = await load<typeof import('@/app/api/config/models/route')>('@/app/api/config/models/route');
    expect((await route.POST(request('/api/config/models', { method: 'POST', body: MODELS_BODY }))).status).toBe(403);

    state.session = null;
    state.authThrows = true;
    const down = await load<typeof import('@/app/api/config/models/route')>('@/app/api/config/models/route');
    expect((await down.POST(request('/api/config/models', { method: 'POST', body: MODELS_BODY }))).status).toBe(503);
    expect(env.read()).toBe(ENV_FILE);
  });

  it('POST writes for an admin, and GET stays readable without a session for the chat UI', async () => {
    const env = makeEnvDir(ENV_FILE);
    asAdmin(state);
    const route = await load<typeof import('@/app/api/config/models/route')>('@/app/api/config/models/route');

    expect((await route.POST(request('/api/config/models', { method: 'POST', body: MODELS_BODY }))).status).toBe(200);
    expect(env.read()).toContain('"id":"changed"');

    state.session = null;
    const get = await route.GET(request('/api/config/models'));
    expect(get.status).toBe(200);
    expect(await get.text()).not.toContain('placeholder-secret');
  });
});

describe('/api/config/rag-prompt', () => {
  const PROMPT_BODY = { preContext: 'Answer only from the context.', postContext: 'Cite sources.' };

  it('GET and POST answer 401 without a session and leave the env file alone', async () => {
    const env = makeEnvDir(ENV_FILE);
    const route = await load<typeof import('@/app/api/config/rag-prompt/route')>('@/app/api/config/rag-prompt/route');

    const get = await route.GET(request('/api/config/rag-prompt'));
    const post = await route.POST(request('/api/config/rag-prompt', { method: 'POST', body: PROMPT_BODY }));

    expect(get.status).toBe(401);
    expect(post.status).toBe(401);
    expect(await get.text()).not.toContain('original pre');
    expect(env.read()).toBe(ENV_FILE);
  });

  it('POST answers 403 for a non-admin', async () => {
    const env = makeEnvDir(ENV_FILE);
    asPlainUser(state);
    const route = await load<typeof import('@/app/api/config/rag-prompt/route')>('@/app/api/config/rag-prompt/route');

    const post = await route.POST(request('/api/config/rag-prompt', { method: 'POST', body: PROMPT_BODY }));

    expect(post.status).toBe(403);
    expect(env.read()).toBe(ENV_FILE);
  });

  it('an admin POST saves the sections and the assembled prompt keeps the {{context}} placeholder', async () => {
    const env = makeEnvDir(ENV_FILE);
    asAdmin(state);
    const route = await load<typeof import('@/app/api/config/rag-prompt/route')>('@/app/api/config/rag-prompt/route');

    const post = await route.POST(request('/api/config/rag-prompt', { method: 'POST', body: PROMPT_BODY }));
    const body = await post.json();

    expect(post.status).toBe(200);
    expect(body.assembledPrompt).toContain('{{context}}');
    expect(env.read()).toContain('RAG_PRE_CONTEXT=Answer only from the context.');

    const missing = await route.POST(request('/api/config/rag-prompt', { method: 'POST', body: { postContext: 'x' } }));
    expect(missing.status).toBe(400);
  });
});

describe('/api/config/upload-logo and upload-favicon', () => {
  it('answer 401 without a session and write nothing under public/', async () => {
    const env = makeEnvDir(ENV_FILE);
    const logo = await load<typeof import('@/app/api/config/upload-logo/route')>('@/app/api/config/upload-logo/route');
    const favicon = await load<typeof import('@/app/api/config/upload-favicon/route')>('@/app/api/config/upload-favicon/route');

    const logoResponse = await logo.POST(uploadRequest('/api/config/upload-logo', 'logoFile', 'a.png', { logoType: 'header' }));
    const faviconResponse = await favicon.POST(uploadRequest('/api/config/upload-favicon', 'favicon', 'a.png', {}));

    expect(logoResponse.status).toBe(401);
    expect(faviconResponse.status).toBe(401);
    expect(publicFiles(env.dir)).toEqual([]);
    expect(env.read()).toBe(ENV_FILE);
  });

  it('answer 403 for a non-admin and write nothing', async () => {
    const env = makeEnvDir(ENV_FILE);
    asPlainUser(state);
    const logo = await load<typeof import('@/app/api/config/upload-logo/route')>('@/app/api/config/upload-logo/route');
    const favicon = await load<typeof import('@/app/api/config/upload-favicon/route')>('@/app/api/config/upload-favicon/route');

    expect((await logo.POST(uploadRequest('/api/config/upload-logo', 'logoFile', 'a.png', { logoType: 'ai' }))).status).toBe(403);
    expect((await favicon.POST(uploadRequest('/api/config/upload-favicon', 'favicon', 'a.png', {}))).status).toBe(403);
    expect(publicFiles(env.dir)).toEqual([]);
  });

  it('let an admin upload a logo', async () => {
    const env = makeEnvDir(ENV_FILE);
    asAdmin(state);
    const logo = await load<typeof import('@/app/api/config/upload-logo/route')>('@/app/api/config/upload-logo/route');

    const response = await logo.POST(uploadRequest('/api/config/upload-logo', 'logoFile', 'a.png', { logoType: 'header' }));

    expect(response.status).toBe(200);
    expect(publicFiles(env.dir)).toHaveLength(1);
  });
});

describe('/api/config/connectors', () => {
  const CONNECTIONS = [
    {
      provider: 'google-drive',
      user_id: '00000000-0000-4000-8000-0000000000c1',
      connection_id: 'placeholder-connection-id-1',
      status: 'connected',
      connected_at: '2026-01-01T00:00:00Z',
      last_sync_at: '2026-02-01T00:00:00Z',
      sync_folder_id: 'folder-id-1',
      sync_folder_name: 'Placeholder Private Folder',
      sync_file_ids: ['file-1'],
      sync_file_names: ['placeholder-private-file.pdf'],
      sync_enabled: true,
    },
    {
      provider: 'google-drive',
      user_id: '00000000-0000-4000-8000-0000000000c2',
      connection_id: 'placeholder-connection-id-2',
      status: 'error',
      connected_at: null,
      last_sync_at: null,
      sync_folder_id: null,
      sync_folder_name: null,
      sync_file_ids: null,
      sync_file_names: null,
      sync_enabled: false,
    },
  ];
  const CONFIGS = [
    {
      provider: 'google-drive',
      enabled: true,
      show_on_dashboard: true,
      button_label: 'Drive',
      description: 'Sync Drive',
      supported_file_types: ['pdf'],
      max_files_per_sync: 50,
    },
  ];
  const updates: Array<Record<string, unknown>> = [];

  function mockSupabaseClient() {
    updates.length = 0;
    vi.doMock('@supabase/supabase-js', () => ({
      createClient: () => ({
        from(table: string) {
          const rows = table === 'connector_config' ? CONFIGS : CONNECTIONS;
          const builder = {
            select: () => builder,
            eq: () => Promise.resolve({ error: null }),
            update(values: Record<string, unknown>) {
              updates.push(values);
              return builder;
            },
            order: () => Promise.resolve({ data: rows, error: null }),
          };
          return builder;
        },
      }),
    }));
  }

  async function loadConnectors() {
    vi.resetModules();
    mockAdminGuard(state);
    mockSupabaseClient();
    return import('@/app/api/config/connectors/route');
  }

  it('GET never returns per-user or per-connection rows, for an admin or anyone else', async () => {
    const route = await loadConnectors();

    for (const who of ['anonymous', 'user', 'admin'] as const) {
      state.session = who === 'anonymous' ? null : { id: who === 'admin' ? '00000000-0000-4000-8000-0000000000a1' : '00000000-0000-4000-8000-0000000000b1' };
      const response = await route.GET(request('/api/config/connectors') as never);
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(text).not.toContain('placeholder-connection-id');
      expect(text).not.toContain('Placeholder Private Folder');
      expect(text).not.toContain('placeholder-private-file');
      expect(text).not.toContain('00000000-0000-4000-8000-0000000000c1');
      expect(text).not.toContain('user_connection');
    }
  });

  it('GET gives aggregate statistics to an admin only', async () => {
    const route = await loadConnectors();

    asAdmin(state);
    const admin = await (await route.GET(request('/api/config/connectors') as never)).json();
    expect(admin.view).toBe('admin');
    expect(admin.providers[0].stats).toMatchObject({ connected_users: 2, failed_syncs: 1, total_syncs: 2 });

    state.session = null;
    const anonymous = await (await route.GET(request('/api/config/connectors') as never)).json();
    expect(anonymous.view).toBe('public');
    expect(anonymous.providers[0].stats.connected_users).toBe(0);
    expect(anonymous.providers[0].provider).toBe('google-drive');
  });

  it('PUT refuses an Authorization header that is not an admin, and changes nothing', async () => {
    const route = await loadConnectors();
    const body = { providers: [{ provider: 'google-drive', enabled: false }] };

    const bogus = await route.PUT(
      request('/api/config/connectors', { method: 'PUT', body, headers: { authorization: 'Bearer anything' } }) as never,
    );
    const anonymous = await route.PUT(request('/api/config/connectors', { method: 'PUT', body }) as never);
    asPlainUser(state);
    const plain = await route.PUT(request('/api/config/connectors', { method: 'PUT', body }) as never);

    expect(bogus.status).toBe(401);
    expect(anonymous.status).toBe(401);
    expect(plain.status).toBe(403);
    expect(updates).toEqual([]);
  });

  it('PUT lets an admin update a supported provider and refuses an unknown one', async () => {
    const route = await loadConnectors();
    asAdmin(state);

    const ok = await route.PUT(
      request('/api/config/connectors', { method: 'PUT', body: { providers: [{ provider: 'google-drive', enabled: false }] } }) as never,
    );
    expect(ok.status).toBe(200);
    expect(updates).toHaveLength(1);

    const bad = await route.PUT(
      request('/api/config/connectors', { method: 'PUT', body: { providers: [{ provider: 'unknown', enabled: false }] } }) as never,
    );
    expect(bad.status).toBe(400);
    expect(updates).toHaveLength(1);
  });
});
