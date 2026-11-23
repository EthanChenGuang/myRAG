import crypto from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';
import { mintScope } from '@/lib/rag/tenant/scope';
import { mintVoiceToken } from '@/lib/rag/tenant/voice-token';
import { INTERNAL_API_KEY } from '../helpers/route-fixture';

const SECRET = crypto.randomBytes(24).toString('hex');
const OTHER_SECRET = crypto.randomBytes(24).toString('hex');
const QUERY = 'two tenant isolation canary phrase';

type VoiceBody = {
  results?: Array<{ chunk_id: string; content: string }>;
  source_images?: Array<{ url: string }>;
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
});
