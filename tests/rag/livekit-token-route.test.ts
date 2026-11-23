import crypto from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { env } from '@/lib/env';
import { setRagDepsForTests } from '@/lib/rag/deps';
import { verifyVoiceToken } from '@/lib/rag/tenant/voice-token';

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const USER_B = '00000000-0000-4000-8000-0000000000b1';
const ORG_O = '00000000-0000-4000-8000-0000000000c1';

const mode = vi.hoisted(() => ({ value: 'multi-tenant' as 'single-tenant' | 'multi-tenant' }));
const session = vi.hoisted(() => ({ user: null as { id: string } | null }));
const livekit = vi.hoisted(() => ({
  listParticipants: undefined as unknown as (room: string) => Promise<Array<{ identity: string }>>,
  listedRooms: [] as string[],
}));

vi.mock('@/lib/deployment-mode', () => ({
  getDeploymentMode: () => mode.value,
  isMultiTenant: () => mode.value === 'multi-tenant',
  isSingleTenant: () => mode.value === 'single-tenant',
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: session.user } }) },
  }),
}));

vi.mock('livekit-server-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('livekit-server-sdk')>();
  class FakeRoomServiceClient {
    async listParticipants(room: string) {
      livekit.listedRooms.push(room);
      return livekit.listParticipants(room);
    }
  }
  return { ...actual, RoomServiceClient: FakeRoomServiceClient };
});

const { GET } = await import('@/app/api/livekit/token/route');

const mutableEnv = env as unknown as Record<string, string>;
const envBackup = { ...mutableEnv };

interface JwtPayload {
  sub?: string;
  metadata?: string;
  video?: Record<string, unknown>;
}

function decodeJwt(token: string): JwtPayload {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as JwtPayload;
}

function fakeAdmin(members: Array<{ organization_id: string; user_id: string }>) {
  return {
    from() {
      const filters: Record<string, string> = {};
      const query = {
        select: () => query,
        eq(column: string, value: string) {
          filters[column] = value;
          return query;
        },
        abortSignal: () => query,
        maybeSingle() {
          const row = members.find((m) => m.organization_id === filters.organization_id && m.user_id === filters.user_id);
          return Promise.resolve({ data: row ? { organization_id: row.organization_id } : null, error: null });
        },
      };
      return query;
    },
  } as never;
}

function request(query = ''): NextRequest {
  return new NextRequest(`http://localhost/api/livekit/token${query}`);
}

let voiceSecret: string;

beforeEach(() => {
  mode.value = 'multi-tenant';
  session.user = null;
  livekit.listedRooms = [];
  livekit.listParticipants = async () => [{ identity: 'voice-agent-1' }];
  voiceSecret = crypto.randomBytes(24).toString('hex');
  mutableEnv.LIVEKIT_API_KEY = `key-${crypto.randomBytes(6).toString('hex')}`;
  mutableEnv.LIVEKIT_API_SECRET = crypto.randomBytes(32).toString('hex');
  mutableEnv.LIVEKIT_URL = 'wss://livekit.example.test';
  mutableEnv.RAG_VOICE_TOKEN_SECRET = voiceSecret;
  mutableEnv.RAG_VOICE_TOKEN_TTL_SECONDS = '3600';
  setRagDepsForTests({ adminClient: () => fakeAdmin([{ organization_id: ORG_O, user_id: USER_A }]) });
});

afterEach(() => {
  Object.assign(mutableEnv, envBackup);
  vi.restoreAllMocks();
});

describe('GET /api/livekit/token', () => {
  test('derives the identity from the session and ignores caller username and room', async () => {
    session.user = { id: USER_A };
    const res = await GET(request(`?username=user-${USER_B}-1&room=other`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.identity).toMatch(new RegExp(`^user-${USER_A}-[0-9a-f]{8}$`));
    const payload = decodeJwt(body.token);
    expect(payload.sub).toBe(body.identity);
    expect(payload.video?.room).toBe('myrag-voice');
    expect(payload.video?.roomJoin).toBe(true);
    expect(body.serverUrl).toBe('wss://livekit.example.test');
  });

  test('puts a verifiable personal voice token in the participant metadata', async () => {
    session.user = { id: USER_A };
    const body = await (await GET(request())).json();
    const metadata = JSON.parse(decodeJwt(body.token).metadata ?? '{}') as { rag_scope_token?: string };
    expect(typeof metadata.rag_scope_token).toBe('string');
    const verified = verifyVoiceToken(metadata.rag_scope_token, { secret: voiceSecret });
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.payload.tk).toBe(`u:${USER_A}`);
      expect(verified.payload.uid).toBe(USER_A);
    }
  });

  test('an organization member gets an organization token', async () => {
    session.user = { id: USER_A };
    const body = await (await GET(request(`?organizationId=${ORG_O}`))).json();
    const metadata = JSON.parse(decodeJwt(body.token).metadata ?? '{}') as { rag_scope_token?: string };
    const verified = verifyVoiceToken(metadata.rag_scope_token, { secret: voiceSecret });
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.payload.tk).toBe(`o:${ORG_O}`);
      expect(verified.payload.oid).toBe(ORG_O);
    }
  });

  test('a non-member organization gets 403 JSON and no token', async () => {
    session.user = { id: USER_B };
    const res = await GET(request(`?organizationId=${ORG_O}`));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.token).toBeUndefined();
    expect(typeof body.error).toBe('string');
  });

  test('single-tenant without a session gets an anonymous identity and the default scope token', async () => {
    mode.value = 'single-tenant';
    const res = await GET(request());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.identity).toMatch(/^user-anon-[0-9a-f]{8}$/);
    const metadata = JSON.parse(decodeJwt(body.token).metadata ?? '{}') as { rag_scope_token?: string };
    const verified = verifyVoiceToken(metadata.rag_scope_token, { secret: voiceSecret });
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.payload.tk).toBe('s:default');
      expect(verified.payload.uid).toBeNull();
      expect(verified.payload.act).toBeUndefined();
    }
  });

  test('single-tenant with a session carries the session user as the signed actor and keeps the default scope', async () => {
    mode.value = 'single-tenant';
    session.user = { id: USER_A };
    const body = await (await GET(request())).json();
    const metadata = JSON.parse(decodeJwt(body.token).metadata ?? '{}') as { rag_scope_token?: string };
    const verified = verifyVoiceToken(metadata.rag_scope_token, { secret: voiceSecret });
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.payload).toMatchObject({ tk: 's:default', uid: null, oid: null, act: USER_A });
    }
  });

  test('multi-tenant tokens carry no separate actor claim', async () => {
    session.user = { id: USER_A };
    const body = await (await GET(request(`?organizationId=${ORG_O}`))).json();
    const metadata = JSON.parse(decodeJwt(body.token).metadata ?? '{}') as { rag_scope_token?: string };
    const verified = verifyVoiceToken(metadata.rag_scope_token, { secret: voiceSecret });
    expect(verified.ok && verified.payload.act).toBeFalsy();
  });

  test('multi-tenant without a session issues a LiveKit token without a voice token', async () => {
    const res = await GET(request());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.identity).toMatch(/^user-anon-[0-9a-f]{8}$/);
    expect(decodeJwt(body.token).metadata).toBeUndefined();
  });

  test('a 31-character voice secret issues the token without metadata and warns once', async () => {
    session.user = { id: USER_A };
    mutableEnv.RAG_VOICE_TOKEN_SECRET = 'x'.repeat(31);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await GET(request());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(decodeJwt(body.token).metadata).toBeUndefined();
    const tenantWarnings = warn.mock.calls.filter((call) => String(call[0]).includes('[RAG Tenant]'));
    expect(tenantWarnings).toHaveLength(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('x'.repeat(31));
  });

  test('the grant never allows the participant to update its own metadata', async () => {
    session.user = { id: USER_A };
    const body = await (await GET(request())).json();
    expect(decodeJwt(body.token).video?.canUpdateOwnMetadata).not.toBe(true);
    expect(decodeJwt(body.token).video?.canUpdateOwnMetadata ?? false).toBe(false);
  });

  test('another user participant in the room gives 409 voice_busy and no token', async () => {
    session.user = { id: USER_A };
    livekit.listParticipants = async () => [{ identity: 'voice-agent-1' }, { identity: `user-${USER_B}-abcd1234` }];
    const res = await GET(request());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toEqual({ error: 'voice_busy' });
    expect(livekit.listedRooms).toEqual(['myrag-voice']);
  });

  test('a participant listing failure logs and proceeds', async () => {
    session.user = { id: USER_A };
    livekit.listParticipants = async () => {
      throw new Error('livekit unreachable');
    };
    const error = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(error).toHaveBeenCalled();
  });

  test('a missing LiveKit key or secret gives 500', async () => {
    session.user = { id: USER_A };
    mutableEnv.LIVEKIT_API_KEY = '';
    const res = await GET(request());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.token).toBeUndefined();
  });

  test('the response and logs never contain the voice secret', async () => {
    session.user = { id: USER_A };
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await GET(request());
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain(voiceSecret);
    expect(JSON.stringify([...log.mock.calls, ...warn.mock.calls])).not.toContain(voiceSecret);
  });
});
