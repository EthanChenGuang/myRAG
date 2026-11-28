import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '@/lib/env';
import {
  ACCESS_IDS,
  ACCESS_LANGUAGES,
  childQuery,
  leakedMarkers,
  removeMember,
  addMember,
  seedAccessGroups,
  type AccessGroupsSeed,
  type AccessLanguage,
} from '../../../eval/harness/access-groups.mts';
import type { DeploymentMode } from '../../../eval/harness/pglite-supabase.mts';
import { chatRequest } from '../../helpers/chat-route-fakes';
import { INTERNAL_API_KEY, startRouteFixture, systemTextOf, type RouteFixture } from '../../helpers/route-fixture';

// Phase 4.3 plan 52 (EVAL-21, SEC-12 criterion 2; D-06, D-07, D-27, D-32): route-level same-tenant canaries through the fake edge. One
// tenant per deployment mode holds group-a and group-b, member-a, member-b, an outsider and an admin, and per language (zh, en, it) a
// neutral synthetic document restricted to group-a (eval/harness/access-groups.mts). With RAG_DOC_ACCESS_GROUPS=on, the chat, embed,
// voice-rag and eval-run routes never return a restricted marker to the outsider, a body claim of group-a changes nothing, embedded chat
// sees group-a only when RAG_EMBED_ACCESS_GROUP names it, voice resolves the token's user on every turn, member-a gets the answer and the
// share route refuses a chat citing the restricted document. Each leak check serialises the prompt, the whole response and the log lines.

const h = await vi.hoisted(async () => {
  const fakes = await import('../../helpers/chat-route-fakes');
  const session: { userId: string | null } = { userId: null };
  const share: { userId: string | null; chat: Record<string, unknown> | null; updates: number } = { userId: null, chat: null, updates: 0 };
  return {
    capture: fakes.createStreamTextCapture(),
    exa: fakes.createExaFake(),
    session,
    share,
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

/**
 * The share route builds a user client with the anon key and the caller's bearer token; that client answers the session user and the
 * chat row. Every other client (the service-role admin client) is the real one against the fake edge, so the label reads are real.
 */
vi.mock('@supabase/supabase-js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@supabase/supabase-js')>();
  const userClient = () => {
    const chain = {
      select: () => chain,
      update: () => {
        h.share.updates += 1;
        return chain;
      },
      eq: () => chain,
      single: async () => ({ data: h.share.chat, error: h.share.chat ? null : { message: 'not found' } }),
      then: (ok: (value: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(ok),
    };
    return {
      auth: { getUser: async () => ({ data: { user: h.share.userId ? { id: h.share.userId } : null }, error: null }) },
      from: () => chain,
    };
  };
  return {
    ...actual,
    createClient: ((url: string, key: string, options?: { global?: { headers?: Record<string, string> } }) =>
      key === process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY && options?.global?.headers?.Authorization
        ? userClient()
        : actual.createClient(url, key, options as never)) as typeof actual.createClient,
  };
});

type Pipeline = 'legacy' | 'v2';
type Who = 'outsider' | 'memberA';

const MODES: DeploymentMode[] = ['multi-tenant', 'single-tenant'];
const PIPELINES: Pipeline[] = ['legacy', 'v2'];
const VOICE_SECRET = crypto.randomBytes(24).toString('hex');
const EVAL_SECRET = crypto.randomBytes(24).toString('hex');
const UNAVAILABLE = 'Information Not Available';
/** The Phase 3.3 attribute resolver (1008) is not filtered yet; rag_access_readiness names it until a later file does (plan 51, SEAMS). */
const PENDING_1008 = new Set(['rag_attribute_filter_values', 'rag_attribute_documents']);
const processEnv = process.env as Record<string, string | undefined>;
const ROUTE_ENV = ['RAG_PIPELINE', 'RAG_DOC_ACCESS_GROUPS', 'RAG_EMBED_ACCESS_GROUP', 'RAG_EMBED_TENANT', 'RAG_VOICE_TOKEN_SECRET', 'RAG_EVAL_SECRET', 'RAG_EVAL_ALLOWED_SCOPES'];

type RpcRequestLike = PromiseLike<{ data: unknown; error: unknown }> & { abortSignal(signal: AbortSignal): RpcRequestLike };

/** The real readiness answer without the pending 1008 objects (and only those), as in the pgvector canary matrix. */
function withoutPendingReadiness(client: SupabaseClient): SupabaseClient {
  const filtered = (request: RpcRequestLike): RpcRequestLike => {
    const pending = Promise.resolve(request).then((response) => {
      const row = (Array.isArray(response.data) ? response.data[0] : response.data) as { reasons?: string[]; objects?: string[] } | undefined;
      if (!row || response.error || !Array.isArray(row.objects) || !Array.isArray(row.reasons)) return response;
      const keep = row.objects.map((name) => !PENDING_1008.has(name));
      const objects = row.objects.filter((_, index) => keep[index]);
      return { ...response, data: [{ ready: objects.length === 0, reasons: row.reasons.filter((_, index) => keep[index]), objects }] };
    });
    return { abortSignal: (signal) => filtered(request.abortSignal(signal)), then: (a, b) => pending.then(a, b) };
  };
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'rpc') {
        return (fn: string, args?: Record<string, unknown>, opts?: Parameters<SupabaseClient['rpc']>[2]) => {
          const request = target.rpc(fn, args, opts) as unknown as RpcRequestLike;
          return fn === 'rag_access_readiness' ? filtered(request) : request;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function configuredModelId(): string {
  const models = JSON.parse(env.NEXT_PUBLIC_OPENROUTER_MODELS) as Array<{ id: string }>;
  return models.map((entry) => entry.id).find((id) => !/gpt-4|o1|chatgpt/.test(id) && !id.includes('claude')) ?? models[0]!.id;
}

interface Observed {
  status: number;
  prompt: string;
  body: string;
  logs: string;
}

for (const mode of MODES) {
  const multi = mode === 'multi-tenant';

  describe(`route-level same-tenant access canaries (${mode})`, () => {
    let fixture: RouteFixture;
    let db: PGlite;
    let seed: AccessGroupsSeed;
    let logs: string[] = [];
    let model = '';
    const userOf: Record<Who, string> = { outsider: ACCESS_IDS.outsider, memberA: ACCESS_IDS.memberA };

    beforeAll(async () => {
      fixture = await startRouteFixture({
        deploymentMode: mode,
        documentFilenameFilter: true,
        seed: async (database) => {
          db = database;
          seed = await seedAccessGroups(database, mode);
        },
      });
      model = configuredModelId();
    });

    afterAll(async () => {
      await fixture?.close();
    });

    beforeEach(() => {
      h.capture.reset();
      h.exa.reset();
      h.session.userId = null;
      h.share.userId = null;
      h.share.chat = null;
      h.share.updates = 0;
      logs = [];
      for (const method of ['log', 'warn', 'error', 'info', 'debug'] as const) {
        vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
          logs.push(JSON.stringify(args));
        });
      }
    });

    afterEach(() => {
      for (const name of ROUTE_ENV) delete processEnv[name];
      vi.restoreAllMocks();
    });

    function useEnv(pipeline: Pipeline, extra: Record<string, string> = {}): void {
      for (const name of ROUTE_ENV) delete processEnv[name];
      processEnv.RAG_PIPELINE = pipeline;
      processEnv.RAG_DOC_ACCESS_GROUPS = 'on';
      processEnv.RAG_VOICE_TOKEN_SECRET = VOICE_SECRET;
      Object.assign(processEnv, extra);
    }

    /** Loads a route in a fresh module registry and syncs the database flag through the product startup check (D-10, A-03). */
    async function load<T>(routePath: string): Promise<T> {
      const route = await fixture.loadRoute<T>(routePath);
      const startup = await import('@/lib/rag/tenant/access-startup');
      startup.resetAccessStartupForTests();
      const admin = withoutPendingReadiness(
        createClient(processEnv.NEXT_PUBLIC_SUPABASE_URL as string, processEnv.SUPABASE_SERVICE_ROLE_KEY as string, {
          auth: { persistSession: false, autoRefreshToken: false },
        }),
      );
      const verdict = await startup.verifyAccessGroupsStartup({ adminClient: () => admin as never });
      expect(verdict.status, `access startup: ${verdict.reasons.join(',')}`).toBe('ready');
      return route;
    }

    const observed = async (response: Response): Promise<Observed> => ({
      status: response.status,
      prompt: h.capture.calls.length > 0 ? systemTextOf(h.capture.calls[0]) : '',
      body: await response.text(),
      logs: logs.join('\n'),
    });

    function expectNoLeak(value: Observed, where: string): void {
      for (const [surface, text] of Object.entries({ prompt: value.prompt, body: value.body, logs: value.logs })) {
        expect(leakedMarkers(seed, text), `${where}: ${surface} holds a restricted marker`).toEqual([]);
      }
    }

    const marker = (language: AccessLanguage) => seed.languages[language].markers.child;
    const bodyClaims = (value: Observed) => value.logs.split('\n').filter((line) => line.includes('body_group_claim_ignored')).length;

    async function postChat(pipeline: Pipeline, who: Who, language: AccessLanguage, extra: Record<string, unknown> = {}): Promise<Observed> {
      useEnv(pipeline);
      const { POST } = await load<{ POST: (request: NextRequest) => Promise<Response> }>('chat');
      h.capture.reset();
      logs = [];
      h.session.userId = userOf[who];
      const response = await POST(
        chatRequest({
          messages: [{ role: 'user', content: childQuery(language) }],
          data: { ragMode: 'strict', ...(multi ? { organizationId: ACCESS_IDS.org } : {}), settings: { webSearch: false, model } },
          ...extra,
        }),
      );
      return observed(response);
    }

    async function postEmbed(language: AccessLanguage, group: string | null, extra: Record<string, unknown> = {}): Promise<Observed> {
      useEnv('legacy', { ...(multi ? { RAG_EMBED_TENANT: seed.tenantKey } : {}), ...(group !== null ? { RAG_EMBED_ACCESS_GROUP: group } : {}) });
      const { POST } = await load<{ POST: (request: NextRequest) => Promise<Response> }>('embed/chat');
      h.capture.reset();
      logs = [];
      const response = await POST(
        new NextRequest('http://localhost/api/embed/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
          body: JSON.stringify({ messages: [{ role: 'user', content: childQuery(language) }], ...extra }),
        }),
      );
      return observed(response);
    }

    async function voiceToken(who: Who): Promise<string> {
      const { mintScope } = await import('@/lib/rag/tenant/scope');
      const { mintVoiceToken } = await import('@/lib/rag/tenant/voice-token');
      const userId = userOf[who];
      const minted = multi
        ? mintVoiceToken({ scope: mintScope('org', userId, ACCESS_IDS.org), secret: VOICE_SECRET, ttlSeconds: 600 })
        : mintVoiceToken({ scope: mintScope('single', null, null), secret: VOICE_SECRET, ttlSeconds: 600, actorUserId: userId });
      if (!minted.ok) throw new Error(`[Access Canary] voice token: ${minted.reason}`);
      return minted.token;
    }

    async function postVoice(route: { POST: (request: NextRequest) => Promise<Response> }, token: string, language: AccessLanguage, extra: Record<string, unknown> = {}) {
      logs = [];
      const response = await route.POST(
        new NextRequest('http://localhost/api/internal/voice-rag', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': INTERNAL_API_KEY, 'x-rag-scope-token': token },
          body: JSON.stringify({ query: childQuery(language), matchCount: 5, ...extra }),
        }),
      );
      return observed(response);
    }

    async function postEvalRun(who: Who, language: AccessLanguage, extra: Record<string, unknown> = {}): Promise<Observed> {
      useEnv('legacy', { RAG_EVAL_SECRET: EVAL_SECRET, ...(multi ? { RAG_EVAL_ALLOWED_SCOPES: `org:${ACCESS_IDS.org}` } : {}) });
      const { POST } = await load<{ POST: (request: NextRequest) => Promise<Response> }>('internal/rag/run');
      logs = [];
      const response = await POST(
        new NextRequest('http://localhost/api/internal/rag/run', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-rag-eval-secret': EVAL_SECRET },
          body: JSON.stringify({
            schema_version: 1,
            query: childQuery(language),
            rag_mode: 'strict',
            options: { user_id: userOf[who], ...(multi ? { organization_id: ACCESS_IDS.org } : {}) },
            ...extra,
          }),
        }),
      );
      return observed(response);
    }

    for (const language of ACCESS_LANGUAGES) {
      for (const pipeline of PIPELINES) {
        it(`${language} ${pipeline} chat: the outsider gets information not available and no marker; member-a gets the answer`, async () => {
          const outsider = await postChat(pipeline, 'outsider', language);
          expectNoLeak(outsider, `${language}/${pipeline}/chat outsider`);
          expect(h.capture.calls, 'the model is never called for the outsider').toHaveLength(0);
          // The refusal is localized by the route's own language detection; its English text is pinned here.
          if (language === 'en') expect(outsider.body).toContain(UNAVAILABLE);

          const member = await postChat(pipeline, 'memberA', language);
          expect(member.prompt.toLowerCase(), `${language}/${pipeline}/chat member-a lost the restricted text`).toContain(marker(language));
        });
      }

      it(`${language} chat: an outsider body claiming group-a changes nothing and is logged once`, async () => {
        const claimed = await postChat('legacy', 'outsider', language, { accessGroups: [seed.groupAKey, 'group-a'], groups: [seed.groupAKey] });
        expectNoLeak(claimed, `${language}/chat body claim`);
        expect(h.capture.calls, 'the model is never called for the outsider').toHaveLength(0);
        if (language === 'en') expect(claimed.body).toContain(UNAVAILABLE);
        expect(bodyClaims(claimed)).toBe(1);
      });

      it(`${language} embed: unset and an unknown key see only documents labelled all; group-a configured sees the restricted text`, async () => {
        const unset = await postEmbed(language, null);
        expectNoLeak(unset, `${language}/embed unset`);
        const claimed = await postEmbed(language, null, { accessGroups: [seed.groupAKey] });
        expectNoLeak(claimed, `${language}/embed body claim`);
        expect(bodyClaims(claimed)).toBe(1);
        const unknown = await postEmbed(language, 'group-unknown');
        expectNoLeak(unknown, `${language}/embed unknown key`);
        expect(unknown.logs).toContain('embed_group_not_found');

        const configured = await postEmbed(language, 'group-a');
        expect(configured.prompt.toLowerCase(), `${language}/embed group-a lost the restricted text`).toContain(marker(language));
      });

      it(`${language} voice-rag: the token user decides; a membership removed between two turns applies on the second`, async () => {
        useEnv('legacy');
        const route = await load<{ POST: (request: NextRequest) => Promise<Response> }>('internal/voice-rag');
        const outsider = await postVoice(route, await voiceToken('outsider'), language);
        expect(outsider.status).toBe(200);
        expectNoLeak(outsider, `${language}/voice outsider`);
        const claimed = await postVoice(route, await voiceToken('outsider'), language, { accessGroups: [seed.groupAKey] });
        expectNoLeak(claimed, `${language}/voice body claim`);

        const token = await voiceToken('memberA');
        const first = await postVoice(route, token, language);
        expect(first.body.toLowerCase(), `${language}/voice member-a lost the restricted text`).toContain(marker(language));
        await removeMember(db, seed, seed.groupA, ACCESS_IDS.memberA);
        try {
          const second = await postVoice(route, token, language);
          expect(second.status).toBe(200);
          expectNoLeak(second, `${language}/voice after removal`);
        } finally {
          await addMember(db, seed, seed.groupA, ACCESS_IDS.memberA);
        }
      });

      it(`${language} eval run: the fixture identity decides and a body claim is refused before retrieval`, async () => {
        const outsider = await postEvalRun('outsider', language);
        expect(outsider.status, outsider.body.slice(0, 200)).toBe(200);
        expectNoLeak(outsider, `${language}/eval outsider`);
        const claimed = await postEvalRun('outsider', language, { accessGroups: [seed.groupAKey] });
        expect(claimed.status).toBe(400);
        expectNoLeak(claimed, `${language}/eval body claim`);
        expect(bodyClaims(claimed)).toBe(1);

        const member = await postEvalRun('memberA', language);
        expect(member.body.toLowerCase(), `${language}/eval member-a lost the restricted text`).toContain(marker(language));
      });
    }

    it('share: a chat citing the restricted document gets no link; a chat citing only the open document does', async () => {
      useEnv('legacy');
      const { POST } = await load<{ POST: (request: Request) => Promise<Response> }>('chats/share');
      const share = (documentId: string) => {
        h.share.userId = ACCESS_IDS.memberA;
        h.share.chat = {
          id: crypto.randomUUID(),
          user_id: ACCESS_IDS.memberA,
          share_id: null,
          messages: [{ role: 'assistant', content: 'A neutral synthetic answer.', metadata: { citations: [{ documentId }] } }],
        };
        return POST(
          new Request('http://localhost/api/chats/share', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: 'Bearer fixture-session-token-placeholder' },
            body: JSON.stringify({ chatId: h.share.chat.id }),
          }),
        );
      };

      const refused = await share(seed.languages.en.ids.doc);
      expect(refused.status).toBe(403);
      expect(await refused.json()).toEqual({ error: 'restricted_content' });
      expect(h.share.updates, 'no share id is written').toBe(0);

      const open = await share(ACCESS_IDS.controlDoc);
      expect(open.status).toBe(200);
      expect(typeof ((await open.json()) as { shareId?: unknown }).shareId).toBe('string');
    });

    it('the fake edge saw no unsupported retrieval, document, chunk or access request', () => {
      const errors = fixture.edge.errors.filter((error) => error.url.includes('/rpc/') || error.url.includes('document') || error.url.includes('answer_records'));
      expect(errors).toEqual([]);
    });
  });
}
