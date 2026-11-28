import crypto from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { mintScope } from '@/lib/rag/tenant/scope';
import { mintVoiceToken } from '@/lib/rag/tenant/voice-token';
import { TWO_TENANT_IDS } from '../../../eval/harness/two-tenant.mts';
import {
  V2_CANARY_QUERY,
  V2_CONTRACT_QUESTION,
  V2_TRANSLATED_QUESTION,
  V2_TRANSLATED_TEXT,
  foreignMarkers,
  seedTwoTenantV2,
  type TwoTenantV2Seed,
  type V2TenantLabel,
} from '../../../eval/harness/two-tenant-v2.mts';
import { chatRequest } from '../../helpers/chat-route-fakes';
import { INTERNAL_API_KEY, startRouteFixture, systemTextOf, type RouteFixture } from '../../helpers/route-fixture';

const h = await vi.hoisted(async () => {
  const fakes = await import('../../helpers/chat-route-fakes');
  const session: { userId: string | null } = { userId: null };
  return {
    capture: fakes.createStreamTextCapture(),
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
  streamText: async (params: Record<string, unknown>) => ({
    ...(await h.capture.streamText(params)),
    toUIMessageStreamResponse: () => new Response('model stream'),
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.ssr }));
vi.mock('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: () => (modelId: string) => ({ specificationVersion: 'v3', provider: 'fake', modelId }),
}));
vi.mock('exa-js', () => ({ default: h.exa.Exa }));

type Pipeline = 'legacy' | 'v2';
type RouteKind = 'chat strict' | 'chat balanced' | 'embed' | 'voice-rag';

const PIPELINES: Pipeline[] = ['legacy', 'v2'];
const ROUTES: RouteKind[] = ['chat strict', 'chat balanced', 'embed', 'voice-rag'];
const LABELS: V2TenantLabel[] = ['a', 'b', 'o'];
const VOICE_SECRET = crypto.randomBytes(24).toString('hex');
const processEnv = process.env as Record<string, string | undefined>;

const V2_SWITCHES: Record<string, string> = {
  RAG_PIPELINE: 'v2',
  RAG_LEXICAL_SEARCH: 'true',
  RAG_RERANKER: 'cohere',
  RAG_RERANK_TIER_CHAT: 'quality',
  RAG_RERANK_TIER_VOICE: 'quality',
  RAG_REFUSAL_THRESHOLD: 'true',
  RAG_CONTEXT_EDGE_ORDER: 'true',
  RAG_CONTEXT_COMPRESSION: 'true',
  RAG_PARENT_CHILD: 'true',
  RAG_LEXICAL_TRANSLATION: 'true',
  RAG_EXACT_ID_LOOKUP: 'true',
};

const LEGACY_PHRASES: Record<V2TenantLabel, string> = { a: 'alpha personal notes', b: 'bravo personal notes', o: 'organization shared handbook' };
const QUESTION = V2_CANARY_QUERY;
const B_ONLY_QUESTION = V2_CONTRACT_QUESTION;
const B_ONLY_MARKER = 'v2contractbravo';
const LOGO_URL = 'https://example.invalid/logo.png';
const UNAVAILABLE = 'Information Not Available';

function configuredModelId(): string {
  const models = JSON.parse(env.NEXT_PUBLIC_OPENROUTER_MODELS) as Array<{ id: string }>;
  const id = models.map((model) => model.id).find((candidate) => !/gpt-4|o1|chatgpt/.test(candidate) && !candidate.includes('claude'));
  return id as string;
}

function readSseText(body: string): string {
  let text = '';
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '' || payload === '[DONE]') continue;
    try {
      const chunk = JSON.parse(payload) as { type?: string; delta?: string };
      if (chunk.type === 'text-delta' && typeof chunk.delta === 'string') text += chunk.delta;
    } catch {
      continue;
    }
  }
  return text;
}

interface Observed {
  prompt: string;
  body: string;
  logs: string;
}

describe('chat, embed and voice routes keep tenants apart under legacy and v2 with every switch on', () => {
  let fixture: RouteFixture;
  let seed: TwoTenantV2Seed;
  let logs: string[] = [];
  const model = configuredModelId();
  const rerankBodies: Array<{ query: string; documents: string[] }> = [];

  beforeAll(async () => {
    fixture = await startRouteFixture({
      deploymentMode: 'multi-tenant',
      twoTenant: true,
      seed: async (db) => {
        seed = await seedTwoTenantV2(db);
      },
    });
  });

  afterAll(async () => {
    await fixture.close();
  });

  beforeEach(() => {
    h.capture.reset();
    h.exa.reset();
    h.session.userId = null;
    logs = [];
    for (const method of ['log', 'warn', 'error'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logs.push(JSON.stringify(args));
      });
    }
  });

  afterEach(async () => {
    for (const name of ['RAG_QUERY_LAYER', 'RAG_QUERY_FRAMEWORK', 'RAG_QUERY_HYDE']) delete processEnv[name];
    const deps = await import('@/lib/rag/deps');
    deps.resetRagDepsForTests();
    vi.restoreAllMocks();
  });

  function useEnv(pipeline: Pipeline, extra: Record<string, string> = {}): void {
    for (const name of Object.keys(V2_SWITCHES)) delete processEnv[name];
    delete processEnv.RAG_EMBED_TENANT;
    if (pipeline === 'v2') Object.assign(processEnv, V2_SWITCHES);
    else processEnv.RAG_PIPELINE = 'legacy';
    processEnv.RAG_VOICE_TOKEN_SECRET = VOICE_SECRET;
    Object.assign(processEnv, extra);
  }

  /** Loads a route and installs, in the registry that route uses, the fake quality reranker and the fixture translator. */
  async function load<T>(path: string, pipeline: Pipeline): Promise<T> {
    const route = await fixture.loadRoute<T>(path);
    if (pipeline === 'v2') {
      const select = await import('@/lib/rag/rerank/select');
      const { createCohereReranker } = await import('@/lib/rag/rerank/cohere');
      const recordingFetch: typeof fetch = async (input, init) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { query: string; documents: string[] };
        rerankBodies.push({ query: body.query, documents: body.documents });
        return fetch(input, init);
      };
      select.setRerankerFactoryForTests((_provider, _model, vars) =>
        createCohereReranker({ fetch: recordingFetch, apiKey: vars.COHERE_API_KEY ?? '', baseUrl: vars.COHERE_BASE_URL ?? '', model: 'fake-quality-v1' }),
      );
      const translate = await import('@/lib/rag/query/translate');
      translate.setTranslatorForTests(
        translate.createFixtureTranslator({
          version: 1,
          entries: [{ question: V2_TRANSLATED_QUESTION, translations: [{ language: 'it', text: V2_TRANSLATED_TEXT }] }],
        }),
      );
    }
    return route;
  }

  function tenant(label: V2TenantLabel) {
    return seed.tenants[label];
  }

  async function runChat(pipeline: Pipeline, label: V2TenantLabel, question: string, ragMode: 'strict' | 'balanced'): Promise<Observed> {
    h.capture.reset();
    logs = [];
    useEnv(pipeline);
    const { POST } = await load<{ POST: (request: NextRequest) => Promise<Response> }>('chat', pipeline);
    h.session.userId = tenant(label).userId;
    const response = await POST(
      chatRequest({
        messages: [{ role: 'user', content: question }],
        data: { ragMode, organizationId: tenant(label).organizationId, settings: { webSearch: false, model } },
      }),
    );
    const body = await response.text();
    return { prompt: h.capture.calls.length > 0 ? systemTextOf(h.capture.calls[0]) : '', body, logs: logs.join('\n') };
  }

  async function runEmbed(pipeline: Pipeline, label: V2TenantLabel, question: string): Promise<Observed> {
    h.capture.reset();
    logs = [];
    useEnv(pipeline, { RAG_EMBED_TENANT: tenant(label).scopeKey });
    const { POST } = await load<{ POST: (request: NextRequest) => Promise<Response> }>('embed/chat', pipeline);
    const response = await POST(
      new NextRequest('http://localhost/api/embed/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
        body: JSON.stringify({ messages: [{ role: 'user', content: question }] }),
      }),
    );
    const body = await response.text();
    return { prompt: h.capture.calls.length > 0 ? systemTextOf(h.capture.calls[0]) : '', body, logs: logs.join('\n') };
  }

  async function runVoice(pipeline: Pipeline, label: V2TenantLabel, question: string): Promise<Observed & { json: { results?: Array<{ content: string; chunk_id: string }>; source_images?: Array<{ url?: string }> } }> {
    logs = [];
    useEnv(pipeline);
    const { POST } = await load<{ POST: (request: NextRequest) => Promise<Response> }>('internal/voice-rag', pipeline);
    const t = tenant(label);
    const minted = mintVoiceToken({ scope: mintScope(t.organizationId ? 'org' : 'personal', t.userId, t.organizationId), secret: VOICE_SECRET, ttlSeconds: 600 });
    if (!minted.ok) throw new Error(`mint failed: ${minted.reason}`);
    const response = await POST(
      new NextRequest('http://localhost/api/internal/voice-rag', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': INTERNAL_API_KEY, 'x-rag-scope-token': minted.token },
        body: JSON.stringify({ query: question, matchCount: 5 }),
      }),
    );
    const body = await response.text();
    return { prompt: '', body, logs: logs.join('\n'), json: JSON.parse(body) };
  }

  function observe(route: RouteKind, pipeline: Pipeline, label: V2TenantLabel, question: string): Promise<Observed> {
    if (route === 'chat strict') return runChat(pipeline, label, question, 'strict');
    if (route === 'chat balanced') return runChat(pipeline, label, question, 'balanced');
    if (route === 'embed') return runEmbed(pipeline, label, question);
    return runVoice(pipeline, label, question);
  }

  function ownMarkers(pipeline: Pipeline, label: V2TenantLabel): string[] {
    const t = tenant(label);
    return pipeline === 'legacy' ? [LEGACY_PHRASES[label]] : [t.markers.child, t.markers.parent];
  }

  function expectNoForeign(label: V2TenantLabel, observed: Observed, where: string): void {
    const surfaces: Record<string, string> = { prompt: observed.prompt, body: observed.body, logs: observed.logs };
    for (const marker of foreignMarkers(seed, label)) {
      for (const [name, text] of Object.entries(surfaces)) {
        expect(text.toLowerCase().includes(marker.toLowerCase()), `${where}: ${name} holds foreign marker ${marker}`).toBe(false);
      }
    }
  }

  for (const pipeline of PIPELINES) {
    for (const route of ROUTES) {
      for (const label of LABELS) {
        it(`RAG_PIPELINE=${pipeline} ${route}, tenant ${label}: only the caller text reaches the model, the response and the logs`, async () => {
          const where = `${pipeline}/${route}/${label}`;
          const observed = await observe(route, pipeline, label, QUESTION);
          expectNoForeign(label, observed, where);

          const own = ownMarkers(pipeline, label);
          const seen = route === 'voice-rag' ? observed.body : observed.prompt;
          expect(own.some((marker) => seen.toLowerCase().includes(marker.toLowerCase())), `${where}: own canary text reaches the consumer`).toBe(true);

          if (route === 'voice-rag') {
            const voice = (observed as Awaited<ReturnType<typeof runVoice>>).json;
            const ids = (voice.results ?? []).map((row) => row.chunk_id);
            expect(ids.length).toBeGreaterThan(0);
            const ownImages = label === 'o' ? [tenant(label).imageUrl, LOGO_URL] : [tenant(label).imageUrl];
            for (const image of voice.source_images ?? []) {
              if (typeof image.url === 'string') expect(ownImages, `${where}: source image ${image.url}`).toContain(image.url);
            }
          }
        });
      }
    }
  }

  for (const pipeline of PIPELINES) {
    it(`RAG_PIPELINE=${pipeline}: strict chat for tenant a asking what only tenant b holds answers information not available`, async () => {
      const own = await runChat(pipeline, 'b', B_ONLY_QUESTION, 'strict');
      expect(own.prompt, 'control: the owner finds the contract text').toContain(B_ONLY_MARKER);

      const foreign = await runChat(pipeline, 'a', B_ONLY_QUESTION, 'strict');
      expect(h.capture.calls, 'the model is never called').toHaveLength(0);
      expect(readSseText(foreign.body)).toContain(UNAVAILABLE);
      expectNoForeign('a', foreign, `${pipeline}/strict unavailable`);
      expect(foreign.body.toLowerCase()).not.toContain(B_ONLY_MARKER);
      expect(foreign.logs.toLowerCase()).not.toContain(B_ONLY_MARKER);
    });

    it(`RAG_PIPELINE=${pipeline}: embed for tenant a asking what only tenant b holds sends nothing of b to the model`, async () => {
      const foreign = await runEmbed(pipeline, 'a', B_ONLY_QUESTION);
      expectNoForeign('a', foreign, `${pipeline}/embed unavailable`);
      expect(foreign.prompt.toLowerCase()).not.toContain(B_ONLY_MARKER);
      expect(foreign.body.toLowerCase()).not.toContain(B_ONLY_MARKER);
    });

    it(`RAG_PIPELINE=${pipeline}: voice-rag for tenant a asking what only tenant b holds returns nothing of b`, async () => {
      const foreign = await runVoice(pipeline, 'a', B_ONLY_QUESTION);
      expectNoForeign('a', foreign, `${pipeline}/voice unavailable`);
      expect(foreign.body.toLowerCase()).not.toContain(B_ONLY_MARKER);
    });
  }

  it('RAG_PIPELINE=v2: a translated question returns the caller Italian text only and the rerank input stays the caller', async () => {
    const before = rerankBodies.length;
    for (const label of LABELS) {
      const observed = await runChat('v2', label, V2_TRANSLATED_QUESTION, 'balanced');
      expectNoForeign(label, observed, `translated/${label}`);
      expect(observed.prompt.toLowerCase()).toContain(tenant(label).markers.translated.toLowerCase());
    }
    const sent = rerankBodies.slice(before);
    expect(sent.length).toBeGreaterThanOrEqual(LABELS.length);
    for (const body of sent) {
      const text = JSON.stringify(body.documents).toLowerCase();
      const owners = LABELS.filter((label) => text.includes(tenant(label).markers.translated.toLowerCase()));
      expect(owners.length, 'one rerank request never mixes the Italian chunks of two tenants').toBeLessThanOrEqual(1);
    }
  });

  type Framework = 'llamaindex' | 'langchain';
  const FRAMEWORKS: Framework[] = ['llamaindex', 'langchain'];
  const LAYER_KEYWORDS = 'isolation canary handbook';
  const LAYER_HISTORY = [
    { role: 'user' as const, content: 'Tell me about the two tenant isolation canary handbook.' },
    { role: 'assistant' as const, content: 'The handbook lists its canary clauses.' },
  ];
  const LAYER_FOLLOW_UP = 'Which clause does it list first?';
  const LAYER_TABLE = {
    version: 1 as const,
    entries: [
      {
        transform: 'condense' as const,
        query: LAYER_FOLLOW_UP,
        output: { standalone: 'Which clause does the two tenant isolation canary handbook list first?', unchanged: false },
      },
      { transform: 'expand' as const, query: LAYER_KEYWORDS, output: { queries: ['two tenant isolation canary phrase clause'] } },
      { transform: 'hyde' as const, query: LAYER_KEYWORDS, output: { passage: 'Two tenant isolation canary phrase: clause one of the handbook.' } },
    ],
  };
  const layerEnv = (framework: Framework): Record<string, string> => ({
    RAG_QUERY_LAYER: 'true',
    RAG_QUERY_FRAMEWORK: framework,
    RAG_QUERY_HYDE: 'true',
  });

  interface LayerFakes {
    calls: () => Array<{ transform: string }>;
    other: () => number;
  }

  /** Loads a v2 route with the query layer on and installs, in that route's module registry, the fake query models. */
  async function loadWithLayer<T>(path: string, framework: Framework): Promise<{ route: T; fakes: LayerFakes }> {
    const route = await load<T>(path, 'v2');
    const deps = await import('@/lib/rag/deps');
    const transformer = await import('@/lib/rag/query/transformer');
    const { createFakeLangChainChatModel } = await import('@/lib/rag/query/langchain/fake');
    const { createFakeQueryLlm } = await import('../../../eval/harness/fake-query-llm.mts');
    const native = createFakeQueryLlm({ table: LAYER_TABLE });
    const langchain = createFakeLangChainChatModel({ table: LAYER_TABLE });
    deps.setRagDepsForTests({ queryLlm: () => native });
    transformer.setLangChainChatModelFactoryForTests(() => langchain);
    const pick = (which: Framework) => (which === 'langchain' ? langchain.calls : native.calls);
    return {
      route,
      fakes: {
        calls: () => pick(framework),
        other: () => pick(framework === 'langchain' ? 'llamaindex' : 'langchain').length,
      },
    };
  }

  for (const framework of FRAMEWORKS) {
    for (const label of LABELS) {
      it(`RAG_QUERY_LAYER on, ${framework}: chat with history in tenant ${label} condenses and keeps only the caller text`, async () => {
        const where = `layer/${framework}/chat/${label}`;
        h.capture.reset();
        logs = [];
        useEnv('v2', layerEnv(framework));
        const { route, fakes } = await loadWithLayer<{ POST: (request: NextRequest) => Promise<Response> }>('chat', framework);
        h.session.userId = tenant(label).userId;
        const response = await route.POST(
          chatRequest({
            messages: [...LAYER_HISTORY, { role: 'user', content: LAYER_FOLLOW_UP }],
            data: { ragMode: 'balanced', organizationId: tenant(label).organizationId, settings: { webSearch: false, model } },
          }),
        );
        const observed: Observed = { prompt: h.capture.calls.length > 0 ? systemTextOf(h.capture.calls[0]) : '', body: await response.text(), logs: logs.join('\n') };
        expectNoForeign(label, observed, where);
        expect(fakes.calls().map((call) => call.transform), `${where}: the ${framework} model condensed`).toContain('condense');
        expect(fakes.other(), `${where}: the other framework stays unused`).toBe(0);
        expect(ownMarkers('v2', label).some((marker) => observed.prompt.toLowerCase().includes(marker.toLowerCase())), `${where}: own text`).toBe(true);
      });

      it(`RAG_QUERY_LAYER on, ${framework}: embed in tenant ${label} expands and keeps only the caller text`, async () => {
        const where = `layer/${framework}/embed/${label}`;
        h.capture.reset();
        logs = [];
        useEnv('v2', { ...layerEnv(framework), RAG_EMBED_TENANT: tenant(label).scopeKey });
        const { route, fakes } = await loadWithLayer<{ POST: (request: NextRequest) => Promise<Response> }>('embed/chat', framework);
        const response = await route.POST(
          new NextRequest('http://localhost/api/embed/chat', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
            body: JSON.stringify({ messages: [{ role: 'user', content: LAYER_KEYWORDS }] }),
          }),
        );
        const observed: Observed = { prompt: h.capture.calls.length > 0 ? systemTextOf(h.capture.calls[0]) : '', body: await response.text(), logs: logs.join('\n') };
        expectNoForeign(label, observed, where);
        expect(fakes.calls().map((call) => call.transform), `${where}: the ${framework} model expanded`).toContain('expand');
        expect(fakes.other(), `${where}: the other framework stays unused`).toBe(0);
        expect(ownMarkers('v2', label).some((marker) => observed.prompt.toLowerCase().includes(marker.toLowerCase())), `${where}: own text`).toBe(true);
      });
    }
  }

  for (const label of LABELS) {
    it(`RAG_QUERY_LAYER on: voice-rag with bound history in tenant ${label} condenses natively and returns only the caller text`, async () => {
      const where = `layer/voice/${label}`;
      logs = [];
      useEnv('v2', layerEnv('langchain'));
      const { route, fakes } = await loadWithLayer<{ POST: (request: NextRequest) => Promise<Response> }>('internal/voice-rag', 'llamaindex');
      const t = tenant(label);
      const minted = mintVoiceToken({ scope: mintScope(t.organizationId ? 'org' : 'personal', t.userId, t.organizationId), secret: VOICE_SECRET, ttlSeconds: 600 });
      if (!minted.ok) throw new Error(`mint failed: ${minted.reason}`);
      const binding = crypto.createHash('sha256').update(minted.token).digest('base64url').slice(0, 22);
      const response = await route.POST(
        new NextRequest('http://localhost/api/internal/voice-rag', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': INTERNAL_API_KEY, 'x-rag-scope-token': minted.token },
          body: JSON.stringify({ query: LAYER_FOLLOW_UP, matchCount: 5, history: LAYER_HISTORY.map((turn) => ({ ...turn, binding })) }),
        }),
      );
      const body = await response.text();
      expect(response.status, `${where}: ${body.slice(0, 200)}`).toBe(200);
      const json = JSON.parse(body) as { results?: Array<{ chunk_id: string; content: string }> };
      expectNoForeign(label, { prompt: '', body, logs: logs.join('\n') }, where);
      expect(fakes.calls().map((call) => call.transform), `${where}: voice condenses on the native model even with langchain configured`).toContain('condense');
      expect(fakes.other(), `${where}: voice never loads LangChain`).toBe(0);
      expect((json.results ?? []).length).toBeGreaterThan(0);
      expect(ownMarkers('v2', label).some((marker) => body.toLowerCase().includes(marker.toLowerCase())), `${where}: own text`).toBe(true);
    });
  }

  it('every v2 rerank request carries the text of one tenant only', () => {
    expect(rerankBodies.length).toBeGreaterThan(0);
    for (const body of rerankBodies) {
      const text = JSON.stringify(body.documents).toLowerCase();
      const owners = LABELS.filter(
        (label) => Object.values(tenant(label).markers).some((marker) => text.includes(marker.toLowerCase())) || text.includes(LEGACY_PHRASES[label]),
      );
      expect(owners.length, 'rerank input mixes tenants').toBeLessThanOrEqual(1);
    }
  });

  it('the fixture edge saw no unsupported retrieval, document or chunk request (organization settings reads are the chat route own)', () => {
    const retrieval = fixture.edge.errors.filter((error) => error.url.includes('/rpc/') || error.url.includes('document') || error.url.includes('/v2/rerank'));
    expect(retrieval).toEqual([]);
    expect(TWO_TENANT_IDS.userA).toBe(tenant('a').userId);
  });
});
