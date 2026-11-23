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

const SECRET_PATH = 'placeholder-secret-path';
const SECRET_TOKEN = 'placeholder-secret-token';
const SECRET_PASSWORD = 'placeholder-secret-password';
const ZAPIER_ENDPOINT = `https://hooks.example.test/mcp/${SECRET_PATH}?key=placeholder-secret-query`;

const CUSTOM_SERVERS = [
  {
    id: 'custom-one',
    name: 'Custom One',
    endpoint: `https://user:${SECRET_PASSWORD}@tools.example.test/mcp/${SECRET_PATH}`,
    type: 'http',
    enabled: true,
    authentication: { type: 'bearer', credentials: { token: SECRET_TOKEN } },
    settings: { timeout: 1000, retryAttempts: 1, enabledInChat: true, enabledInEmbed: false, yoloMode: false },
  },
];

const ENV_FILE = `MCP_CUSTOM_SERVERS=${JSON.stringify(CUSTOM_SERVERS)}\nMCP_ZAPIER_ENDPOINT=${ZAPIER_ENDPOINT}\n`;

let state: AdminGuardState;

async function load<T>(modulePath: string): Promise<T> {
  vi.resetModules();
  mockAdminGuard(state);
  vi.doMock('@/lib/env', () => ({
    env: { MCP_ZAPIER_ENDPOINT: ZAPIER_ENDPOINT, NEXT_PUBLIC_MCP_YOLO_MODE_ENABLED: 'false' },
  }));
  return (await import(modulePath)) as T;
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

function assertNoSecrets(text: string) {
  for (const secret of [SECRET_PATH, SECRET_TOKEN, SECRET_PASSWORD, 'placeholder-secret-query']) {
    expect(text).not.toContain(secret);
  }
}

function assertNoWildcardCors(response: Response) {
  expect(response.headers.get('access-control-allow-origin')).not.toBe('*');
}

beforeEach(() => {
  state = newGuardState();
  silenceConsole();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.doUnmock('@/lib/supabase/server');
  vi.doUnmock('@/lib/supabase');
  vi.doUnmock('@/lib/env');
  vi.doUnmock('@/lib/mcp/universal-client');
});

describe('/api/mcp/servers', () => {
  const NEW_SERVER = { id: 'custom-two', name: 'Two', endpoint: 'https://two.example.test/mcp' };

  it('answers 401 to every method without a session and never discloses an endpoint or credential', async () => {
    const env = makeEnvDir(ENV_FILE);
    const list = await load<typeof import('@/app/api/mcp/servers/route')>('@/app/api/mcp/servers/route');
    const item = await load<typeof import('@/app/api/mcp/servers/[id]/route')>('@/app/api/mcp/servers/[id]/route');

    const responses = [
      await list.GET(request('/api/mcp/servers')),
      await list.POST(request('/api/mcp/servers', { method: 'POST', body: NEW_SERVER })),
      await item.GET(request('/api/mcp/servers/custom-one'), ctx('custom-one')),
      await item.PUT(request('/api/mcp/servers/custom-one', { method: 'PUT', body: { ...NEW_SERVER, id: 'custom-one' } }), ctx('custom-one')),
      await item.DELETE(request('/api/mcp/servers/custom-one', { method: 'DELETE' }), ctx('custom-one')),
      await item.POST(request('/api/mcp/servers/custom-one', { method: 'POST', body: { action: 'test' } }), ctx('custom-one')),
    ];

    for (const response of responses) {
      expect(response.status).toBe(401);
      assertNoSecrets(await response.text());
      assertNoWildcardCors(response);
    }
    expect(env.read()).toBe(ENV_FILE);
  });

  it('answers 403 to a signed-in non-admin on every method', async () => {
    const env = makeEnvDir(ENV_FILE);
    asPlainUser(state);
    const list = await load<typeof import('@/app/api/mcp/servers/route')>('@/app/api/mcp/servers/route');
    const item = await load<typeof import('@/app/api/mcp/servers/[id]/route')>('@/app/api/mcp/servers/[id]/route');

    expect((await list.GET(request('/api/mcp/servers'))).status).toBe(403);
    expect((await list.POST(request('/api/mcp/servers', { method: 'POST', body: NEW_SERVER }))).status).toBe(403);
    expect((await item.DELETE(request('/api/mcp/servers/custom-one', { method: 'DELETE' }), ctx('custom-one'))).status).toBe(403);
    expect(env.read()).toBe(ENV_FILE);
  });

  it('answers 503 when the auth lookup throws', async () => {
    makeEnvDir(ENV_FILE);
    state.authThrows = true;
    const list = await load<typeof import('@/app/api/mcp/servers/route')>('@/app/api/mcp/servers/route');

    expect((await list.GET(request('/api/mcp/servers'))).status).toBe(503);
  });

  it('gives an admin the host and a hasCredentials flag, never the endpoint path, query or credentials', async () => {
    makeEnvDir(ENV_FILE);
    asAdmin(state);
    const list = await load<typeof import('@/app/api/mcp/servers/route')>('@/app/api/mcp/servers/route');
    const item = await load<typeof import('@/app/api/mcp/servers/[id]/route')>('@/app/api/mcp/servers/[id]/route');

    const listResponse = await list.GET(request('/api/mcp/servers'));
    const listText = await listResponse.text();
    const itemResponse = await item.GET(request('/api/mcp/servers/custom-one'), ctx('custom-one'));
    const itemText = await itemResponse.text();

    expect(listResponse.status).toBe(200);
    expect(itemResponse.status).toBe(200);
    assertNoSecrets(listText);
    assertNoSecrets(itemText);
    assertNoWildcardCors(listResponse);
    const servers = JSON.parse(listText).servers as Array<Record<string, unknown>>;
    const custom = servers.find((server) => server.id === 'custom-one');
    expect(custom).toMatchObject({ host: 'tools.example.test', hasCredentials: true, authentication: { type: 'bearer' } });
    expect(custom).not.toHaveProperty('endpoint');
    expect(servers.find((server) => server.id === 'zapier')).toMatchObject({ host: 'hooks.example.test' });
  });

  it('POST and PUT by an admin never echo the endpoint or credentials back', async () => {
    const env = makeEnvDir(ENV_FILE);
    asAdmin(state);
    const list = await load<typeof import('@/app/api/mcp/servers/route')>('@/app/api/mcp/servers/route');
    const item = await load<typeof import('@/app/api/mcp/servers/[id]/route')>('@/app/api/mcp/servers/[id]/route');

    const created = await list.POST(
      request('/api/mcp/servers', {
        method: 'POST',
        body: {
          ...NEW_SERVER,
          endpoint: `https://two.example.test/${SECRET_PATH}`,
          authentication: { type: 'bearer', credentials: { token: SECRET_TOKEN } },
        },
      }),
    );
    expect(created.status).toBe(201);
    assertNoSecrets(await created.text());
    expect(env.read()).toContain('custom-two');

    const updated = await item.PUT(
      request('/api/mcp/servers/custom-one', {
        method: 'PUT',
        body: { id: 'custom-one', name: 'Renamed', authentication: { type: 'bearer' } },
      }),
      ctx('custom-one'),
    );
    expect(updated.status).toBe(200);
    assertNoSecrets(await updated.text());
    const stored = env.read();
    expect(stored).toContain('Renamed');
    expect(stored).toContain(SECRET_TOKEN);
    expect(stored).toContain('tools.example.test');
  });

  it('has no CORS preflight handler that allows every origin', async () => {
    const list = await load<typeof import('@/app/api/mcp/servers/route')>('@/app/api/mcp/servers/route');
    const item = await load<typeof import('@/app/api/mcp/servers/[id]/route')>('@/app/api/mcp/servers/[id]/route');
    const test = await load<typeof import('@/app/api/mcp/servers/[id]/test/route')>('@/app/api/mcp/servers/[id]/test/route');

    for (const route of [list, item, test] as Array<Record<string, unknown>>) {
      expect(route.OPTIONS).toBeUndefined();
    }
  });
});

describe('ME-02: credentials stay bound to the endpoint they were stored for', () => {
  const ATTACKER = 'https://attacker.example.test/collect';

  async function putServer(body: Record<string, unknown>) {
    const item = await load<typeof import('@/app/api/mcp/servers/[id]/route')>('@/app/api/mcp/servers/[id]/route');
    return item.PUT(request('/api/mcp/servers/custom-one', { method: 'PUT', body: { id: 'custom-one', name: 'Custom One', ...body } }), ctx('custom-one'));
  }

  async function probe() {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
        calls.push({ url: String(url), headers: { ...(init?.headers ?? {}) } });
        return new Response('{}', { status: 200 });
      }),
    );
    const test = await load<typeof import('@/app/api/mcp/servers/[id]/test/route')>('@/app/api/mcp/servers/[id]/test/route');
    const item = await load<typeof import('@/app/api/mcp/servers/[id]/route')>('@/app/api/mcp/servers/[id]/route');
    await test.POST(request('/api/mcp/servers/custom-one/test', { method: 'POST', body: { action: 'test' } }), ctx('custom-one'));
    await item.POST(request('/api/mcp/servers/custom-one', { method: 'POST', body: { action: 'test' } }), ctx('custom-one'));
    await item.POST(request('/api/mcp/servers/custom-one', { method: 'POST', body: { action: 'discover' } }), ctx('custom-one'));
    return calls;
  }

  it('a PUT that moves the endpoint to another origin drops the stored credentials, so test never sends them there', async () => {
    const env = makeEnvDir(ENV_FILE);
    asAdmin(state);

    const response = await putServer({ endpoint: ATTACKER, authentication: { type: 'bearer' } });
    expect(response.status).toBe(200);
    expect(env.read()).not.toContain(SECRET_TOKEN);

    const calls = await probe();
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.url.startsWith(ATTACKER)).toBe(true);
      expect(JSON.stringify(call.headers)).not.toContain(SECRET_TOKEN);
      expect(call.headers.Authorization).toBeUndefined();
    }
  });

  it('new credentials sent with the new endpoint are kept and bound to it', async () => {
    const env = makeEnvDir(ENV_FILE);
    asAdmin(state);

    const response = await putServer({ endpoint: ATTACKER, authentication: { type: 'bearer', credentials: { token: 'placeholder-new-token' } } });
    expect(response.status).toBe(200);
    expect(env.read()).toContain('placeholder-new-token');
    expect(env.read()).not.toContain(SECRET_TOKEN);

    const calls = await probe();
    expect(calls[0].headers.Authorization).toBe('Bearer placeholder-new-token');
  });

  it('an update that keeps the same origin keeps the stored credentials, even with a new path', async () => {
    const env = makeEnvDir(ENV_FILE);
    asAdmin(state);

    const response = await putServer({ endpoint: 'https://tools.example.test/other-path', authentication: { type: 'bearer' } });
    expect(response.status).toBe(200);
    expect(env.read()).toContain(SECRET_TOKEN);

    const calls = await probe();
    expect(calls[0].headers.Authorization).toBe(`Bearer ${SECRET_TOKEN}`);
  });

  it('a stored server whose credentials were bound to another origin never sends them', async () => {
    const bound = [{ ...CUSTOM_SERVERS[0], endpoint: ATTACKER, authentication: { type: 'bearer', credentials: { token: SECRET_TOKEN }, credentialsOrigin: 'https://tools.example.test' } }];
    makeEnvDir(`MCP_CUSTOM_SERVERS=${JSON.stringify(bound)}\n`);
    asAdmin(state);

    const calls = await probe();
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(JSON.stringify(call.headers)).not.toContain(SECRET_TOKEN);
  });

  it('a client cannot set the binding itself', async () => {
    const env = makeEnvDir(ENV_FILE);
    asAdmin(state);

    await putServer({
      endpoint: ATTACKER,
      authentication: { type: 'bearer', credentials: { token: 'placeholder-new-token' }, credentialsOrigin: 'https://elsewhere.example.test' },
    });

    expect(env.read()).toContain('https://attacker.example.test');
    expect(env.read()).not.toContain('elsewhere.example.test');
  });
});

describe('HI-01: MCP server writes cannot splice the env file', () => {
  const BASE = 'SUPABASE_SERVICE_ROLE_KEY=placeholder-secret-service-role\nNEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321\n';

  it('a server name containing $` or $& does not duplicate or copy env lines', async () => {
    const env = makeEnvDir(BASE);
    asAdmin(state);
    const list = await load<typeof import('@/app/api/mcp/servers/route')>('@/app/api/mcp/servers/route');

    for (const [index, name] of ['$`', '$&', "$'", "O'Brien #1 `x`"].entries()) {
      const response = await list.POST(
        request('/api/mcp/servers', { method: 'POST', body: { id: `s${index}`, name, endpoint: `https://s${index}.example.test/mcp` } }),
      );
      expect(response.status).toBe(201);
    }

    const loaded = loadLikeNext(env.read());
    expect(Object.keys(loaded).sort()).toEqual(['MCP_CUSTOM_SERVERS', 'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);
    expect((JSON.parse(loaded.MCP_CUSTOM_SERVERS) as Array<{ name: string }>).map((server) => server.name)).toEqual(['$`', '$&', "$'", "O'Brien #1 `x`"]);
    expect(loaded.MCP_CUSTOM_SERVERS).not.toContain('placeholder-secret-service-role');
  });

  it('a carriage return in a server field cannot inject a variable', async () => {
    const env = makeEnvDir(BASE);
    asAdmin(state);
    const list = await load<typeof import('@/app/api/mcp/servers/route')>('@/app/api/mcp/servers/route');

    const response = await list.POST(
      request('/api/mcp/servers', {
        method: 'POST',
        body: { id: 'x', name: 'a\rNEXT_PUBLIC_SUPABASE_URL=https://attacker', endpoint: 'https://x.example.test/mcp' },
      }),
    );

    expect([201, 400]).toContain(response.status);
    const loaded = loadLikeNext(env.read());
    expect(loaded.NEXT_PUBLIC_SUPABASE_URL).toBe('http://127.0.0.1:54321');
    expect(Object.keys(loaded).sort()).toEqual(['MCP_CUSTOM_SERVERS', 'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].filter((name) => name in loaded).sort());
  });
});

describe('/api/mcp/servers/[id]/test', () => {
  it('answers 401 and 403 without admin rights and never calls the stored host', async () => {
    makeEnvDir(ENV_FILE);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const route = await load<typeof import('@/app/api/mcp/servers/[id]/test/route')>('@/app/api/mcp/servers/[id]/test/route');
    const call = () => route.POST(request('/api/mcp/servers/custom-one/test', { method: 'POST', body: { action: 'test' } }), ctx('custom-one'));

    expect((await call()).status).toBe(401);
    asPlainUser(state);
    expect((await call()).status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('lets an admin test a stored server and strips URLs from failure messages', async () => {
    makeEnvDir(ENV_FILE);
    asAdmin(state);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error(`connect ECONNREFUSED https://tools.example.test/mcp/${SECRET_PATH}`);
      }),
    );
    const route = await load<typeof import('@/app/api/mcp/servers/[id]/test/route')>('@/app/api/mcp/servers/[id]/test/route');

    const response = await route.POST(
      request('/api/mcp/servers/custom-one/test', { method: 'POST', body: { action: 'test' } }),
      ctx('custom-one'),
    );
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(text).success).toBe(false);
    assertNoSecrets(text);
  });
});

describe('/api/mcp/health', () => {
  function mockClient() {
    vi.doMock('@/lib/mcp/universal-client', () => ({
      UniversalMcpClient: {
        getInstance: () => ({
          discoverAllTools: async () => [{ name: 'tool-a' }],
          getConnectionStatus: () => [{ connected: true }],
          getConnectionHealth: async () => [
            {
              server: 'zapier',
              connected: true,
              endpoint: ZAPIER_ENDPOINT,
              lastError: `failed at ${ZAPIER_ENDPOINT}`,
              diagnostics: {
                canConnect: true,
                canListTools: true,
                canExecuteTools: false,
                responseTime: 5,
                toolCount: 1,
                errorDetails: `bad response from ${ZAPIER_ENDPOINT}`,
              },
            },
          ],
        }),
      },
    }));
  }

  it('answers 401 and 403 without admin rights and does not probe the endpoint', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    mockClient();
    const route = await load<typeof import('@/app/api/mcp/health/route')>('@/app/api/mcp/health/route');

    const anonymous = await route.GET(request('/api/mcp/health'));
    asPlainUser(state);
    const plain = await route.GET(request('/api/mcp/health'));

    expect(anonymous.status).toBe(401);
    expect(plain.status).toBe(403);
    assertNoSecrets(await anonymous.text());
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns only the host for an admin, with no secret in the endpoint, errors or recommendations', async () => {
    asAdmin(state);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })));
    mockClient();
    const route = await load<typeof import('@/app/api/mcp/health/route')>('@/app/api/mcp/health/route');

    const response = await route.GET(request('/api/mcp/health'));
    const text = await response.text();

    expect(response.status).toBe(200);
    assertNoSecrets(text);
    assertNoWildcardCors(response);
    expect(JSON.parse(text).zapier.endpoint).toBe('hooks.example.test');
  });
});

describe('mcp server-redact helpers', () => {
  it('toPublicServer drops endpoint userinfo, path and query', async () => {
    const { toPublicServer, redactUrls } = await import('@/lib/mcp/server-redact');

    const publicServer = toPublicServer({
      id: 'x',
      name: 'X',
      endpoint: 'https://user:pw@host.example.test:8443/a/b?k=v',
      authentication: { type: 'basic', credentials: { username: 'u', password: 'p' } },
    });

    expect(publicServer.host).toBe('host.example.test:8443');
    expect(JSON.stringify(publicServer)).not.toMatch(/user:pw|\/a\/b|k=v|"p"/);
    expect(redactUrls('fail wss://h.example.test/s3cr3t now')).toBe('fail [url] now');
  });
});
