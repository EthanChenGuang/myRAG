import crypto from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';
import { mintScope, scopeKey } from '@/lib/rag/tenant/scope';
import { mintVoiceToken } from '@/lib/rag/tenant/voice-token';
import { OUTPUT_POLICY_NOTICE, OUTPUT_POLICY_NOTICE_UNTAGGED, REFERENCE_NOTICE, REFERENCE_REMINDER } from '@/lib/rag/context/wrap';
import { fixedText } from '@/lib/rag/lang/texts';
import { NO_ANSWER_SENTINEL } from '@/lib/rag/generation/sentinel';
import { INTERNAL_API_KEY } from '../helpers/route-fixture';
import { opsOf, recordingAdmin, type RecordedCall } from './helpers/recording-admin';

const h = vi.hoisted(() => ({
  admin: null as unknown,
  guardEvents: [] as Array<{ summary: Record<string, unknown>; context: Record<string, unknown> }>,
}));

vi.mock('@/lib/rag/security/security-events', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rag/security/security-events')>()),
  recordOutputGuardEvents: (summary: Record<string, unknown>, context: Record<string, unknown>) => {
    h.guardEvents.push({ summary: { ...summary }, context });
  },
}));

const SECRET = crypto.randomBytes(24).toString('hex');
const QUERY = 'two tenant isolation canary phrase';

const SWITCHES = [
  'RAG_PARTIAL_ANSWER_RULE',
  'RAG_CONTEXT_RELEVANCE_RULE',
  'RAG_VERSION_LABELS',
  'RAG_MAX_OUTPUT_TOKENS',
  'RAG_OUTPUT_GUARD',
  'RAG_OUTPUT_LINK_ALLOWLIST',
  'RAG_CONTEXT_TAGGING',
  'RAG_SUPPORTED_LANGUAGES',
  'RAG_PRIMARY_LANGUAGE',
] as const;
type SwitchName = (typeof SWITCHES)[number];

function setEnv(values: Partial<Record<SwitchName, string>>) {
  for (const name of SWITCHES) delete process.env[name];
  Object.assign(process.env, values);
}

const LANGUAGES = { RAG_SUPPORTED_LANGUAGES: 'zh,en,it', RAG_PRIMARY_LANGUAGE: 'en' } as const;
const EVERYTHING = {
  ...LANGUAGES,
  RAG_PARTIAL_ANSWER_RULE: 'true',
  RAG_CONTEXT_RELEVANCE_RULE: 'true',
  RAG_VERSION_LABELS: 'true',
  RAG_MAX_OUTPUT_TOKENS: '700',
  RAG_OUTPUT_GUARD: 'enforce',
} as const;

function token(scope: ReturnType<typeof mintScope>, actorUserId?: string): string {
  const minted = mintVoiceToken({ scope, secret: SECRET, ttlSeconds: 600, ...(actorUserId ? { actorUserId } : {}) });
  if (!minted.ok) throw new Error(`mint failed: ${minted.reason}`);
  return minted.token;
}

interface RouteModule {
  POST(req: NextRequest): Promise<Response>;
}

type VoiceBody = {
  results?: Array<{ chunk_id: string; document_id: string; content: string }>;
  source_images?: unknown[];
  context?: string;
  traceId?: string;
};

/** The agent's own context format when the response carries no context (voice-agent/src/rag_client.ts). */
function agentFallbackContext(results: NonNullable<VoiceBody['results']>): string {
  return results.map((result) => `[Context from document ${result.document_id}]: ${result.content}`).join('\n\n');
}

describe('voice-rag: the composed voice block in the context string (05.2-33)', () => {
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
    setEnv({});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    setEnv({});
    vi.restoreAllMocks();
  });

  async function ask(query = QUERY): Promise<VoiceBody> {
    vi.resetModules();
    const { POST } = (await import('@/app/api/internal/voice-rag/route')) as unknown as RouteModule;
    const response = await POST(
      new NextRequest('http://localhost/api/internal/voice-rag', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': INTERNAL_API_KEY, 'x-rag-scope-token': token(mintScope('personal', TWO_TENANT_IDS.userA, null)) },
        body: JSON.stringify({ query, matchCount: 5 }),
      }),
    );
    expect(response.status).toBe(200);
    return (await response.json()) as VoiceBody;
  }

  it('all switches off: the body is what it is today, with and without tagging', async () => {
    const plain = await ask();
    expect(Object.keys(plain).sort()).toEqual(['results', 'source_images', 'traceId']);
    setEnv({ RAG_CONTEXT_TAGGING: 'true' });
    const tagged = await ask();
    expect(tagged.context?.endsWith(REFERENCE_REMINDER)).toBe(true);
    expect(tagged.context).not.toContain('[rule:');
  });

  it('switches on with tagging: the reminder is followed by the voice block with the spoken phrase and no chat-only part', async () => {
    setEnv({ ...EVERYTHING, RAG_CONTEXT_TAGGING: 'true' });
    const body = await ask();
    const context = body.context ?? '';
    expect(context.startsWith(REFERENCE_NOTICE)).toBe(true);
    const [documents, block] = context.split(`${REFERENCE_REMINDER}\n\n`);
    expect(documents).toContain('alpha personal notes');
    expect(block).toBeDefined();
    expect(block!.startsWith('[rule:relevance]\n')).toBe(true);
    expect([...block!.matchAll(/^\[rule:([a-z_]+)\]$/gm)].map((match) => match[1])).toEqual(['relevance', 'partial_answer', 'version', 'output_policy']);
    expect(block).toContain(fixedText('labels.not_covered', 'en'));
    expect(block!.endsWith(OUTPUT_POLICY_NOTICE)).toBe(true);
    expect(context).not.toContain(NO_ANSWER_SENTINEL);
    expect(context).not.toContain(fixedText('instructions.citation', 'en'));
  });

  it('switches on without tagging: the context is the agent fallback format followed by the block', async () => {
    setEnv(EVERYTHING);
    const body = await ask();
    expect(body.results?.length).toBeGreaterThan(0);
    const fallback = agentFallbackContext(body.results!);
    expect(body.context?.startsWith(`${fallback}\n\n[rule:relevance]\n`)).toBe(true);
    expect(body.context?.endsWith(OUTPUT_POLICY_NOTICE_UNTAGGED)).toBe(true);
    expect(body.context).not.toContain(NO_ANSWER_SENTINEL);
  });

  it('no result: no context field, whatever the switches', async () => {
    setEnv({ ...EVERYTHING, RAG_CONTEXT_TAGGING: 'true' });
    const body = await ask('zzqx vlorpt mbrank unrelated nonsense');
    if ((body.results ?? []).length === 0) expect(body.context).toBeUndefined();
  });
});

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const MESSAGES = [
  { role: 'user', content: 'Where is the setup page?' },
  { role: 'assistant', content: 'The setup page is at https://not-allowed.test/setup for details.' },
  { role: 'user', content: 'Thanks.' },
  { role: 'assistant', content: 'See https://allowed.test/page as well.' },
];

describe('voice-chat: post-hoc flag check of the stored turn (05.2-33)', () => {
  const previous = { ...process.env } as Record<string, string | undefined>;
  let calls: RecordedCall[] = [];

  function respond(call: RecordedCall) {
    if (call.table === 'chats') {
      const row = (opsOf(call, 'insert')[0]?.[0] ?? {}) as { id?: string; title?: string };
      return { data: { id: row.id ?? 'chat-id', title: row.title ?? 'Voice conversation' }, error: null };
    }
    return { data: null, error: null };
  }

  beforeEach(() => {
    process.env.MYRAG_INTERNAL_API_KEY = INTERNAL_API_KEY;
    process.env.RAG_VOICE_TOKEN_SECRET = SECRET;
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    const recorded = recordingAdmin(respond);
    calls = recorded.calls;
    h.admin = recorded.admin;
    h.guardEvents.length = 0;
    setEnv({});
    vi.doMock('@/lib/supabase', () => ({ getSupabaseAdmin: () => h.admin }));
    vi.doMock('@/lib/title-generator', () => ({ generateTitle: () => 'Voice conversation', generateSmartTitle: async () => null }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('@/lib/supabase');
    vi.doUnmock('@/lib/title-generator');
    for (const name of Object.keys(process.env)) {
      if (!(name in previous)) delete process.env[name];
    }
    Object.assign(process.env, previous);
  });

  async function save(messages: unknown[]) {
    vi.resetModules();
    const { POST } = (await import('@/app/api/internal/voice-chat/route')) as unknown as RouteModule;
    const response = await POST(
      new NextRequest('http://localhost/api/internal/voice-chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': INTERNAL_API_KEY, 'x-rag-scope-token': token(mintScope('personal', USER_A, null)) },
        body: JSON.stringify({ messages }),
      }),
    );
    expect(response.status).toBe(200);
    return calls.filter((call) => call.table === 'chats').flatMap((call) => opsOf(call, 'insert').map((args) => args[0] as Record<string, unknown>));
  }

  it('guard off: no check, the turn is stored as sent', async () => {
    const rows = await save(MESSAGES);
    expect(rows[0]!.messages).toEqual(MESSAGES);
    expect(h.guardEvents).toHaveLength(0);
  });

  it.each(['flag', 'enforce'])('guard %s: events in flag behaviour for channel voice, the stored text unchanged', async (mode) => {
    setEnv({ ...LANGUAGES, RAG_OUTPUT_GUARD: mode, RAG_OUTPUT_LINK_ALLOWLIST: 'allowed.test' });
    const rows = await save(MESSAGES);
    expect(rows[0]!.messages).toEqual(MESSAGES);
    expect(h.guardEvents).toHaveLength(1);
    const event = h.guardEvents[0]!;
    expect(event.summary).toMatchObject({ mode: 'flag', links_removed: 1 });
    expect(event.context).toMatchObject({
      channel: 'voice',
      tenantKey: scopeKey(mintScope('personal', USER_A, null)),
      removedTargets: ['https://not-allowed.test/setup'],
    });
  });

  it('a link the user said first is allowed for the assistant turn after it', async () => {
    setEnv({ ...LANGUAGES, RAG_OUTPUT_GUARD: 'enforce' });
    await save([
      { role: 'user', content: 'Is https://user-named.test/page right?' },
      { role: 'assistant', content: 'Yes, https://user-named.test/page is the page.' },
    ]);
    expect(h.guardEvents).toHaveLength(0);
  });
});
