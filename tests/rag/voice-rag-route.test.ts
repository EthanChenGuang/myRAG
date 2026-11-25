import crypto from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';
import { mintScope } from '@/lib/rag/tenant/scope';
import { mintVoiceToken } from '@/lib/rag/tenant/voice-token';
import { INTERNAL_API_KEY } from '../helpers/route-fixture';
import { REFERENCE_NOTICE, REFERENCE_REMINDER } from '@/lib/rag/context/wrap';

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
    vi.resetModules();
    return (await import('@/app/api/internal/voice-rag/route')) as unknown as RouteModule;
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
