import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '@/lib/env';
import { TWO_TENANT_IDS } from '../../../eval/harness/two-tenant.mts';
import { chatRequest } from '../../helpers/chat-route-fakes';
import { startRouteFixture, type RouteFixture } from '../../helpers/route-fixture';

/**
 * Plan-check B4 through the real chat route and the real deployment-mode resolver: in multi-tenant mode a local
 * stand-in for Lakera receives no request unless RAG_INJECTION_LAKERA_MULTI_TENANT_ACK is set.
 */

const h = await vi.hoisted(async () => {
  const fakes = await import('../../helpers/chat-route-fakes');
  const session: { userId: string | null } = { userId: null };
  return {
    capture: fakes.createStreamTextCapture({ deltas: ['synthetic answer'] }),
    exa: fakes.createExaFake(),
    session,
    ssr: {
      auth: {
        getUser: async () => ({ data: { user: session.userId ? { id: session.userId } : null }, error: null }),
      },
    },
  };
});

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  streamText: h.capture.streamText,
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.ssr }));
vi.mock('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: () => (modelId: string) => ({ specificationVersion: 'v3', provider: 'fake', modelId }),
}));
vi.mock('exa-js', () => ({ default: h.exa.Exa }));

const { userA } = TWO_TENANT_IDS;
const QUESTION = 'Two tenant isolation canary phrase: alpha personal notes';
const SECURITY_VARS = [
  'RAG_INJECTION_CHECK',
  'RAG_INJECTION_LAKERA',
  'RAG_INJECTION_LAKERA_MULTI_TENANT_ACK',
  'LAKERA_GUARD_API_KEY',
  'LAKERA_GUARD_BASE_URL',
] as const;

function configuredModelId(): string {
  const models = JSON.parse(env.NEXT_PUBLIC_OPENROUTER_MODELS) as Array<{ id: string }>;
  return models.map((model) => model.id).find((candidate) => !/gpt-4|o1|chatgpt/.test(candidate) && !candidate.includes('claude')) as string;
}

describe('Lakera through the chat route in multi-tenant mode (B4)', () => {
  let fixture: RouteFixture;
  let server: http.Server;
  let baseUrl: string;
  let guardRequests = 0;
  const model = configuredModelId();

  beforeAll(async () => {
    fixture = await startRouteFixture({ deploymentMode: 'multi-tenant', twoTenant: true });
    server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/v2/guard') guardRequests += 1;
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ breakdown: [{ detector_type: 'prompt_attack', detected: false }] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const name of SECURITY_VARS) delete process.env[name];
    await fixture.close();
  });

  beforeEach(() => {
    h.capture.reset();
    h.exa.reset();
    guardRequests = 0;
    for (const name of ['log', 'info', 'debug', 'warn', 'error'] as const) vi.spyOn(console, name).mockImplementation(() => undefined);
    process.env.RAG_INJECTION_CHECK = 'drop';
    process.env.RAG_INJECTION_LAKERA = 'true';
    process.env.LAKERA_GUARD_API_KEY = 'lakera-placeholder-key';
    process.env.LAKERA_GUARD_BASE_URL = baseUrl;
    delete process.env.RAG_INJECTION_LAKERA_MULTI_TENANT_ACK;
  });

  async function askAsTenantA(): Promise<{ status: number; body: string }> {
    h.session.userId = userA;
    const { POST } = await fixture.loadRoute('chat');
    const response = await POST(
      chatRequest({
        messages: [{ role: 'user', content: QUESTION }],
        data: { ragMode: 'strict', organizationId: null, settings: { webSearch: false, model } },
      }),
    );
    return { status: response.status, body: await response.text() };
  }

  it('without the acknowledgement the fake Lakera server receives no request and the answer streams', async () => {
    const { status, body } = await askAsTenantA();
    expect(status).toBe(200);
    expect(h.capture.calls).toHaveLength(1);
    expect(body).toContain('synthetic answer');
    expect(guardRequests).toBe(0);
  });

  it('with RAG_INJECTION_LAKERA_MULTI_TENANT_ACK=true the fake Lakera server receives at least one request and the answer streams', async () => {
    process.env.RAG_INJECTION_LAKERA_MULTI_TENANT_ACK = 'true';
    const { status, body } = await askAsTenantA();
    expect(status).toBe(200);
    expect(h.capture.calls).toHaveLength(1);
    expect(body).toContain('synthetic answer');
    expect(guardRequests).toBeGreaterThanOrEqual(1);
  });
});
