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
  listRooms: undefined as unknown as () => Promise<Array<{ name: string }>>,
  createRoom: undefined as unknown as (options: Record<string, unknown>) => Promise<unknown>,
  created: [] as Array<Record<string, unknown>>,
  order: [] as string[],
}));
const members = vi.hoisted(() => ({ rows: [] as Array<{ organization_id: string; user_id: string }>, owners: {} as Record<string, string> }));

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

vi.mock('@/lib/auth/organization-handler', () => ({
  verifyUserOrganizationAccess: async (userId: string, organizationId: string) => {
    livekit.order.push('repair');
    if (members.owners[organizationId] === userId) members.rows.push({ organization_id: organizationId, user_id: userId });
    return { ok: true };
  },
}));

vi.mock('livekit-server-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('livekit-server-sdk')>();
  class FakeRoomServiceClient {
    async listRooms() {
      return livekit.listRooms();
    }
    async createRoom(options: Record<string, unknown>) {
      livekit.order.push('create');
      livekit.created.push(options);
      return livekit.createRoom(options);
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
  exp?: number;
  nbf?: number;
}

interface RoomMetadata {
  v?: number;
  participant_identity?: string;
  rag_scope_token?: string;
}

function createdMetadata(index = 0): RoomMetadata {
  return JSON.parse(String(livekit.created[index]?.metadata ?? '{}')) as RoomMetadata;
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
  livekit.created = [];
  livekit.order = [];
  livekit.listRooms = async () => [{ name: 'unrelated-room' }];
  livekit.createRoom = async (options) => options;
  members.owners = {};
  members.rows = [{ organization_id: ORG_O, user_id: USER_A }];
  voiceSecret = crypto.randomBytes(24).toString('hex');
  mutableEnv.LIVEKIT_API_KEY = `key-${crypto.randomBytes(6).toString('hex')}`;
  mutableEnv.LIVEKIT_API_SECRET = crypto.randomBytes(32).toString('hex');
  mutableEnv.LIVEKIT_URL = 'wss://livekit.example.test';
  mutableEnv.RAG_VOICE_TOKEN_SECRET = voiceSecret;
  mutableEnv.RAG_VOICE_TOKEN_TTL_SECONDS = '3600';
  setRagDepsForTests({ adminClient: () => fakeAdmin(members.rows) });
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
    expect(payload.video?.room).toMatch(/^myrag-voice-[0-9a-f]{32}$/);
    expect(payload.video?.room).toBe(livekit.created[0]?.name);
    expect(payload.video?.roomJoin).toBe(true);
    expect(body.serverUrl).toBe('wss://livekit.example.test');
  });

  test('puts a verifiable personal voice token in the participant metadata', async () => {
    session.user = { id: USER_A };
    const body = await (await GET(request())).json();
    const metadata = createdMetadata();
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
    const metadata = createdMetadata();
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
    const metadata = createdMetadata();
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
    const metadata = createdMetadata();
    const verified = verifyVoiceToken(metadata.rag_scope_token, { secret: voiceSecret });
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.payload).toMatchObject({ tk: 's:default', uid: null, oid: null, act: USER_A });
    }
  });

  test('multi-tenant tokens carry no separate actor claim', async () => {
    session.user = { id: USER_A };
    const body = await (await GET(request(`?organizationId=${ORG_O}`))).json();
    const metadata = createdMetadata();
    const verified = verifyVoiceToken(metadata.rag_scope_token, { secret: voiceSecret });
    expect(verified.ok && verified.payload.act).toBeFalsy();
  });

  test('multi-tenant without a session issues a LiveKit token without a voice token', async () => {
    const res = await GET(request());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.identity).toMatch(/^user-anon-[0-9a-f]{8}$/);
    expect(createdMetadata().rag_scope_token).toBeUndefined();
  });

  test('a 31-character voice secret gives 503 with no token and no room', async () => {
    session.user = { id: USER_A };
    mutableEnv.RAG_VOICE_TOKEN_SECRET = 'x'.repeat(31);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await GET(request());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.token).toBeUndefined();
    expect(livekit.created).toHaveLength(0);
    const tenantErrors = error.mock.calls.filter((call) => String(call[0]).includes('[RAG Tenant]'));
    expect(tenantErrors).toHaveLength(1);
    expect(JSON.stringify(error.mock.calls)).not.toContain('x'.repeat(31));
  });

  test('a non-numeric voice token TTL falls back to the default and still issues the scope token', async () => {
    session.user = { id: USER_A };
    mutableEnv.RAG_VOICE_TOKEN_TTL_SECONDS = 'not-a-number';
    const res = await GET(request());
    expect(res.status).toBe(200);
    const verified = verifyVoiceToken(createdMetadata().rag_scope_token, { secret: voiceSecret });
    expect(verified.ok).toBe(true);
    if (verified.ok) expect(verified.payload.exp - verified.payload.iat).toBe(3600);
  });

  test('the grant never allows the participant to update its own metadata', async () => {
    session.user = { id: USER_A };
    const body = await (await GET(request())).json();
    expect(decodeJwt(body.token).video?.canUpdateOwnMetadata).not.toBe(true);
    expect(decodeJwt(body.token).video?.canUpdateOwnMetadata ?? false).toBe(false);
  });

  test('every request gets its own unguessable room and the token only joins that room', async () => {
    session.user = { id: USER_A };
    const first = await (await GET(request())).json();
    const second = await (await GET(request())).json();
    const roomA = decodeJwt(first.token).video?.room;
    const roomB = decodeJwt(second.token).video?.room;
    expect(roomA).toMatch(/^myrag-voice-[0-9a-f]{32}$/);
    expect(roomB).toMatch(/^myrag-voice-[0-9a-f]{32}$/);
    expect(roomA).not.toBe(roomB);
    expect(livekit.created.map((c) => c.name)).toEqual([roomA, roomB]);
    expect(String(roomA)).not.toContain(USER_A);
  });

  test('the room is created server-side for exactly the intended participant and holds two at most', async () => {
    session.user = { id: USER_A };
    const body = await (await GET(request())).json();
    expect(livekit.created).toHaveLength(1);
    expect(livekit.created[0]).toMatchObject({ maxParticipants: 2 });
    expect(createdMetadata().participant_identity).toBe(body.identity);
  });

  test('the scope token is not in the participant metadata of the room token', async () => {
    session.user = { id: USER_A };
    const body = await (await GET(request())).json();
    expect(decodeJwt(body.token).metadata).toBeUndefined();
    expect(body.token).not.toContain('rag_scope_token');
  });

  test('the join token is short lived', async () => {
    session.user = { id: USER_A };
    const body = await (await GET(request())).json();
    const payload = decodeJwt(body.token);
    expect((payload.exp ?? 0) - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(600);
  });

  test('too many active voice rooms gives 409 voice_busy and no token', async () => {
    session.user = { id: USER_A };
    livekit.listRooms = async () => [
      { name: 'myrag-voice-aaaa' },
      { name: 'myrag-voice-bbbb' },
      { name: 'myrag-voice-cccc' },
      { name: 'myrag-voice-dddd' },
      { name: 'unrelated-room' },
    ];
    const res = await GET(request());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'voice_busy' });
    expect(livekit.created).toHaveLength(0);
  });

  test('VOICE_MAX_ACTIVE_ROOMS lowers the room limit', async () => {
    session.user = { id: USER_A };
    mutableEnv.VOICE_MAX_ACTIVE_ROOMS = '2';
    livekit.listRooms = async () => [{ name: 'myrag-voice-aaaa' }, { name: 'myrag-voice-bbbb' }];
    const res = await GET(request());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'voice_busy' });
    expect(livekit.created).toHaveLength(0);
  });

  test('VOICE_MAX_ACTIVE_ROOMS raises the room limit', async () => {
    session.user = { id: USER_A };
    mutableEnv.VOICE_MAX_ACTIVE_ROOMS = '6';
    livekit.listRooms = async () => ['a', 'b', 'c', 'd', 'e'].map((suffix) => ({ name: `myrag-voice-${suffix}` }));
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(livekit.created).toHaveLength(1);
  });

  test.each(['', 'abc', '0', '-3'])('an unusable VOICE_MAX_ACTIVE_ROOMS (%j) falls back to 4', async (value) => {
    session.user = { id: USER_A };
    mutableEnv.VOICE_MAX_ACTIVE_ROOMS = value;
    livekit.listRooms = async () => ['a', 'b', 'c', 'd'].map((suffix) => ({ name: `myrag-voice-${suffix}` }));
    const res = await GET(request());
    expect(res.status).toBe(409);
  });

  test('a room listing failure fails closed with 503 and no token', async () => {
    session.user = { id: USER_A };
    livekit.listRooms = async () => {
      throw new Error('livekit unreachable');
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await GET(request());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.token).toBeUndefined();
    expect(livekit.created).toHaveLength(0);
  });

  test('a room creation failure fails closed with 503 and no token', async () => {
    session.user = { id: USER_A };
    livekit.createRoom = async () => {
      throw new Error('create failed');
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await GET(request());
    expect(res.status).toBe(503);
    expect((await res.json()).token).toBeUndefined();
  });

  test('an organization owner without a membership row is repaired before the tenant check', async () => {
    session.user = { id: USER_B };
    members.owners = { [ORG_O]: USER_B };
    const res = await GET(request(`?organizationId=${ORG_O}`));
    expect(res.status).toBe(200);
    expect(livekit.order.indexOf('repair')).toBeGreaterThanOrEqual(0);
    expect(livekit.order.indexOf('repair')).toBeLessThan(livekit.order.indexOf('create'));
    const verified = verifyVoiceToken(createdMetadata().rag_scope_token, { secret: voiceSecret });
    expect(verified.ok && verified.payload.tk).toBe(`o:${ORG_O}`);
  });

  test('a non-owner non-member is still refused after the repair attempt', async () => {
    session.user = { id: USER_B };
    const res = await GET(request(`?organizationId=${ORG_O}`));
    expect(res.status).toBe(403);
    expect(livekit.created).toHaveLength(0);
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
