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
import { loadLikeNext } from '../helpers/next-env-loader';

const ENV_FILE = [
  'NEXT_PUBLIC_APP_NAME=Demo',
  'NEXT_PUBLIC_SHOW_SUGGESTIONS=true',
  'SUPABASE_SERVICE_ROLE_KEY=placeholder-secret-service-role',
  'OPENAI_API_KEY=placeholder-secret-openai',
  'STRIPE_WEBHOOK_SECRET=placeholder-secret-webhook',
  'MCP_ZAPIER_ENDPOINT=https://hooks.example.test/mcp/placeholder-secret-path',
  'MCP_CUSTOM_SERVERS=[{"endpoint":"https://x.example.test/placeholder-secret-custom"}]',
  'UNLISTED_INTERNAL_FLAG=visible-only-if-listed',
  'NEXT_PUBLIC_SIDEBAR_BUTTON_URL=https://user:placeholder-secret-pw@links.example.test/x',
  'NEXT_PUBLIC_SITE_TITLE=Docs',
  'DATABASE_URL=postgres://user:placeholder-secret-db@db.example.test/app',
  'SENTRY_DSN=https://placeholder-secret-dsn@o0.example.test/1',
  '',
].join('\n');

let state: AdminGuardState;

async function load() {
  vi.resetModules();
  mockAdminGuard(state);
  return import('@/app/api/config/route');
}

describe('/api/config', () => {
  beforeEach(() => {
    state = newGuardState();
    silenceConsole();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('@/lib/supabase/server');
    vi.doUnmock('@/lib/supabase');
  });

  describe('authentication', () => {
    it('GET and POST answer 401 without a session and leave the env file alone', async () => {
      const env = makeEnvDir(ENV_FILE);
      const route = await load();

      const get = await route.GET(request('/api/config'));
      const post = await route.POST(request('/api/config', { method: 'POST', body: { config: { NEXT_PUBLIC_APP_NAME: 'x' } } }));

      expect(get.status).toBe(401);
      expect(post.status).toBe(401);
      expect(await get.text()).not.toContain('placeholder-secret');
      expect(env.read()).toBe(ENV_FILE);
    });

    it('GET and POST answer 403 for a signed-in non-admin', async () => {
      const env = makeEnvDir(ENV_FILE);
      asPlainUser(state);
      const route = await load();

      const get = await route.GET(request('/api/config'));
      const post = await route.POST(request('/api/config', { method: 'POST', body: { config: { NEXT_PUBLIC_APP_NAME: 'x' } } }));

      expect(get.status).toBe(403);
      expect(post.status).toBe(403);
      expect(env.read()).toBe(ENV_FILE);
    });

    it('a throwing auth lookup answers 503 on GET and POST, never 200', async () => {
      const env = makeEnvDir(ENV_FILE);
      state.authThrows = true;
      const route = await load();

      const get = await route.GET(request('/api/config'));
      const post = await route.POST(request('/api/config', { method: 'POST', body: { config: { NEXT_PUBLIC_APP_NAME: 'x' } } }));

      expect(get.status).toBe(503);
      expect(post.status).toBe(503);
      expect(await get.text()).not.toContain('placeholder-secret');
      expect(env.read()).toBe(ENV_FILE);
    });

    it('a failing admin_users lookup answers 503', async () => {
      makeEnvDir(ENV_FILE);
      asAdmin(state);
      state.lookupFails = true;
      const route = await load();

      expect((await route.GET(request('/api/config'))).status).toBe(503);
    });
  });

  describe('GET as an admin', () => {
    it('never returns a value whose name looks like a secret', async () => {
      makeEnvDir(ENV_FILE);
      asAdmin(state);
      const route = await load();

      const response = await route.GET(request('/api/config'));
      const text = await response.text();
      const body = JSON.parse(text);

      expect(response.status).toBe(200);
      expect(text).not.toContain('placeholder-secret');
      expect(body.config.NEXT_PUBLIC_APP_NAME).toBe('Demo');
      expect(body.config.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
      expect(body.config.OPENAI_API_KEY).toBeUndefined();
      expect(body.secrets).toBeUndefined();
      const names = Object.keys(body.config);
      for (const hidden of ['SUPABASE_SERVICE_ROLE_KEY', 'OPENAI_API_KEY', 'STRIPE_WEBHOOK_SECRET', 'MCP_ZAPIER_ENDPOINT', 'MCP_CUSTOM_SERVERS', 'DATABASE_URL', 'SENTRY_DSN']) {
        expect(names).not.toContain(hidden);
        expect(text).not.toContain(hidden);
      }
    });

    it('drops a value that carries credentials in a URL even under an allowed name', async () => {
      makeEnvDir(ENV_FILE);
      asAdmin(state);
      const route = await load();

      const body = await (await route.GET(request('/api/config'))).json();

      expect(body.config.NEXT_PUBLIC_SIDEBAR_BUTTON_URL).toBeUndefined();
      expect(body.config.NEXT_PUBLIC_SITE_TITLE).toBe('Docs');
    });

    it('only returns names the Config UI can write back', async () => {
      makeEnvDir(ENV_FILE);
      asAdmin(state);
      const route = await load();

      const body = await (await route.GET(request('/api/config'))).json();

      expect(body.config.UNLISTED_INTERNAL_FLAG).toBeUndefined();
    });
  });

  describe('POST as an admin', () => {
    it('writes allowlisted names and leaves the other lines alone', async () => {
      const env = makeEnvDir(ENV_FILE);
      asAdmin(state);
      const route = await load();

      const response = await route.POST(
        request('/api/config', {
          method: 'POST',
          body: { config: { NEXT_PUBLIC_APP_NAME: 'Renamed', NEXT_PUBLIC_WEB_SEARCH_ENABLED: true } },
        }),
      );

      expect(response.status).toBe(200);
      const written = env.read();
      expect(written).toContain('NEXT_PUBLIC_APP_NAME=Renamed');
      expect(written).toContain('NEXT_PUBLIC_WEB_SEARCH_ENABLED=true');
      expect(written).toContain('OPENAI_API_KEY=placeholder-secret-openai');
    });

    it.each([
      'SUPABASE_SERVICE_ROLE_KEY',
      'OPENAI_API_KEY',
      'STRIPE_WEBHOOK_SECRET',
      'ADMIN_PASSWORD',
      'MCP_ZAPIER_ENDPOINT',
      'MCP_CUSTOM_SERVERS',
      'NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE',
      'RAG_EVAL_ENDPOINT_ENABLED',
      'RAG_SIDECAR_URL',
    ])('refuses to write %s through the app route', async (name) => {
      const env = makeEnvDir(ENV_FILE);
      asAdmin(state);
      const route = await load();

      const response = await route.POST(request('/api/config', { method: 'POST', body: { config: { [name]: 'x' } } }));

      expect(response.status).toBe(400);
      expect(env.read()).toBe(ENV_FILE);
    });

    it('a name outside the allowlist answers 400 and leaves the env file unchanged', async () => {
      const env = makeEnvDir(ENV_FILE);
      asAdmin(state);
      const route = await load();

      const response = await route.POST(
        request('/api/config', { method: 'POST', body: { config: { NODE_OPTIONS: '--require /tmp/x.js' } } }),
      );

      expect(response.status).toBe(400);
      expect((await response.json()).rejected).toEqual(['NODE_OPTIONS']);
      expect(env.read()).toBe(ENV_FILE);
    });

    it('one bad name rejects the whole request, so no allowlisted name is written', async () => {
      const env = makeEnvDir(ENV_FILE);
      asAdmin(state);
      const route = await load();

      const response = await route.POST(
        request('/api/config', {
          method: 'POST',
          body: { config: { NEXT_PUBLIC_APP_NAME: 'Renamed', LD_PRELOAD: '/tmp/x.so' } },
        }),
      );

      expect(response.status).toBe(400);
      expect(env.read()).toBe(ENV_FILE);
    });

    it('a value with a line break cannot smuggle a second variable', async () => {
      const env = makeEnvDir(ENV_FILE);
      asAdmin(state);
      const route = await load();

      const response = await route.POST(
        request('/api/config', {
          method: 'POST',
          body: { config: { NEXT_PUBLIC_APP_NAME: 'Demo\nNODE_OPTIONS=--inspect' } },
        }),
      );

      expect(response.status).toBe(400);
      expect(env.read()).toBe(ENV_FILE);
    });

    it('a carriage return in a value is rejected and the env file is unchanged', async () => {
      const env = makeEnvDir(ENV_FILE);
      asAdmin(state);
      const route = await load();

      const response = await route.POST(
        request('/api/config', {
          method: 'POST',
          body: { config: { NEXT_PUBLIC_APP_NAME: 'Demo\rNEXT_PUBLIC_SUPABASE_URL=https://attacker' } },
        }),
      );

      expect(response.status).toBe(400);
      expect(env.read()).toBe(ENV_FILE);
    });

    it.each(['${SUPABASE_SERVICE_ROLE_KEY}', '$SUPABASE_SERVICE_ROLE_KEY', '$`', '$&', '${X:-y}'])(
      'a value containing %s loads back as that literal text and never expands',
      async (value) => {
        const env = makeEnvDir(ENV_FILE);
        asAdmin(state);
        const route = await load();

        const response = await route.POST(request('/api/config', { method: 'POST', body: { config: { NEXT_PUBLIC_APP_NAME: value } } }));

        expect(response.status).toBe(200);
        const loaded = loadLikeNext(env.read());
        expect(loaded.NEXT_PUBLIC_APP_NAME).toBe(value);
        const before = loadLikeNext(ENV_FILE);
        for (const [name, original] of Object.entries(before)) {
          if (name !== 'NEXT_PUBLIC_APP_NAME') expect(loaded[name]).toBe(original);
        }
        expect(Object.keys(loaded).sort()).toEqual(Object.keys(before).sort());
      },
    );

    it('structured JSON values with quotes and hashes are written so they load back as the same data', async () => {
      const env = makeEnvDir(ENV_FILE);
      asAdmin(state);
      const route = await load();
      const groups = [{ title: "O'Brien #1", items: ['`a`', '"b"', '$c'] }];

      const response = await route.POST(
        request('/api/config', { method: 'POST', body: { config: { NEXT_PUBLIC_SUGGESTION_GROUPS: JSON.stringify(groups, null, 2) } } }),
      );

      expect(response.status).toBe(200);
      expect(JSON.parse(loadLikeNext(env.read()).NEXT_PUBLIC_SUGGESTION_GROUPS)).toEqual(groups);
    });

    it('NEXT_PUBLIC_SITE_URL is not writable over the web', async () => {
      const env = makeEnvDir(ENV_FILE);
      asAdmin(state);
      const route = await load();

      const response = await route.POST(
        request('/api/config', { method: 'POST', body: { config: { NEXT_PUBLIC_SITE_URL: 'https://attacker.example' } } }),
      );

      expect(response.status).toBe(400);
      expect((await response.json()).rejected).toEqual(['NEXT_PUBLIC_SITE_URL']);
      expect(env.read()).toBe(ENV_FILE);
    });

    it('NEXT_PUBLIC_MCP_YOLO_MODE_ENABLED is not writable over the web', async () => {
      const env = makeEnvDir(ENV_FILE);
      asAdmin(state);
      const route = await load();

      const response = await route.POST(
        request('/api/config', { method: 'POST', body: { config: { NEXT_PUBLIC_MCP_YOLO_MODE_ENABLED: 'true' } } }),
      );

      expect(response.status).toBe(400);
      expect((await response.json()).rejected).toEqual(['NEXT_PUBLIC_MCP_YOLO_MODE_ENABLED']);
      expect(env.read()).toBe(ENV_FILE);
    });

    it('a body without a config object answers 400', async () => {
      const env = makeEnvDir(ENV_FILE);
      asAdmin(state);
      const route = await load();

      const flat = await route.POST(request('/api/config', { method: 'POST', body: { NEXT_PUBLIC_APP_NAME: 'x' } }));

      expect(flat.status).toBe(400);
      expect(env.read()).toBe(ENV_FILE);
    });
  });
});
