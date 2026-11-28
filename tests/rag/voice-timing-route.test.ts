import crypto from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';
import { mintScope } from '@/lib/rag/tenant/scope';
import { mintVoiceToken } from '@/lib/rag/tenant/voice-token';
import { INTERNAL_API_KEY } from '../helpers/route-fixture';
import type { LangfuseScoreInput, PostScoresResult } from '@/lib/rag';

type PostedBody = Array<{ id: string; traceId: string; name: string; value: number; dataType: string }>;

const h = vi.hoisted(() => ({
  calls: [] as Array<Array<{ traceId: string; name: string; value: number | string; dataType: string }>>,
  bodies: [] as Array<Array<{ id: string; traceId: string; name: string; value: number; dataType: string }>>,
  mode: 'langfuse' as 'langfuse' | 'skipped' | 'failed' | 'throws',
}));

function installSpies(): void {
  vi.doMock('@/lib/rag', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/rag')>();
    return {
      ...actual,
      postLangfuseScores: async (scores: readonly LangfuseScoreInput[]): Promise<PostScoresResult> => {
        h.calls.push(scores.map((score) => ({ traceId: score.traceId, name: score.name, value: score.value, dataType: score.dataType })));
        if (h.mode === 'skipped') return { status: 'skipped', httpStatus: null };
        if (h.mode === 'failed') return { status: 'failed', httpStatus: 500 };
        if (h.mode === 'throws') throw new Error('poster exploded');
        return actual.postLangfuseScores(scores, {
          config: {
            enabled: true,
            publicKey: 'pk-placeholder',
            secretKey: 'sk-placeholder',
            baseUrl: 'https://langfuse.example.invalid',
            sampleRate: 1,
            reviewSampleRate: 0,
            captureContent: false,
          },
          fetch: (async (_url: unknown, init?: RequestInit) => {
            h.bodies.push(JSON.parse(String(init?.body)) as PostedBody);
            return new Response(null, { status: 202 });
          }) as typeof fetch,
        });
      },
    };
  });
}

interface RouteModule {
  POST(req: NextRequest): Promise<Response>;
  runtime: string;
}

async function loadRoute(): Promise<RouteModule> {
  vi.resetModules();
  installSpies();
  return (await import('@/app/api/internal/voice-timing/route')) as unknown as RouteModule;
}

const SECRET = crypto.randomBytes(24).toString('hex');
const OTHER_SECRET = crypto.randomBytes(24).toString('hex');
const TRACE_ID = 'a'.repeat(8) + '0123456789abcdef' + 'b'.repeat(8);

describe('voice-timing route', () => {
  let fixture: TwoTenantDatabase;
  let edge: FakeEdge;
  const previousEnv = { ...process.env } as Record<string, string | undefined>;
  let logs: unknown[][];

  beforeAll(async () => {
    fixture = await createTwoTenantDatabase();
    edge = await startFakeEdge({ db: fixture.db });
    Object.assign(process.env, fixtureProcessEnv(edge.url));
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    process.env.MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
  });

  afterAll(async () => {
    await edge?.close();
    await fixture?.db.close();
    for (const name of Object.keys(process.env)) {
      if (!(name in previousEnv)) delete process.env[name];
    }
    Object.assign(process.env, previousEnv);
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.MYRAG_INTERNAL_API_KEY = INTERNAL_API_KEY;
    process.env.RAG_VOICE_TOKEN_SECRET = SECRET;
    h.calls.length = 0;
    h.bodies.length = 0;
    h.mode = 'langfuse';
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args);
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  function token(scope: ReturnType<typeof mintScope>, secret = SECRET): string {
    const minted = mintVoiceToken({ scope, secret, ttlSeconds: 600 });
    if (!minted.ok) throw new Error(`mint failed: ${minted.reason}`);
    return minted.token;
  }

  const personalA = () => token(mintScope('personal', TWO_TENANT_IDS.userA, null));

  function request(body: unknown, options: { apiKey?: string | null; scopeToken?: string | null; raw?: string } = {}): NextRequest {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const apiKey = options.apiKey === undefined ? INTERNAL_API_KEY : options.apiKey;
    if (apiKey !== null) headers['x-api-key'] = apiKey;
    const scopeToken = options.scopeToken === undefined ? personalA() : options.scopeToken;
    if (scopeToken !== null) headers['x-rag-scope-token'] = scopeToken;
    return new NextRequest('http://localhost/api/internal/voice-timing', {
      method: 'POST',
      headers,
      body: options.raw ?? JSON.stringify(body),
    });
  }

  const valid = { traceId: TRACE_ID, ttft_ms: 840, pre_generation_ms: 310 };
  const timingLogs = () => logs.filter((args) => typeof args[0] === 'string' && (args[0] as string).includes('voice timing'));

  it('runs on the node runtime', async () => {
    const route = await loadRoute();
    expect(route.runtime).toBe('nodejs');
  });

  it('answers 401 without the internal API key and posts nothing', async () => {
    const { POST } = await loadRoute();
    const response = await POST(request(valid, { apiKey: null }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
    expect(h.calls).toEqual([]);
  });

  it('answers 401 with a wrong internal API key', async () => {
    const { POST } = await loadRoute();
    const response = await POST(request(valid, { apiKey: 'wrong-key-placeholder' }));
    expect(response.status).toBe(401);
    expect(h.calls).toEqual([]);
  });

  it('answers 500 when the server key is not configured', async () => {
    process.env.MYRAG_INTERNAL_API_KEY = '';
    const { POST } = await loadRoute();
    const response = await POST(request(valid));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Server configuration error' });
    expect(h.calls).toEqual([]);
  });

  it('answers 401 with the key but no scope token', async () => {
    const { POST } = await loadRoute();
    const response = await POST(request(valid, { scopeToken: null }));
    expect(response.status).toBe(401);
    expect(h.calls).toEqual([]);
  });

  it('answers 401 with a scope token signed with another secret', async () => {
    const { POST } = await loadRoute();
    const response = await POST(request(valid, { scopeToken: token(mintScope('personal', TWO_TENANT_IDS.userA, null), OTHER_SECRET) }));
    expect(response.status).toBe(401);
    expect(h.calls).toEqual([]);
  });

  it('answers 503 when scope resolution is unavailable', async () => {
    const scopeToken = personalA();
    process.env.RAG_VOICE_TOKEN_SECRET = '';
    const { POST } = await loadRoute();
    const response = await POST(request(valid, { scopeToken }));
    expect(response.status).toBe(503);
    expect(h.calls).toEqual([]);
  });

  it('answers 403 for an organization token whose user is not a member', async () => {
    const { POST } = await loadRoute();
    const response = await POST(request(valid, { scopeToken: token(mintScope('org', TWO_TENANT_IDS.userB, TWO_TENANT_IDS.orgO)) }));
    expect(response.status).toBe(403);
    expect(h.calls).toEqual([]);
  });

  it('answers 400 for a body that is not JSON', async () => {
    const { POST } = await loadRoute();
    const response = await POST(request(null, { raw: '{not json' }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid JSON body' });
    expect(h.calls).toEqual([]);
  });

  const invalid: Array<[string, unknown]> = [
    ['an unknown field', { ...valid, transcript: 'synthetic text' }],
    ['a missing trace id', { ttft_ms: 840, pre_generation_ms: 310 }],
    ['an upper-case trace id', { ...valid, traceId: TRACE_ID.toUpperCase() }],
    ['a short trace id', { ...valid, traceId: TRACE_ID.slice(1) }],
    ['a dashed trace id', { ...valid, traceId: `${TRACE_ID.slice(0, 8)}-${TRACE_ID.slice(9)}` }],
    ['a negative ttft', { ...valid, ttft_ms: -1, pre_generation_ms: 0 }],
    ['a fractional ttft', { ...valid, ttft_ms: 840.5 }],
    ['a ttft above 120000', { ...valid, ttft_ms: 120001 }],
    ['a negative pre-generation time', { ...valid, pre_generation_ms: -1 }],
    ['a fractional pre-generation time', { ...valid, pre_generation_ms: 1.5 }],
    ['a pre-generation time above 120000', { ...valid, ttft_ms: 120000, pre_generation_ms: 120001 }],
    ['a string number', { ...valid, ttft_ms: '840' }],
    ['a pre-generation time above ttft', { ...valid, ttft_ms: 300, pre_generation_ms: 301 }],
    ['an array body', [valid]],
  ];
  for (const [name, body] of invalid) {
    it(`answers 400 for ${name} and posts nothing`, async () => {
      const { POST } = await loadRoute();
      const response = await POST(request(body));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Invalid timing body' });
      expect(h.calls).toEqual([]);
    });
  }

  it('accepts the bounds 0 and 120000', async () => {
    const { POST } = await loadRoute();
    expect((await POST(request({ traceId: TRACE_ID, ttft_ms: 0, pre_generation_ms: 0 }))).status).toBe(202);
    expect((await POST(request({ traceId: TRACE_ID, ttft_ms: 120000, pre_generation_ms: 120000 }))).status).toBe(202);
  });

  it('posts two NUMERIC scores for the trace, logs ids and numbers only and answers 202', async () => {
    const { POST } = await loadRoute();
    const response = await POST(request(valid));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
    expect(h.calls).toEqual([
      [
        { traceId: TRACE_ID, name: 'ttft_ms', value: 840, dataType: 'NUMERIC' },
        { traceId: TRACE_ID, name: 'pre_generation_ms', value: 310, dataType: 'NUMERIC' },
      ],
    ]);
    expect(h.bodies).toHaveLength(1);
    expect(h.bodies[0]!.map((score) => score.name)).toEqual(['ttft_ms', 'pre_generation_ms']);
    const lines = timingLogs();
    expect(lines).toHaveLength(1);
    const [prefix, payload] = lines[0]!;
    expect(prefix).toBe('[Internal RAG] voice timing');
    expect(payload).toEqual({ traceId: TRACE_ID, ttft_ms: 840, pre_generation_ms: 310, scores: 'accepted' });
  });

  it('still answers 202 and logs when Langfuse is off', async () => {
    h.mode = 'skipped';
    const { POST } = await loadRoute();
    const response = await POST(request(valid));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
    expect(timingLogs()).toHaveLength(1);
    expect(timingLogs()[0]![1]).toMatchObject({ traceId: TRACE_ID, scores: 'skipped' });
  });

  it('still answers 202 and logs when the score post fails', async () => {
    h.mode = 'failed';
    const { POST } = await loadRoute();
    const response = await POST(request(valid));
    expect(response.status).toBe(202);
    expect(timingLogs()[0]![1]).toMatchObject({ traceId: TRACE_ID, scores: 'failed' });
  });

  it('never returns a stack or the request body when something throws', async () => {
    h.mode = 'throws';
    const { POST } = await loadRoute();
    const response = await POST(request(valid));
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: 'Internal Server Error' });
    expect(text).not.toContain('poster exploded');
    expect(text).not.toContain(TRACE_ID);
  });

  it('a repeat post for the same trace overwrites: the score ids are the same', async () => {
    const { POST } = await loadRoute();
    await POST(request(valid));
    await POST(request({ ...valid, ttft_ms: 900, pre_generation_ms: 400 }));
    expect(h.bodies).toHaveLength(2);
    const ids = h.bodies.map((body) => body.map((score) => score.id));
    expect(ids[1]).toEqual(ids[0]);
    expect(new Set(ids[0]).size).toBe(2);
    expect(h.bodies[1]!.map((score) => score.value)).toEqual([900, 400]);
  });

  it('an organization member token is accepted', async () => {
    const { POST } = await loadRoute();
    const response = await POST(request(valid, { scopeToken: token(mintScope('org', TWO_TENANT_IDS.userA, TWO_TENANT_IDS.orgO)) }));
    expect(response.status).toBe(202);
  });
});
