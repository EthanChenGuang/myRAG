import crypto from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';
import { mintScope } from '@/lib/rag/tenant/scope';
import { mintVoiceToken } from '@/lib/rag/tenant/voice-token';
import { INTERNAL_API_KEY } from '../helpers/route-fixture';
import { REFERENCE_NOTICE, REFERENCE_REMINDER } from '@/lib/rag/context/wrap';
import type { QueryLlm, QueryLlmRequest } from '@/lib/rag/query/llm';
import type { RunRetrievalInput, StageRecord } from '@/lib/rag/types';
import { V2_CANARY_QUERY, seedTwoTenantV2, type TwoTenantV2Seed } from '../../eval/harness/two-tenant-v2.mts';
import { startRouteFixture, type RouteFixture } from '../helpers/route-fixture';

const h = vi.hoisted(() => ({
  inputs: [] as Array<Record<string, unknown>>,
  classified: [] as string[],
  traces: [] as Array<{ profile: string; stages: Array<{ name: string; counts?: Record<string, number> }> }>,
}));

/** Registered after each vi.resetModules() so the wrapped modules share the fresh env and deps instances with the route. */
function installSpies(): void {
  vi.doMock('@/lib/rag', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/rag')>();
    return {
      ...actual,
      runRetrieval: (input: RunRetrievalInput) => {
        h.inputs.push({ ...input });
        return actual.runRetrieval(input);
      },
    };
  });
  vi.doMock('@/lib/query-classifier', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/query-classifier')>();
    return {
      ...actual,
      classifyQuery: (query: string, hasImage?: boolean) => {
        h.classified.push(query);
        return actual.classifyQuery(query, hasImage);
      },
    };
  });
  vi.doMock('@/lib/rag/trace/finish', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/rag/trace/finish')>();
    return {
      ...actual,
      finishTrace: (...args: Parameters<typeof actual.finishTrace>) => {
        const [collector] = args;
        h.traces.push({ profile: collector.profile, stages: collector.stages().map((stage: StageRecord) => ({ name: stage.name, counts: stage.counts })) });
        return actual.finishTrace(...args);
      },
    };
  });
}

async function importVoiceRoute(): Promise<RouteModule> {
  vi.resetModules();
  installSpies();
  return (await import('@/app/api/internal/voice-rag/route')) as unknown as RouteModule;
}

function bindingOf(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken, 'utf8').digest('base64url').slice(0, 22);
}

type Turn = { role: string; content: string; binding?: string };

const SECRET = crypto.randomBytes(24).toString('hex');
const OTHER_SECRET = crypto.randomBytes(24).toString('hex');
const QUERY = 'two tenant isolation canary phrase';

type VoiceBody = {
  results?: Array<{ chunk_id: string; content: string }>;
  source_images?: Array<{ url: string }>;
  context?: string;
  error?: string;
  reason?: string;
};

interface RouteModule {
  POST(req: NextRequest): Promise<Response>;
}

describe('voice-rag route with signed scope tokens', () => {
  let fixture: TwoTenantDatabase;
  let edge: FakeEdge;
  const previousEnv = { ...process.env } as Record<string, string | undefined>;

  beforeAll(async () => {
    fixture = await createTwoTenantDatabase();
    edge = await startFakeEdge({ db: fixture.db });
    Object.assign(process.env, fixtureProcessEnv(edge.url));
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    process.env.MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    process.env.MYRAG_INTERNAL_API_KEY = INTERNAL_API_KEY;
    process.env.OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';
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
    process.env.RAG_VOICE_TOKEN_SECRET = SECRET;
    delete process.env.RAG_CONTEXT_TAGGING;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  async function loadRoute(): Promise<RouteModule> {
    return importVoiceRoute();
  }

  function token(scope: ReturnType<typeof mintScope>, options: { secret?: string; now?: number; ttlSeconds?: number } = {}): string {
    const minted = mintVoiceToken({ scope, secret: options.secret ?? SECRET, ttlSeconds: options.ttlSeconds ?? 600, now: options.now });
    if (!minted.ok) throw new Error(`mint failed: ${minted.reason}`);
    return minted.token;
  }

  function request(query: string, scopeToken: string | null, extra: Record<string, unknown> = {}): NextRequest {
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-api-key': INTERNAL_API_KEY };
    if (scopeToken !== null) headers['x-rag-scope-token'] = scopeToken;
    return new NextRequest('http://localhost/api/internal/voice-rag', {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, matchCount: 5, ...extra }),
    });
  }

  const rpcCalls = () => edge.calls.filter((call) => call.path.includes('/rpc/'));
  const chunkIds = (body: VoiceBody) => (body.results ?? []).map((result) => result.chunk_id).sort();

  it('rejects a bare body userId without a token and runs no search', async () => {
    const { POST } = await loadRoute();
    const before = edge.calls.length;
    const response = await POST(request(QUERY, null, { userId: TWO_TENANT_IDS.userA }));
    expect(response.status).toBe(401);
    expect(edge.calls.length).toBe(before);
  });

  it('rejects a token signed with another secret', async () => {
    const { POST } = await loadRoute();
    const before = edge.calls.length;
    const forged = token(mintScope('personal', TWO_TENANT_IDS.userA, null), { secret: OTHER_SECRET });
    const response = await POST(request(QUERY, forged));
    expect(response.status).toBe(401);
    expect(edge.calls.length).toBe(before);
  });

  it('rejects an expired token', async () => {
    const { POST } = await loadRoute();
    const expired = token(mintScope('personal', TWO_TENANT_IDS.userA, null), { now: Date.now() - 7_200_000, ttlSeconds: 60 });
    const response = await POST(request(QUERY, expired));
    expect(response.status).toBe(401);
  });

  it('answers 403 when the token names an organization the user is no longer a member of', async () => {
    const { POST } = await loadRoute();
    const before = rpcCalls().length;
    const response = await POST(request(QUERY, token(mintScope('org', TWO_TENANT_IDS.userB, TWO_TENANT_IDS.orgO))));
    expect(response.status).toBe(403);
    expect(rpcCalls().length).toBe(before);
  });

  it('answers 503 when the token secret is not configured', async () => {
    process.env.RAG_VOICE_TOKEN_SECRET = '';
    const { POST } = await loadRoute();
    const response = await POST(request(QUERY, token(mintScope('personal', TWO_TENANT_IDS.userA, null))));
    expect(response.status).toBe(503);
  });

  it('keeps the internal API key check ahead of the token', async () => {
    const { POST } = await loadRoute();
    const bad = new NextRequest('http://localhost/api/internal/voice-rag', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'wrong', 'x-rag-scope-token': token(mintScope('personal', TWO_TENANT_IDS.userA, null)) },
      body: JSON.stringify({ query: QUERY }),
    });
    expect((await POST(bad)).status).toBe(401);
  });

  it('a personal token returns only that user chunk and never calls the single-tenant RPC', async () => {
    const { POST } = await loadRoute();
    const before = edge.calls.length;
    const response = await POST(request(QUERY, token(mintScope('personal', TWO_TENANT_IDS.userA, null)), { userId: TWO_TENANT_IDS.userB }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as VoiceBody;
    expect(chunkIds(body)).toEqual([TWO_TENANT_IDS.chunkA]);
    const fresh = edge.calls.slice(before);
    expect(fresh.some((call) => call.path.endsWith('/rpc/match_document_chunks'))).toBe(false);
    expect(fresh.some((call) => call.path.endsWith('/rpc/match_documents_by_workspace'))).toBe(true);
  });

  it('an organization token returns only the organization chunk', async () => {
    const { POST } = await loadRoute();
    const response = await POST(request(QUERY, token(mintScope('org', TWO_TENANT_IDS.userA, TWO_TENANT_IDS.orgO))));
    expect(response.status).toBe(200);
    expect(chunkIds((await response.json()) as VoiceBody)).toEqual([TWO_TENANT_IDS.chunkO]);
  });

  it('the keyword and image fallback cannot reach another tenant chunk', async () => {
    const { POST } = await loadRoute();
    const response = await POST(request('show me the company logo', token(mintScope('personal', TWO_TENANT_IDS.userB, null))));
    expect(response.status).toBe(200);
    const body = (await response.json()) as VoiceBody;
    expect(chunkIds(body)).not.toContain(TWO_TENANT_IDS.chunkO);
    expect(chunkIds(body)).not.toContain(TWO_TENANT_IDS.chunkA);
    expect(body.source_images ?? []).toEqual([]);
  });

  it('the organization token reaches its own logo through the image fallback', async () => {
    const { POST } = await loadRoute();
    const response = await POST(request('show me the company logo', token(mintScope('org', TWO_TENANT_IDS.userA, TWO_TENANT_IDS.orgO))));
    expect(response.status).toBe(200);
    const body = (await response.json()) as VoiceBody;
    expect(chunkIds(body)).toContain(TWO_TENANT_IDS.chunkO);
    expect(body.source_images?.map((image) => image.url)).toEqual(['https://example.invalid/logo.png']);
  });

  it('answers a structured 503 when the embedding step fails', async () => {
    const { POST } = await loadRoute();
    const deps = await import('@/lib/rag/deps');
    deps.setRagDepsForTests({ embedder: () => Promise.reject(new Error('embedding backend down')) });
    try {
      const response = await POST(request(QUERY, token(mintScope('personal', TWO_TENANT_IDS.userA, null))));
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'knowledge_base_unavailable', reason: 'embed_failed' });
    } finally {
      deps.resetRagDepsForTests();
    }
  });

  it('answers an empty result list for a scope with no matching documents', async () => {
    const { POST } = await loadRoute();
    const deps = await import('@/lib/rag/deps');
    deps.setRagDepsForTests({ embedder: async () => new Array(1536).fill(0) });
    try {
      const nobody = '00000000-0000-4000-8000-0000000000ff';
      const response = await POST(request(QUERY, token(mintScope('personal', nobody, null))));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ results: [] });
    } finally {
      deps.resetRagDepsForTests();
    }
  });
  describe('history (D-30)', () => {
    const personalA = (now?: number) => token(mintScope('personal', TWO_TENANT_IDS.userA, null), { now });
    const turns = (count: number, scopeToken: string): Turn[] =>
      Array.from({ length: count }, (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `synthetic turn ${index + 1}`,
        binding: bindingOf(scopeToken),
      }));

    beforeEach(() => {
      h.inputs.length = 0;
      h.classified.length = 0;
      h.traces.length = 0;
      delete process.env.RAG_QUERY_LAYER;
    });

    afterEach(() => {
      delete process.env.RAG_QUERY_LAYER;
    });

    it('passes six bound turns to runRetrieval without their bindings', async () => {
      const { POST } = await loadRoute();
      const scopeToken = personalA();
      const response = await POST(request(QUERY, scopeToken, { history: turns(6, scopeToken) }));
      expect(response.status).toBe(200);
      expect(h.inputs).toHaveLength(1);
      expect(h.inputs[0]!.history).toEqual(turns(6, scopeToken).map(({ role, content }) => ({ role, content })));
    });

    const invalid: Array<[string, (scopeToken: string) => Turn[]]> = [
      ['seven turns', (t) => turns(7, t)],
      ['a 1,001-character turn', (t) => [{ role: 'user', content: 'x'.repeat(1001), binding: bindingOf(t) }]],
      ['a system turn', (t) => [{ role: 'system', content: 'synthetic instruction', binding: bindingOf(t) }]],
      ['a turn without a binding', () => [{ role: 'user', content: 'synthetic turn' }]],
    ];
    for (const [name, build] of invalid) {
      it(`answers the structured 400 for ${name} and runs no search`, async () => {
        const { POST } = await loadRoute();
        const before = edge.calls.length;
        const scopeToken = personalA();
        const response = await POST(request(QUERY, scopeToken, { history: build(scopeToken) }));
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'Invalid history' });
        expect(edge.calls.length).toBe(before);
        expect(h.inputs).toHaveLength(0);
      });
    }

    it('drops turns bound to another token before the query layer and logs only the count', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { POST } = await loadRoute();
      const scopeToken = personalA();
      const other = token(mintScope('personal', TWO_TENANT_IDS.userB, null));
      const history: Turn[] = [
        { role: 'user', content: 'synthetic own question', binding: bindingOf(scopeToken) },
        { role: 'assistant', content: 'synthetic foreign answer', binding: bindingOf(other) },
        { role: 'user', content: 'synthetic own follow-up', binding: bindingOf(scopeToken) },
      ];
      const response = await POST(request(QUERY, scopeToken, { history }));
      expect(response.status).toBe(200);
      expect(h.inputs[0]!.history).toEqual([
        { role: 'user', content: 'synthetic own question' },
        { role: 'user', content: 'synthetic own follow-up' },
      ]);
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).toContain('[Internal RAG]');
      expect(logged).toContain('"count":1');
      expect(logged).not.toContain('synthetic foreign answer');
      const trace = h.traces.find((entry) => entry.stages.some((stage) => stage.name === 'voice_history'));
      expect(trace?.stages.find((stage) => stage.name === 'voice_history')?.counts).toEqual({ history_kept: 2, history_dropped: 1 });
    });

    it('keeps the wire contract identical with and without history', async () => {
      const { POST } = await loadRoute();
      const scopeToken = personalA();
      const without = await POST(request(QUERY, scopeToken));
      const withHistory = await POST(request(QUERY, scopeToken, { history: turns(2, scopeToken) }));
      const a = (await without.json()) as VoiceBody;
      const b = (await withHistory.json()) as VoiceBody;
      expect(Object.keys(a).sort()).toEqual(['results', 'source_images']);
      expect(b).toEqual(a);
      expect(without.headers.get('x-rag-server-query-rewrite')).toBeNull();
      expect(withHistory.headers.get('x-rag-server-query-rewrite')).toBeNull();
    });

    it('layer off: classifyQuery is not called and runRetrieval gets no classification', async () => {
      const { POST } = await loadRoute();
      const response = await POST(request(QUERY, personalA()));
      expect(response.status).toBe(200);
      expect(h.classified).toEqual([]);
      expect('classification' in h.inputs[0]!).toBe(false);
      expect('history' in h.inputs[0]!).toBe(false);
      expect('trace' in h.inputs[0]!).toBe(false);
    });

    it('layer on: classifyQuery is called once and its result reaches runRetrieval', async () => {
      process.env.RAG_QUERY_LAYER = 'true';
      const { POST } = await loadRoute();
      const response = await POST(request(QUERY, personalA()));
      expect(response.status).toBe(200);
      expect(h.classified).toEqual([QUERY]);
      expect(h.inputs[0]!.classification).toBeDefined();
      // Legacy pipeline: the layer cannot run, so the agent must keep its own rewrite.
      expect(response.headers.get('x-rag-server-query-rewrite')).toBeNull();
    });
  });

  describe('context tagging (A-1)', () => {
    const personalA = () => token(mintScope('personal', TWO_TENANT_IDS.userA, null));
    const personalB = () => token(mintScope('personal', TWO_TENANT_IDS.userB, null));

    it('with tagging off the body has exactly the keys it has today and no context', async () => {
      const { POST } = await loadRoute();
      const response = await POST(request(QUERY, personalA()));
      expect(response.status).toBe(200);
      const body = (await response.json()) as VoiceBody;
      expect(Object.keys(body).sort()).toEqual(['results', 'source_images']);
    });

    it('with tagging on the body gains a tagged context and results and source_images are unchanged', async () => {
      const { POST } = await loadRoute();
      const off = (await (await POST(request(QUERY, personalA()))).json()) as VoiceBody;
      process.env.RAG_CONTEXT_TAGGING = 'true';
      const response = await POST(request(QUERY, personalA()));
      expect(response.status).toBe(200);
      const body = (await response.json()) as VoiceBody;
      expect(Object.keys(body).sort()).toEqual(['context', 'results', 'source_images']);
      expect(body.results).toEqual(off.results);
      expect(body.source_images).toEqual(off.source_images);
      const context = body.context ?? '';
      expect(context.startsWith(REFERENCE_NOTICE)).toBe(true);
      expect(context.endsWith(REFERENCE_REMINDER)).toBe(true);
      expect(context.match(/<documents>/g)).toHaveLength(1);
      expect(context).toMatch(/<doc id="c1" source="[^"]+">/);
      expect(context).toContain('alpha personal notes');
    });

    it('two tenants with tagging on each get a context built only from their own results', async () => {
      process.env.RAG_CONTEXT_TAGGING = 'true';
      const { POST } = await loadRoute();
      const a = (await (await POST(request(QUERY, personalA(), { userId: TWO_TENANT_IDS.userB }))).json()) as VoiceBody;
      const b = (await (await POST(request(QUERY, personalB(), { userId: TWO_TENANT_IDS.userA }))).json()) as VoiceBody;
      expect(chunkIds(a)).toEqual([TWO_TENANT_IDS.chunkA]);
      expect(chunkIds(b)).toEqual([TWO_TENANT_IDS.chunkB]);
      expect(a.context).toContain('alpha personal notes');
      expect(a.context).not.toContain('bravo personal notes');
      expect(a.context).not.toContain('organization shared handbook');
      expect(a.context).not.toContain('tenant-b-personal.md');
      expect(b.context).toContain('bravo personal notes');
      expect(b.context).not.toContain('alpha personal notes');
      expect(b.context).not.toContain('organization shared handbook');
      expect(b.context).not.toContain('tenant-a-personal.md');
    });

    it('with tagging on a scope with no matching documents still answers an empty result list', async () => {
      process.env.RAG_CONTEXT_TAGGING = 'true';
      const { POST } = await loadRoute();
      const deps = await import('@/lib/rag/deps');
      deps.setRagDepsForTests({ embedder: async () => new Array(1536).fill(0) });
      try {
        const nobody = '00000000-0000-4000-8000-0000000000ff';
        const response = await POST(request(QUERY, token(mintScope('personal', nobody, null))));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ results: [] });
      } finally {
        deps.resetRagDepsForTests();
      }
    });
  });
});

describe('voice-rag under the v2 query layer', () => {
  const VOICE_SECRET = crypto.randomBytes(24).toString('hex');
  let fixture: RouteFixture;
  let seed: TwoTenantV2Seed;
  const llmCalls: Array<{ transform: string; prompt: string }> = [];
  const embedded: string[] = [];

  const LAYER_ENV: Record<string, string> = {
    RAG_PIPELINE: 'v2',
    RAG_RERANKER: 'none',
    RAG_QUERY_LAYER: 'true',
    RAG_QUERY_CONDENSE: 'true',
    RAG_QUERY_VOICE_TRANSFORMS: 'condense_history,normalize_dates',
  };

  beforeAll(async () => {
    fixture = await startRouteFixture({
      deploymentMode: 'multi-tenant',
      twoTenant: true,
      seed: async (db) => {
        seed = await seedTwoTenantV2(db);
      },
      env: { ...LAYER_ENV, RAG_VOICE_TOKEN_SECRET: VOICE_SECRET },
    });
  });

  afterAll(async () => {
    await fixture?.close();
  });

  beforeEach(() => {
    Object.assign(process.env, LAYER_ENV);
    llmCalls.length = 0;
    embedded.length = 0;
    h.inputs.length = 0;
    h.traces.length = 0;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    const deps = await import('@/lib/rag/deps');
    deps.resetRagDepsForTests();
    vi.restoreAllMocks();
  });

  function recordingLlm(): QueryLlm {
    return {
      model: 'fake-query-llm',
      async generate<T>(req: QueryLlmRequest<T>): Promise<T> {
        llmCalls.push({ transform: req.transform, prompt: `${req.system}\n${req.prompt}` });
        if (req.transform !== 'condense') throw new Error('unexpected transform');
        return req.schema.parse({ standalone: req.input, unchanged: true });
      },
    };
  }

  async function load(): Promise<RouteModule['POST']> {
    const { POST } = await importVoiceRoute();
    const deps = await import('@/lib/rag/deps');
    const real = deps.getRagDeps().embedder;
    deps.setRagDepsForTests({
      queryLlm: () => recordingLlm(),
      embedder: (text, opts) => {
        embedded.push(text);
        return real(text, opts);
      },
    });
    return POST;
  }

  function tokenB(now?: number): string {
    const b = seed.tenants.b;
    const minted = mintVoiceToken({ scope: mintScope('personal', b.userId, null), secret: VOICE_SECRET, ttlSeconds: 600, now });
    if (!minted.ok) throw new Error(`mint failed: ${minted.reason}`);
    return minted.token;
  }

  function post(POST: RouteModule['POST'], query: string, scopeToken: string, history?: Turn[]): Promise<Response> {
    return POST(
      new NextRequest('http://localhost/api/internal/voice-rag', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': INTERNAL_API_KEY, 'x-rag-scope-token': scopeToken },
        body: JSON.stringify({ query, matchCount: 5, ...(history ? { history } : {}) }),
      }),
    );
  }

  it('announces server-side condensing with and without history when condense_history is allow-listed', async () => {
    const POST = await load();
    const scopeToken = tokenB();
    const plain = await post(POST, V2_CANARY_QUERY, scopeToken);
    expect(plain.status).toBe(200);
    expect(plain.headers.get('x-rag-server-query-rewrite')).toBe('1');
    const withHistory = await post(POST, V2_CANARY_QUERY, scopeToken, [{ role: 'user', content: 'synthetic earlier question', binding: bindingOf(scopeToken) }]);
    expect(withHistory.status).toBe(200);
    expect(withHistory.headers.get('x-rag-server-query-rewrite')).toBe('1');
    expect(Object.keys((await withHistory.json()) as VoiceBody).sort()).toEqual(['results', 'source_images']);
  });

  it('omits the header when condense_history is not allow-listed for voice', async () => {
    process.env.RAG_QUERY_VOICE_TRANSFORMS = 'normalize_dates';
    const POST = await load();
    const response = await post(POST, V2_CANARY_QUERY, tokenB());
    expect(response.status).toBe(200);
    expect(response.headers.get('x-rag-server-query-rewrite')).toBeNull();
  });

  it('with the layer off under v2 the header is absent and history changes nothing in the response', async () => {
    process.env.RAG_QUERY_LAYER = 'false';
    const POST = await load();
    const scopeToken = tokenB();
    const without = await post(POST, V2_CANARY_QUERY, scopeToken);
    const withHistory = await post(POST, V2_CANARY_QUERY, scopeToken, [{ role: 'user', content: 'synthetic earlier question', binding: bindingOf(scopeToken) }]);
    expect(without.headers.get('x-rag-server-query-rewrite')).toBeNull();
    expect(withHistory.headers.get('x-rag-server-query-rewrite')).toBeNull();
    expect(await withHistory.json()).toEqual(await without.json());
    expect(llmCalls).toEqual([]);
  });

  it('after a token refresh the earlier turns are dropped, condense gets no history and the original query is retrieved', async () => {
    const POST = await load();
    const earlier = tokenB(Date.now() - 60_000);
    const refreshed = tokenB();
    expect(refreshed).not.toBe(earlier);
    const history: Turn[] = [
      { role: 'user', content: 'synthetic remembered subject zeta', binding: bindingOf(earlier) },
      { role: 'assistant', content: 'synthetic remembered answer zeta', binding: bindingOf(earlier) },
    ];
    const response = await post(POST, V2_CANARY_QUERY, refreshed, history);
    expect(response.status).toBe(200);
    const body = (await response.json()) as VoiceBody;
    expect((body.results ?? []).length).toBeGreaterThan(0);
    expect(h.inputs[0]!.history).toEqual([]);
    for (const call of llmCalls) expect(call.prompt).not.toContain('zeta');
    expect(embedded).toContain(V2_CANARY_QUERY);
    for (const text of embedded) expect(text).not.toContain('zeta');
    const trace = h.traces.find((entry) => entry.stages.some((stage) => stage.name === 'voice_history'));
    expect(trace?.stages.find((stage) => stage.name === 'voice_history')?.counts).toEqual({ history_kept: 0, history_dropped: 2 });
  });
});
