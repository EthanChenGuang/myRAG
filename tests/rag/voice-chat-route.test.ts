import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { mintScope } from '@/lib/rag/tenant/scope';
import { mintVoiceToken } from '@/lib/rag/tenant/voice-token';
import { opsOf, recordingAdmin, type RecordedCall } from './helpers/recording-admin';

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const USER_B = '00000000-0000-4000-8000-0000000000b1';
const ORG_O = '00000000-0000-4000-8000-0000000000c1';
const API_KEY = 'test-internal-api-key-placeholder';
const SECRET = crypto.randomBytes(24).toString('hex');
const OTHER_SECRET = crypto.randomBytes(24).toString('hex');

const state = vi.hoisted(() => ({ admin: null as unknown, members: new Set<string>() }));

vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => state.admin }));
vi.mock('@/lib/title-generator', () => ({
  generateTitle: () => 'Voice conversation',
  generateSmartTitle: async () => null,
}));

const MESSAGES = [
  { role: 'user', content: 'hello' },
  { role: 'assistant', content: 'hi there' },
];

interface RouteModule {
  POST(req: NextRequest): Promise<Response>;
}

let calls: RecordedCall[] = [];

function respond(call: RecordedCall) {
  if (call.table === 'organization_members') {
    const org = opsOf(call, 'eq').find((args) => args[0] === 'organization_id')?.[1];
    const user = opsOf(call, 'eq').find((args) => args[0] === 'user_id')?.[1];
    return { data: state.members.has(`${org}:${user}`) ? { organization_id: org } : null, error: null };
  }
  if (call.table === 'chats') {
    const row = (opsOf(call, 'insert')[0]?.[0] ?? {}) as { id?: string; title?: string };
    return { data: { id: row.id ?? 'chat-id', title: row.title ?? 'Voice conversation' }, error: null };
  }
  return { data: null, error: null };
}

async function loadRoute(mode: 'single-tenant' | 'multi-tenant'): Promise<RouteModule> {
  process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = mode;
  vi.resetModules();
  return (await import('@/app/api/internal/voice-chat/route')) as unknown as RouteModule;
}

function token(scope: ReturnType<typeof mintScope>, secret = SECRET, actorUserId?: string): string {
  const minted = mintVoiceToken({ scope, secret, ttlSeconds: 600, actorUserId });
  if (!minted.ok) throw new Error(`mint failed: ${minted.reason}`);
  return minted.token;
}

function request(body: Record<string, unknown>, scopeToken: string | null, apiKey = API_KEY): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-api-key': apiKey };
  if (scopeToken !== null) headers['x-rag-scope-token'] = scopeToken;
  return new NextRequest('http://localhost/api/internal/voice-chat', { method: 'POST', headers, body: JSON.stringify(body) });
}

const insertedRows = () => calls.filter((call) => call.table === 'chats').flatMap((call) => opsOf(call, 'insert').map((args) => args[0] as Record<string, unknown>));

describe('voice-chat route saves under the token tenant', () => {
  const previous = { ...process.env } as Record<string, string | undefined>;

  beforeEach(() => {
    process.env.MYRAG_INTERNAL_API_KEY = API_KEY;
    process.env.RAG_VOICE_TOKEN_SECRET = SECRET;
    const recorded = recordingAdmin(respond);
    calls = recorded.calls;
    state.admin = recorded.admin;
    state.members = new Set([`${ORG_O}:${USER_A}`]);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const name of Object.keys(process.env)) {
      if (!(name in previous)) delete process.env[name];
    }
    Object.assign(process.env, previous);
  });

  it('a personal token saves the chat under that user with no organization', async () => {
    const { POST } = await loadRoute('multi-tenant');
    const response = await POST(request({ messages: MESSAGES }, token(mintScope('personal', USER_A, null))));
    expect(response.status).toBe(200);
    const [row] = insertedRows();
    expect(row).toMatchObject({ user_id: USER_A, organization_id: null, messages: MESSAGES });
  });

  it('an organization token for a member saves under the user and the organization', async () => {
    const { POST } = await loadRoute('multi-tenant');
    const response = await POST(request({ messages: MESSAGES }, token(mintScope('org', USER_A, ORG_O))));
    expect(response.status).toBe(200);
    const [row] = insertedRows();
    expect(row).toMatchObject({ user_id: USER_A, organization_id: ORG_O });
  });

  it('ignores a body userId and organizationId that differ from the token', async () => {
    const { POST } = await loadRoute('multi-tenant');
    const response = await POST(request({ messages: MESSAGES, userId: USER_B, organizationId: ORG_O }, token(mintScope('personal', USER_A, null))));
    expect(response.status).toBe(200);
    const [row] = insertedRows();
    expect(row).toMatchObject({ user_id: USER_A, organization_id: null });
  });

  it('refuses a request without a token and writes nothing', async () => {
    const { POST } = await loadRoute('multi-tenant');
    const response = await POST(request({ messages: MESSAGES, userId: USER_B }, null));
    expect(response.status).toBe(401);
    expect(insertedRows()).toEqual([]);
  });

  it('refuses a forged token and writes nothing', async () => {
    const { POST } = await loadRoute('multi-tenant');
    const response = await POST(request({ messages: MESSAGES }, token(mintScope('personal', USER_A, null), OTHER_SECRET)));
    expect(response.status).toBe(401);
    expect(insertedRows()).toEqual([]);
  });

  it('refuses an organization token whose membership is gone', async () => {
    const { POST } = await loadRoute('multi-tenant');
    const response = await POST(request({ messages: MESSAGES }, token(mintScope('org', USER_B, ORG_O))));
    expect(response.status).toBe(403);
    expect(insertedRows()).toEqual([]);
  });

  it('a single-tenant token without an actor is refused as before for anonymous sessions', async () => {
    const { POST } = await loadRoute('single-tenant');
    const response = await POST(request({ messages: MESSAGES, userId: USER_A }, token(mintScope('single', null, null))));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Missing userId' });
    expect(insertedRows()).toEqual([]);
  });

  it('a single-tenant token with an actor saves under that actor with no organization', async () => {
    const { POST } = await loadRoute('single-tenant');
    const response = await POST(request({ messages: MESSAGES }, token(mintScope('single', null, null), SECRET, USER_A)));
    expect(response.status).toBe(200);
    const [row] = insertedRows();
    expect(row).toMatchObject({ user_id: USER_A, organization_id: null, messages: MESSAGES });
  });

  it('a single-tenant save ignores a body userId that differs from the actor', async () => {
    const { POST } = await loadRoute('single-tenant');
    const response = await POST(request({ messages: MESSAGES, userId: USER_B, organizationId: ORG_O }, token(mintScope('single', null, null), SECRET, USER_A)));
    expect(response.status).toBe(200);
    const [row] = insertedRows();
    expect(row).toMatchObject({ user_id: USER_A, organization_id: null });
  });

  it('a single-tenant token whose actor was swapped after signing is refused and writes nothing', async () => {
    const { POST } = await loadRoute('single-tenant');
    const [payloadB64, signature] = token(mintScope('single', null, null), SECRET, USER_A).split('.');
    const claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as Record<string, unknown>;
    const tampered = Buffer.from(JSON.stringify({ ...claims, act: USER_B }), 'utf8').toString('base64url');
    const response = await POST(request({ messages: MESSAGES }, `${tampered}.${signature}`));
    expect(response.status).toBe(401);
    expect(insertedRows()).toEqual([]);
  });

  it('a multi-tenant token whose actor is not the scope user is refused and writes nothing', async () => {
    const { POST } = await loadRoute('multi-tenant');
    const response = await POST(request({ messages: MESSAGES }, token(mintScope('personal', USER_A, null), SECRET, USER_B)));
    expect(response.status).toBe(401);
    expect(insertedRows()).toEqual([]);
  });

  it('keeps the message validation unchanged', async () => {
    const { POST } = await loadRoute('multi-tenant');
    const scopeToken = token(mintScope('personal', USER_A, null));

    const noAssistant = await POST(request({ messages: [{ role: 'user', content: 'hello' }] }, scopeToken));
    expect(noAssistant.status).toBe(400);
    expect(await noAssistant.json()).toEqual({ error: 'Conversation must have at least one user and one assistant message' });

    const empty = await POST(request({ messages: [] }, scopeToken));
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: 'Missing or invalid messages' });
    expect(insertedRows()).toEqual([]);
  });

  it('keeps the internal API key check', async () => {
    const { POST } = await loadRoute('multi-tenant');
    const response = await POST(request({ messages: MESSAGES }, token(mintScope('personal', USER_A, null)), 'wrong'));
    expect(response.status).toBe(401);
    expect(insertedRows()).toEqual([]);
  });
});
