import crypto from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { mintScope } from '@/lib/rag/tenant/scope';
import { mintVoiceToken } from '@/lib/rag/tenant/voice-token';
import type { QueryLlm, QueryLlmRequest } from '@/lib/rag/query/llm';
import type { BackendSearchRequest, RetrievalBackend } from '@/lib/rag/backend/types';
import { foreignMarkers, seedTwoTenantV2, type TwoTenantV2Seed, type V2TenantLabel } from '../../eval/harness/two-tenant-v2.mts';
import { INTERNAL_API_KEY, startRouteFixture, type RouteFixture } from '../helpers/route-fixture';

const VOICE_SECRET = crypto.randomBytes(24).toString('hex');
const FOLLOW_UP = 'what about its warranty?';
const CODE_A = 'QZX-ALPHA-7731';
const CODE_B = 'QZX-BRAVO-2204';

interface VoiceBody {
  results?: Array<{ chunk_id: string; content: string }>;
  source_images?: Array<{ url: string }>;
  error?: string;
}

interface LlmCall {
  transform: string;
  prompt: string;
  input: string;
}

function binding(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken, 'utf8').digest('base64url').slice(0, 22);
}

/** Condenses by appending every placeholder code the prompt holds, so any history text that leaks shows up downstream. */
function recordingQueryLlm(calls: LlmCall[]): QueryLlm {
  return {
    model: 'fake-query-llm',
    async generate<T>(request: QueryLlmRequest<T>): Promise<T> {
      calls.push({ transform: request.transform, prompt: `${request.system}\n${request.prompt}`, input: request.input });
      if (request.transform !== 'condense') throw new Error('unexpected transform');
      const codes = [CODE_A, CODE_B].filter((code) => request.prompt.includes(code));
      const output = codes.length === 0 ? { standalone: request.input, unchanged: true } : { standalone: `${request.input} ${codes.join(' ')}`, unchanged: false };
      return request.schema.parse(output);
    },
  };
}

describe('voice-rag history never crosses tenants under the query layer', () => {
  let fixture: RouteFixture;
  let seed: TwoTenantV2Seed;
  const llmCalls: LlmCall[] = [];
  const embedded: string[] = [];
  const searches: BackendSearchRequest[] = [];

  beforeAll(async () => {
    fixture = await startRouteFixture({
      deploymentMode: 'multi-tenant',
      twoTenant: true,
      seed: async (db) => {
        seed = await seedTwoTenantV2(db);
      },
      env: {
        RAG_PIPELINE: 'v2',
        RAG_RERANKER: 'none',
        RAG_QUERY_LAYER: 'true',
        RAG_QUERY_CONDENSE: 'true',
        RAG_QUERY_VOICE_TRANSFORMS: 'condense_history,normalize_dates',
        RAG_VOICE_TOKEN_SECRET: VOICE_SECRET,
      },
    });
  });

  afterAll(async () => {
    await fixture?.close();
  });

  beforeEach(() => {
    llmCalls.length = 0;
    embedded.length = 0;
    searches.length = 0;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    const deps = await import('@/lib/rag/deps');
    deps.resetRagDepsForTests();
    const registry = await import('@/lib/rag/backend/registry');
    registry.resetRetrievalBackendForTests();
    vi.restoreAllMocks();
  });

  async function loadVoice(): Promise<(request: NextRequest) => Promise<Response>> {
    const { POST } = await fixture.loadRoute<{ POST: (request: NextRequest) => Promise<Response> }>('internal/voice-rag');
    const deps = await import('@/lib/rag/deps');
    const realEmbedder = deps.getRagDeps().embedder;
    deps.setRagDepsForTests({
      queryLlm: () => recordingQueryLlm(llmCalls),
      embedder: (text, opts) => {
        embedded.push(text);
        return realEmbedder(text, opts);
      },
    });
    const registry = await import('@/lib/rag/backend/registry');
    const real = registry.getRetrievalBackend();
    const recording: RetrievalBackend = {
      id: real.id,
      search: (req) => {
        searches.push(req);
        return real.search(req);
      },
      health: () => real.health(),
      isReady: (scope) => real.isReady(scope),
    };
    registry.setRetrievalBackendForTests(recording);
    return POST;
  }

  function tokenFor(label: V2TenantLabel): string {
    const t = seed.tenants[label];
    const minted = mintVoiceToken({ scope: mintScope(t.organizationId ? 'org' : 'personal', t.userId, t.organizationId), secret: VOICE_SECRET, ttlSeconds: 600 });
    if (!minted.ok) throw new Error(`mint failed: ${minted.reason}`);
    return minted.token;
  }

  function voiceRequest(scopeToken: string, history: Array<{ role: 'user' | 'assistant'; content: string; binding: string }>): NextRequest {
    return new NextRequest('http://localhost/api/internal/voice-rag', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': INTERNAL_API_KEY, 'x-rag-scope-token': scopeToken },
      body: JSON.stringify({ query: FOLLOW_UP, matchCount: 5, history }),
    });
  }

  it('a tenant-B token carrying tenant-A history sends no tenant-A text to the query LLM and retrieves only with B scope', async () => {
    const POST = await loadVoice();
    const tokenA = tokenFor('a');
    const tokenB = tokenFor('b');
    const history = [
      { role: 'user' as const, content: `Tell me about product ${CODE_A}`, binding: binding(tokenA) },
      { role: 'assistant' as const, content: `Product ${CODE_A} is a sample item in the alpha catalogue.`, binding: binding(tokenA) },
    ];
    const response = await POST(voiceRequest(tokenB, history));
    expect(response.status).toBe(200);
    const raw = await response.text();
    const body = JSON.parse(raw) as VoiceBody;

    for (const call of llmCalls) {
      expect(call.prompt).not.toContain(CODE_A);
      expect(call.prompt).not.toContain('alpha catalogue');
    }
    for (const text of embedded) expect(text).not.toContain(CODE_A);
    expect(raw).not.toContain(CODE_A);

    expect(searches.length).toBeGreaterThan(0);
    const b = seed.tenants.b;
    for (const search of searches) {
      expect(search.scope.userId).toBe(b.userId);
      expect(search.scope.organizationId).toBeNull();
    }
    for (const marker of foreignMarkers(seed, 'b')) expect(raw.toLowerCase()).not.toContain(marker.toLowerCase());
    for (const row of body.results ?? []) expect(row.content).not.toContain(CODE_A);
  });

  it('positive control: the same follow-up with B-bound history reaches condense with that history', async () => {
    const POST = await loadVoice();
    const tokenB = tokenFor('b');
    const history = [
      { role: 'user' as const, content: `Tell me about product ${CODE_B}`, binding: binding(tokenB) },
      { role: 'assistant' as const, content: `Product ${CODE_B} is a sample item in the bravo catalogue.`, binding: binding(tokenB) },
    ];
    const response = await POST(voiceRequest(tokenB, history));
    expect(response.status).toBe(200);
    const condense = llmCalls.filter((call) => call.transform === 'condense');
    expect(condense).toHaveLength(1);
    expect(condense[0]!.prompt).toContain(CODE_B);
    expect(embedded.some((text) => text.includes(CODE_B))).toBe(true);
    for (const search of searches) expect(search.scope.userId).toBe(seed.tenants.b.userId);
  });
});
