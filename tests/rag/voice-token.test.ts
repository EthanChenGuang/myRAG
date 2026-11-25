import crypto from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';
import { mintScope, scopeKey, type TenantScope } from '@/lib/rag/tenant/scope';
import { mintVoiceToken, verifyVoiceToken, type VoiceTokenPayload } from '@/lib/rag/tenant/voice-token';
import { resolveVoiceScope } from '@/lib/rag/tenant/voice';

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const USER_B = '00000000-0000-4000-8000-0000000000b1';
const ORG_O = '00000000-0000-4000-8000-0000000000c1';

const SECRET = crypto.randomBytes(24).toString('hex');
const OTHER_SECRET = crypto.randomBytes(24).toString('hex');
const NOW_MS = 1_900_000_000_000;
const NOW_S = Math.floor(NOW_MS / 1000);

const b64 = (value: string) => Buffer.from(value, 'utf8').toString('base64url');
const sign = (payloadB64: string, secret: string) => crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');

function forge(overrides: Partial<Record<keyof VoiceTokenPayload, unknown>>, secret = SECRET, omit: string[] = []): string {
  const payload: Record<string, unknown> = {
    v: 1,
    tk: `u:${USER_A}`,
    uid: USER_A,
    oid: null,
    iat: NOW_S,
    exp: NOW_S + 600,
    aud: 'voice-rag',
    ...overrides,
  };
  for (const key of omit) delete payload[key];
  const payloadB64 = b64(JSON.stringify(payload));
  return `${payloadB64}.${sign(payloadB64, secret)}`;
}

function mint(scope: TenantScope, extra: { secret?: string; ttlSeconds?: number; now?: number } = {}): string {
  const result = mintVoiceToken({ scope, secret: extra.secret ?? SECRET, ttlSeconds: extra.ttlSeconds ?? 600, now: extra.now ?? NOW_MS });
  if (!result.ok) throw new Error(`mint failed: ${result.reason}`);
  return result.token;
}

describe('mintVoiceToken and verifyVoiceToken', () => {
  test('round-trips a single-tenant scope with no user', () => {
    const token = mint(mintScope('single', null, null));
    const result = verifyVoiceToken(token, { secret: SECRET, now: NOW_MS });
    expect(result).toMatchObject({ ok: true, payload: { v: 1, tk: 's:default', uid: null, oid: null, aud: 'voice-rag', iat: NOW_S, exp: NOW_S + 600 } });
  });

  test('round-trips a personal scope', () => {
    const token = mint(mintScope('personal', USER_A, null));
    const result = verifyVoiceToken(token, { secret: SECRET, now: NOW_MS + 5_000 });
    expect(result).toMatchObject({ ok: true, payload: { tk: `u:${USER_A}`, uid: USER_A, oid: null } });
  });

  test('round-trips an organization scope with its user', () => {
    const token = mint(mintScope('org', USER_A, ORG_O));
    const result = verifyVoiceToken(token, { secret: SECRET, now: NOW_MS });
    expect(result).toMatchObject({ ok: true, payload: { tk: `o:${ORG_O}`, uid: USER_A, oid: ORG_O } });
  });

  test('the token is base64url(payload).base64url(hmac) over compact JSON', () => {
    const token = mint(mintScope('personal', USER_A, null));
    const [payloadB64, signature] = token.split('.');
    expect(token.split('.')).toHaveLength(2);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(signature).toBe(sign(payloadB64, SECRET));
    const json = Buffer.from(payloadB64, 'base64url').toString('utf8');
    expect(json).toBe(JSON.stringify(JSON.parse(json)));
    expect(Object.keys(JSON.parse(json))).toEqual(['v', 'tk', 'uid', 'oid', 'iat', 'exp', 'aud']);
  });

  test('a token minted with an actor carries it as act and the signature covers it', () => {
    const minted = mintVoiceToken({ scope: mintScope('single', null, null), secret: SECRET, ttlSeconds: 600, now: NOW_MS, actorUserId: USER_A });
    if (!minted.ok) throw new Error('unreachable');
    expect(verifyVoiceToken(minted.token, { secret: SECRET, now: NOW_MS })).toMatchObject({ ok: true, payload: { tk: 's:default', uid: null, act: USER_A } });
    const [payloadB64, signature] = minted.token.split('.');
    const claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as Record<string, unknown>;
    const swapped = b64(JSON.stringify({ ...claims, act: USER_B }));
    expect(verifyVoiceToken(`${swapped}.${signature}`, { secret: SECRET, now: NOW_MS })).toEqual({ ok: false, status: 401, reason: 'bad_signature' });
    const stripped = b64(JSON.stringify({ ...claims, act: undefined }));
    expect(verifyVoiceToken(`${stripped}.${signature}`, { secret: SECRET, now: NOW_MS })).toEqual({ ok: false, status: 401, reason: 'bad_signature' });
  });

  test('a token minted without an actor has no act claim and an empty actor is not written', () => {
    for (const actorUserId of [undefined, null, '']) {
      const minted = mintVoiceToken({ scope: mintScope('single', null, null), secret: SECRET, ttlSeconds: 600, now: NOW_MS, actorUserId });
      if (!minted.ok) throw new Error('unreachable');
      expect(Object.keys(JSON.parse(Buffer.from(minted.token.split('.')[0], 'base64url').toString('utf8')))).toEqual(['v', 'tk', 'uid', 'oid', 'iat', 'exp', 'aud']);
      const verified = verifyVoiceToken(minted.token, { secret: SECRET, now: NOW_MS });
      expect(verified.ok && 'act' in verified.payload).toBe(false);
    }
  });

  test('a signed payload with a non-string act is malformed', () => {
    expect(verifyVoiceToken(forge({ act: 7 } as never), { secret: SECRET, now: NOW_MS })).toEqual({ ok: false, status: 401, reason: 'malformed' });
    expect(verifyVoiceToken(forge({ act: null } as never), { secret: SECRET, now: NOW_MS })).toEqual({ ok: false, status: 401, reason: 'malformed' });
  });

  test('a 31-character secret is refused for minting and verification', () => {
    const short = 'x'.repeat(31);
    const minted = mintVoiceToken({ scope: mintScope('single', null, null), secret: short, ttlSeconds: 600, now: NOW_MS });
    expect(minted).toEqual({ ok: false, reason: 'secret_not_configured' });
    const token = forge({}, short);
    expect(verifyVoiceToken(token, { secret: short, now: NOW_MS })).toEqual({ ok: false, status: 503, reason: 'secret_not_configured' });
    expect(mintVoiceToken({ scope: mintScope('single', null, null), secret: undefined, ttlSeconds: 600, now: NOW_MS })).toEqual({ ok: false, reason: 'secret_not_configured' });
  });

  test('a 32-character secret is accepted', () => {
    const exact = 'y'.repeat(32);
    const result = mintVoiceToken({ scope: mintScope('single', null, null), secret: exact, ttlSeconds: 60, now: NOW_MS });
    expect(result.ok).toBe(true);
  });

  test.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])('ttl %s is refused', (ttlSeconds) => {
    expect(mintVoiceToken({ scope: mintScope('single', null, null), secret: SECRET, ttlSeconds, now: NOW_MS })).toEqual({ ok: false, reason: 'invalid_ttl' });
  });

  test('flipping one character of the signature fails with 401', () => {
    const token = mint(mintScope('personal', USER_A, null));
    const [payloadB64, signature] = token.split('.');
    const flipped = `${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`;
    expect(verifyVoiceToken(`${payloadB64}.${flipped}`, { secret: SECRET, now: NOW_MS })).toEqual({ ok: false, status: 401, reason: 'bad_signature' });
  });

  test('a modified payload with the old signature fails with 401', () => {
    const token = mint(mintScope('personal', USER_A, null));
    const [, signature] = token.split('.');
    const tampered = b64(JSON.stringify({ v: 1, tk: `u:${USER_B}`, uid: USER_B, oid: null, iat: NOW_S, exp: NOW_S + 600, aud: 'voice-rag' }));
    expect(verifyVoiceToken(`${tampered}.${signature}`, { secret: SECRET, now: NOW_MS })).toEqual({ ok: false, status: 401, reason: 'bad_signature' });
  });

  test('a token signed with a different secret fails with 401', () => {
    expect(verifyVoiceToken(forge({}, OTHER_SECRET), { secret: SECRET, now: NOW_MS })).toEqual({ ok: false, status: 401, reason: 'bad_signature' });
  });

  test('a wrong audience, a wrong version and an expired token each fail with 401', () => {
    expect(verifyVoiceToken(forge({ aud: 'other' }), { secret: SECRET, now: NOW_MS })).toEqual({ ok: false, status: 401, reason: 'bad_audience' });
    expect(verifyVoiceToken(forge({ v: 2 }), { secret: SECRET, now: NOW_MS })).toEqual({ ok: false, status: 401, reason: 'bad_version' });
    expect(verifyVoiceToken(forge({ exp: NOW_S - 1 }), { secret: SECRET, now: NOW_MS })).toEqual({ ok: false, status: 401, reason: 'expired' });
    expect(verifyVoiceToken(forge({ exp: NOW_S }), { secret: SECRET, now: NOW_MS })).toEqual({ ok: false, status: 401, reason: 'expired' });
  });

  test('a token issued more than 30 seconds in the future fails, within 30 seconds passes', () => {
    expect(verifyVoiceToken(forge({ iat: NOW_S + 31, exp: NOW_S + 900 }), { secret: SECRET, now: NOW_MS })).toEqual({ ok: false, status: 401, reason: 'issued_in_future' });
    expect(verifyVoiceToken(forge({ iat: NOW_S + 30, exp: NOW_S + 900 }), { secret: SECRET, now: NOW_MS }).ok).toBe(true);
  });

  test.each([
    ['missing tk', { tk: undefined }],
    ['numeric uid', { uid: 7 }],
    ['string iat', { iat: String(NOW_S) }],
    ['fractional exp', { exp: NOW_S + 10.5 }],
  ])('a correctly signed payload with %s is malformed', (_label, overrides) => {
    expect(verifyVoiceToken(forge(overrides as never), { secret: SECRET, now: NOW_MS })).toEqual({ ok: false, status: 401, reason: 'malformed' });
  });

  test('a correctly signed payload that is not JSON is malformed', () => {
    const payloadB64 = b64('not json');
    expect(verifyVoiceToken(`${payloadB64}.${sign(payloadB64, SECRET)}`, { secret: SECRET, now: NOW_MS })).toEqual({ ok: false, status: 401, reason: 'malformed' });
  });

  test.each([undefined, null, '', 'no-dot', 'a.b.c', '.', 'a.', '.b', 42, { token: 'x' }])('structurally invalid input %j fails with 401', (value) => {
    const result = verifyVoiceToken(value, { secret: SECRET, now: NOW_MS });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.status).toBe(401);
  });

  test('an oversized token is rejected without hashing it', () => {
    expect(verifyVoiceToken(`${'a'.repeat(5000)}.sig`, { secret: SECRET, now: NOW_MS })).toEqual({ ok: false, status: 401, reason: 'malformed' });
  });
});

function fakeAdmin(members: Array<{ organization_id: string; user_id: string }>, failure?: string) {
  const calls: Array<{ table: string; filters: Record<string, string> }> = [];
  const admin = {
    from(table: string) {
      const call = { table, filters: {} as Record<string, string> };
      calls.push(call);
      const query = {
        select: () => query,
        eq(column: string, value: string) {
          call.filters[column] = value;
          return query;
        },
        abortSignal: () => query,
        maybeSingle() {
          if (failure) return Promise.resolve({ data: null, error: { message: failure } });
          const row = members.find((m) => m.organization_id === call.filters.organization_id && m.user_id === call.filters.user_id);
          return Promise.resolve({ data: row ? { organization_id: row.organization_id } : null, error: null });
        },
      };
      return query;
    },
  };
  return { admin: admin as never, calls };
}

const headersWith = (token: string | null) => new Headers(token === null ? {} : { 'x-rag-scope-token': token });
const signal = () => new AbortController().signal;

describe('resolveVoiceScope', () => {
  test('no x-rag-scope-token header gives 401 even when a userId is available elsewhere', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { admin, calls } = fakeAdmin([]);
    const result = await resolveVoiceScope({ headers: headersWith(null), deploymentMode: 'multi-tenant', secret: SECRET, admin, signal: signal(), now: NOW_MS });
    expect(result).toEqual({ ok: false, status: 401, reason: 'missing_token' });
    expect(calls).toHaveLength(0);
    warn.mockRestore();
  });

  test('a forged or garbage token gives 401', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (const token of [forge({}, OTHER_SECRET), 'garbage', '']) {
      const result = await resolveVoiceScope({ headers: headersWith(token), deploymentMode: 'multi-tenant', secret: SECRET, admin: fakeAdmin([]).admin, signal: signal(), now: NOW_MS });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.status).toBe(401);
    }
    warn.mockRestore();
  });

  test('an unconfigured secret gives 503', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await resolveVoiceScope({ headers: headersWith(forge({})), deploymentMode: 'multi-tenant', secret: 'short', admin: null, signal: signal(), now: NOW_MS });
    expect(result).toEqual({ ok: false, status: 503, reason: 'secret_not_configured' });
    warn.mockRestore();
  });

  test('a valid personal token gives exactly its scope without a query', async () => {
    const { admin, calls } = fakeAdmin([]);
    const token = mint(mintScope('personal', USER_A, null));
    const result = await resolveVoiceScope({ headers: headersWith(token), deploymentMode: 'multi-tenant', secret: SECRET, admin, signal: signal(), now: NOW_MS });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.scope.kind).toBe('personal');
    expect(scopeKey(result.scope)).toBe(`u:${USER_A}`);
    expect(calls).toHaveLength(0);
  });

  test('a valid organization token re-checks membership and gives o:<O>', async () => {
    const { admin, calls } = fakeAdmin([{ organization_id: ORG_O, user_id: USER_A }]);
    const token = mint(mintScope('org', USER_A, ORG_O));
    const result = await resolveVoiceScope({ headers: headersWith(token), deploymentMode: 'multi-tenant', secret: SECRET, admin, signal: signal(), now: NOW_MS });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(scopeKey(result.scope)).toBe(`o:${ORG_O}`);
    expect(calls).toEqual([{ table: 'organization_members', filters: { organization_id: ORG_O, user_id: USER_A } }]);
  });

  test('an organization token whose membership was revoked gives 403', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { admin } = fakeAdmin([]);
    const token = mint(mintScope('org', USER_A, ORG_O));
    const result = await resolveVoiceScope({ headers: headersWith(token), deploymentMode: 'multi-tenant', secret: SECRET, admin, signal: signal(), now: NOW_MS });
    expect(result).toEqual({ ok: false, status: 403, reason: 'not_a_member' });
    warn.mockRestore();
  });

  test('a membership query error or a missing admin client fails closed with 503', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const token = mint(mintScope('org', USER_A, ORG_O));
    const failing = await resolveVoiceScope({ headers: headersWith(token), deploymentMode: 'multi-tenant', secret: SECRET, admin: fakeAdmin([], 'down').admin, signal: signal(), now: NOW_MS });
    expect(failing).toEqual({ ok: false, status: 503, reason: 'membership_unavailable' });
    const missing = await resolveVoiceScope({ headers: headersWith(token), deploymentMode: 'multi-tenant', secret: SECRET, admin: null, signal: signal(), now: NOW_MS });
    expect(missing).toEqual({ ok: false, status: 503, reason: 'membership_unavailable' });
    warn.mockRestore();
  });

  test('an s:default token in multi-tenant mode gives 401', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const token = mint(mintScope('single', null, null));
    const result = await resolveVoiceScope({ headers: headersWith(token), deploymentMode: 'multi-tenant', secret: SECRET, admin: fakeAdmin([]).admin, signal: signal(), now: NOW_MS });
    expect(result).toEqual({ ok: false, status: 401, reason: 'mode_mismatch' });
    warn.mockRestore();
  });

  test('a personal or organization token in single-tenant mode gives 401', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (const scope of [mintScope('personal', USER_A, null), mintScope('org', USER_A, ORG_O)]) {
      const result = await resolveVoiceScope({ headers: headersWith(mint(scope)), deploymentMode: 'single-tenant', secret: SECRET, admin: null, signal: signal(), now: NOW_MS });
      expect(result).toEqual({ ok: false, status: 401, reason: 'mode_mismatch' });
    }
    warn.mockRestore();
  });

  test('a single-tenant token with an actor gives s:default and exposes the verified actor', async () => {
    const minted = mintVoiceToken({ scope: mintScope('single', null, null), secret: SECRET, ttlSeconds: 600, now: NOW_MS, actorUserId: USER_A });
    if (!minted.ok) throw new Error('unreachable');
    const result = await resolveVoiceScope({ headers: headersWith(minted.token), deploymentMode: 'single-tenant', secret: SECRET, signal: signal(), now: NOW_MS });
    expect(result).toMatchObject({ ok: true, actorUserId: USER_A });
    if (!result.ok) throw new Error('unreachable');
    expect(result.scope).toEqual(mintScope('single', null, null));
    expect(scopeKey(result.scope)).toBe('s:default');
  });

  test('a single-tenant token without an actor, or with a legacy uid only, has no actor', async () => {
    for (const token of [mint(mintScope('single', null, null)), forge({ tk: 's:default', uid: USER_A, oid: null })]) {
      const result = await resolveVoiceScope({ headers: headersWith(token), deploymentMode: 'single-tenant', secret: SECRET, signal: signal(), now: NOW_MS });
      expect(result).toMatchObject({ ok: true, actorUserId: null });
    }
  });

  test('a single-tenant token whose actor is not a uuid gives 401', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await resolveVoiceScope({ headers: headersWith(forge({ tk: 's:default', uid: null, oid: null, act: 'not-a-uuid' } as never)), deploymentMode: 'single-tenant', secret: SECRET, signal: signal(), now: NOW_MS });
    expect(result).toEqual({ ok: false, status: 401, reason: 'bad_scope' });
    warn.mockRestore();
  });

  test('a multi-tenant actor is the scope user, and a different actor gives 401', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { admin } = fakeAdmin([{ organization_id: ORG_O, user_id: USER_A }]);
    const personal = await resolveVoiceScope({ headers: headersWith(mint(mintScope('personal', USER_A, null))), deploymentMode: 'multi-tenant', secret: SECRET, admin, signal: signal(), now: NOW_MS });
    expect(personal).toMatchObject({ ok: true, actorUserId: USER_A });
    const org = await resolveVoiceScope({ headers: headersWith(mint(mintScope('org', USER_A, ORG_O))), deploymentMode: 'multi-tenant', secret: SECRET, admin, signal: signal(), now: NOW_MS });
    expect(org).toMatchObject({ ok: true, actorUserId: USER_A });
    const matching = await resolveVoiceScope({ headers: headersWith(forge({ act: USER_A } as never)), deploymentMode: 'multi-tenant', secret: SECRET, admin, signal: signal(), now: NOW_MS });
    expect(matching).toMatchObject({ ok: true, actorUserId: USER_A });
    for (const token of [forge({ act: USER_B } as never), forge({ tk: `o:${ORG_O}`, uid: USER_A, oid: ORG_O, act: USER_B } as never)]) {
      const result = await resolveVoiceScope({ headers: headersWith(token), deploymentMode: 'multi-tenant', secret: SECRET, admin, signal: signal(), now: NOW_MS });
      expect(result).toEqual({ ok: false, status: 401, reason: 'bad_scope' });
    }
    warn.mockRestore();
  });

  test('a single-tenant token gives s:default with or without a user', async () => {
    for (const scope of [mintScope('single', null, null)]) {
      const result = await resolveVoiceScope({ headers: headersWith(mint(scope)), deploymentMode: 'single-tenant', secret: SECRET, signal: signal(), now: NOW_MS });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(scopeKey(result.scope)).toBe('s:default');
    }
    const withUser = forge({ tk: 's:default', uid: USER_A, oid: null });
    const result = await resolveVoiceScope({ headers: headersWith(withUser), deploymentMode: 'single-tenant', secret: SECRET, signal: signal(), now: NOW_MS });
    expect(result.ok).toBe(true);
  });

  test.each([
    ['personal tk naming another user', { tk: `u:${USER_B}`, uid: USER_A, oid: null }],
    ['personal tk carrying an organization', { tk: `u:${USER_A}`, uid: USER_A, oid: ORG_O }],
    ['organization tk without a user', { tk: `o:${ORG_O}`, uid: null, oid: ORG_O }],
    ['organization tk naming another organization', { tk: `o:${ORG_O}`, uid: USER_A, oid: '00000000-0000-4000-8000-0000000000c2' }],
    ['unparseable tk', { tk: 'x:1', uid: USER_A, oid: null }],
  ])('a signed token with %s gives 401', async (_label, overrides) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await resolveVoiceScope({ headers: headersWith(forge(overrides)), deploymentMode: 'multi-tenant', secret: SECRET, admin: fakeAdmin([{ organization_id: ORG_O, user_id: USER_A }]).admin, signal: signal(), now: NOW_MS });
    expect(result).toEqual({ ok: false, status: 401, reason: 'bad_scope' });
    warn.mockRestore();
  });

  test('a single-tenant token carrying an organization gives 401', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await resolveVoiceScope({ headers: headersWith(forge({ tk: 's:default', uid: null, oid: ORG_O })), deploymentMode: 'single-tenant', secret: SECRET, signal: signal(), now: NOW_MS });
    expect(result).toEqual({ ok: false, status: 401, reason: 'bad_scope' });
    warn.mockRestore();
  });

  test('an uppercase organization in a signed token is normalised before the membership query', async () => {
    const { admin, calls } = fakeAdmin([{ organization_id: ORG_O, user_id: USER_A }]);
    const token = forge({ tk: `o:${ORG_O.toUpperCase()}`, uid: USER_A.toUpperCase(), oid: ORG_O.toUpperCase() });
    const result = await resolveVoiceScope({ headers: headersWith(token), deploymentMode: 'multi-tenant', secret: SECRET, admin, signal: signal(), now: NOW_MS });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(scopeKey(result.scope)).toBe(`o:${ORG_O}`);
    expect(calls[0].filters).toEqual({ organization_id: ORG_O, user_id: USER_A });
  });

  test('an expired token gives 401 and logs never contain the token or ids', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const token = mint(mintScope('org', USER_A, ORG_O), { ttlSeconds: 60 });
    const result = await resolveVoiceScope({ headers: headersWith(token), deploymentMode: 'multi-tenant', secret: SECRET, admin: fakeAdmin([]).admin, signal: signal(), now: NOW_MS + 61_000 });
    expect(result).toEqual({ ok: false, status: 401, reason: 'expired' });
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('[RAG Tenant]');
    expect(logged).toContain('"hasToken":true');
    expect(logged).not.toContain(token);
    expect(logged).not.toContain(USER_A);
    expect(logged).not.toContain(ORG_O);
    expect(logged).not.toContain(SECRET);
    warn.mockRestore();
  });
});
