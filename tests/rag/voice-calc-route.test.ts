import crypto from 'node:crypto';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';
import { createFixtureDatabase, type FixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { mintScope } from '@/lib/rag/tenant/scope';
import { mintVoiceToken } from '@/lib/rag/tenant/voice-token';
import { INTERNAL_API_KEY } from '../helpers/route-fixture';

interface RouteModule {
  POST(req: NextRequest): Promise<Response>;
}

const SECRET = crypto.randomBytes(24).toString('hex');
const TALLY = 'Synthetic tally: north 120 units, south 80 units.';
const QUESTION = 'What is the total of north and south?';

const IDS = {
  chunkA: '00000000-0000-4000-8000-0000000000f1',
  chunkO: '00000000-0000-4000-8000-0000000000f2',
  chunkB: '00000000-0000-4000-8000-0000000000f3',
  chunkAQuarantined: '00000000-0000-4000-8000-0000000000f4',
  singleDoc: '00000000-0000-4000-8000-0000000000f5',
  singleChunk: '00000000-0000-4000-8000-0000000000f6',
  singleQuarantined: '00000000-0000-4000-8000-0000000000f7',
} as const;

function tallyRequest(alias = 'S1') {
  return {
    operands: [
      { name: 'north', source: { kind: 'chunk', alias }, value: '120', unit: 'units' },
      { name: 'south', source: { kind: 'chunk', alias }, value: '80', unit: 'units' },
    ],
    steps: [{ id: 'total', op: 'add', args: ['north', 'south'] }],
    result: 'total',
  };
}

function tallyTrace(alias = 'S1') {
  return {
    origin: 'tool',
    request: tallyRequest(alias),
    result: { status: 'ok', value: '200', unit: 'units', reject_reason: null, steps: [] },
    anchor_offset: null,
  };
}

async function importRoute(): Promise<RouteModule> {
  vi.resetModules();
  return (await import('@/app/api/internal/voice-calc/route')) as unknown as RouteModule;
}

function token(scope: ReturnType<typeof mintScope>): string {
  const minted = mintVoiceToken({ scope, secret: SECRET, ttlSeconds: 600 });
  if (!minted.ok) throw new Error(`mint failed: ${minted.reason}`);
  return minted.token;
}

function request(body: unknown, scopeToken: string | null, apiKey: string | null = INTERNAL_API_KEY): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey !== null) headers['x-api-key'] = apiKey;
  if (scopeToken !== null) headers['x-rag-scope-token'] = scopeToken;
  return new NextRequest('http://localhost/api/internal/voice-calc', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const execute = (chunkId: string, alias = 'S1') => ({ action: 'execute', question: QUESTION, request: tallyRequest(alias), sources: [{ alias, chunk_id: chunkId }] });
const check = (chunkId: string, answer: string) => ({
  action: 'check',
  question: QUESTION,
  answer_text: answer,
  traces: [tallyTrace()],
  sources: [{ alias: 'S1', chunk_id: chunkId }],
});

function setSwitches(on: { tool?: boolean; check?: boolean }): void {
  if (on.tool) process.env.RAG_CALC_TOOL = 'true';
  else delete process.env.RAG_CALC_TOOL;
  if (on.check) process.env.RAG_CALC_CHECK = 'true';
  else delete process.env.RAG_CALC_CHECK;
}

const previousEnv = { ...process.env } as Record<string, string | undefined>;
function restoreEnv(): void {
  for (const name of Object.keys(process.env)) if (!(name in previousEnv)) delete process.env[name];
  Object.assign(process.env, previousEnv);
}

describe('voice-calc route, multi-tenant', () => {
  let fixture: TwoTenantDatabase;
  let edge: FakeEdge;
  const personalA = () => token(mintScope('personal', TWO_TENANT_IDS.userA, null));
  const personalB = () => token(mintScope('personal', TWO_TENANT_IDS.userB, null));
  const org = () => token(mintScope('org', TWO_TENANT_IDS.userA, TWO_TENANT_IDS.orgO));

  beforeAll(async () => {
    fixture = await createTwoTenantDatabase();
    const insert = 'INSERT INTO document_chunks (id, document_id, content, chunk_index, organization_id, status) VALUES ($1, $2, $3, 1, $4, $5)';
    await fixture.db.query(insert, [IDS.chunkA, TWO_TENANT_IDS.docA, TALLY, null, 'ready']);
    await fixture.db.query(insert, [IDS.chunkO, TWO_TENANT_IDS.docO, TALLY, TWO_TENANT_IDS.orgO, 'ready']);
    await fixture.db.query(insert, [IDS.chunkB, TWO_TENANT_IDS.docB, TALLY, null, 'ready']);
    await fixture.db.query(insert, [IDS.chunkAQuarantined, TWO_TENANT_IDS.docA, TALLY, null, 'quarantined']);
    edge = await startFakeEdge({ db: fixture.db });
  });

  afterAll(async () => {
    await edge?.close();
    await fixture?.db.close();
    restoreEnv();
  });

  beforeEach(() => {
    Object.assign(process.env, fixtureProcessEnv(edge.url));
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    process.env.MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    process.env.MYRAG_INTERNAL_API_KEY = INTERNAL_API_KEY;
    process.env.RAG_VOICE_TOKEN_SECRET = SECRET;
    setSwitches({ tool: true, check: true });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setSwitches({});
  });

  it('answers 401 for a missing or wrong key before the body is read', async () => {
    const { POST } = await importRoute();
    for (const key of [null, 'wrong-key']) {
      const req = request(execute(IDS.chunkA), personalA(), key);
      const json = vi.spyOn(req, 'json');
      const response = await POST(req);
      expect(response.status).toBe(401);
      expect(json).not.toHaveBeenCalled();
    }
  });

  it('answers 500 when the server key is not configured', async () => {
    process.env.MYRAG_INTERNAL_API_KEY = '';
    const { POST } = await importRoute();
    expect((await POST(request(execute(IDS.chunkA), personalA()))).status).toBe(500);
  });

  it('answers 400 for invalid JSON and for a body failing the schema, with the first issue path', async () => {
    const { POST } = await importRoute();
    expect((await POST(request('{not json', personalA()))).status).toBe(400);
    const bad = { ...execute(IDS.chunkA), question: '' };
    const response = await POST(request(bad, personalA()));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_body', path: 'question' });
    const unknownAction = await POST(request({ action: 'eval', question: QUESTION }, personalA()));
    expect(unknownAction.status).toBe(400);
  });

  it('answers 400 for more than 20 sources and for an answer_text above 8,000 characters', async () => {
    const { POST } = await importRoute();
    const sources = Array.from({ length: 21 }, (_, i) => ({ alias: `S${i + 1}`, chunk_id: IDS.chunkA }));
    expect((await POST(request({ ...execute(IDS.chunkA), sources }, personalA()))).status).toBe(400);
    const long = check(IDS.chunkA, 'x'.repeat(8001));
    expect((await POST(request(long, personalA()))).status).toBe(400);
    const traces = Array.from({ length: 6 }, () => tallyTrace());
    expect((await POST(request({ ...check(IDS.chunkA, 'The total is 200 units [S1].'), traces }, personalA()))).status).toBe(400);
  });

  it('answers with the resolveVoiceScope status when the token is missing or invalid', async () => {
    const { POST } = await importRoute();
    const missing = await POST(request(execute(IDS.chunkA), null));
    expect(missing.status).toBe(401);
    const forged = mintVoiceToken({ scope: mintScope('personal', TWO_TENANT_IDS.userA, null), secret: crypto.randomBytes(24).toString('hex'), ttlSeconds: 600 });
    if (!forged.ok) throw new Error('mint failed');
    expect((await POST(request(execute(IDS.chunkA), forged.token))).status).toBe(401);
    const formerMember = token(mintScope('org', TWO_TENANT_IDS.userB, TWO_TENANT_IDS.orgO));
    expect((await POST(request(execute(IDS.chunkO), formerMember))).status).toBe(403);
  });

  it('answers 404 calc_tool_disabled with RAG_CALC_TOOL off', async () => {
    setSwitches({ check: true });
    const { POST } = await importRoute();
    const response = await POST(request(execute(IDS.chunkA), personalA()));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'calc_tool_disabled' });
  });

  it('execute evaluates against the caller own chunk', async () => {
    const { POST } = await importRoute();
    const response = await POST(request(execute(IDS.chunkA), personalA()));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: { status: string; value: string; unit: string } };
    expect(body.result).toMatchObject({ status: 'ok', value: '200', unit: 'units' });
  });

  it('execute treats a chunk of another personal tenant as an unknown source', async () => {
    const { POST } = await importRoute();
    const response = await POST(request(execute(IDS.chunkA), personalB()));
    expect(response.status).toBe(200);
    expect(((await response.json()) as { result: unknown }).result).toMatchObject({ status: 'rejected', reject_reason: 'unknown_source' });
  });

  it('execute keeps the organization and the personal workspace apart in both directions', async () => {
    const { POST } = await importRoute();
    const orgReadsPersonal = await POST(request(execute(IDS.chunkA), org()));
    expect(((await orgReadsPersonal.json()) as { result: unknown }).result).toMatchObject({ reject_reason: 'unknown_source' });
    const personalReadsOrg = await POST(request(execute(IDS.chunkO), personalA()));
    expect(((await personalReadsOrg.json()) as { result: unknown }).result).toMatchObject({ reject_reason: 'unknown_source' });
    const orgOwn = await POST(request(execute(IDS.chunkO), org()));
    expect(((await orgOwn.json()) as { result: unknown }).result).toMatchObject({ status: 'ok', value: '200' });
  });

  it('execute treats a quarantined chunk of the caller as an unknown source', async () => {
    const { POST } = await importRoute();
    const response = await POST(request(execute(IDS.chunkAQuarantined), personalA()));
    expect(((await response.json()) as { result: unknown }).result).toMatchObject({ reject_reason: 'unknown_source' });
  });

  it('check corrects a differing stated number with the span and the formatted recomputed value', async () => {
    const { POST } = await importRoute();
    const answer = 'The total is 210 units [S1].';
    const response = await POST(request(check(IDS.chunkA, answer), personalA()));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      check: { checks: Array<{ status: string; recomputed: string }>; notices: Array<{ kind: string; text: string }>; replacement: { start: number; end: number; text: string } };
    };
    expect(body.check.checks[0]).toMatchObject({ status: 'corrected', recomputed: '200' });
    expect(body.check.replacement).toEqual({ start: answer.indexOf('210'), end: answer.indexOf('210') + 3, text: '200' });
    expect(body.check.notices.map((n) => n.kind)).toEqual(['calc_corrected']);
    expect(body.check.notices[0]!.text).toContain('200 units');
  });

  it('check verifies a matching stated number and returns no replacement', async () => {
    const { POST } = await importRoute();
    const response = await POST(request(check(IDS.chunkA, 'The total is 200 units [S1].'), personalA()));
    const body = (await response.json()) as { check: { checks: Array<{ status: string }>; replacement: unknown } };
    expect(body.check.checks[0]!.status).toBe('verified');
    expect(body.check.replacement).toBeNull();
  });

  it('check over another tenant chunk cannot verify anything', async () => {
    const { POST } = await importRoute();
    const response = await POST(request(check(IDS.chunkA, 'The total is 200 units [S1].'), personalB()));
    const body = (await response.json()) as { check: { checks: Array<{ status: string; reason: string }>; replacement: unknown } };
    expect(body.check.checks[0]).toMatchObject({ status: 'not_verified', reason: 'trace_invalid' });
    expect(body.check.replacement).toBeNull();
  });

  it('check answers check null while RAG_CALC_CHECK is off', async () => {
    setSwitches({ tool: true });
    const { POST } = await importRoute();
    const response = await POST(request(check(IDS.chunkA, 'The total is 210 units [S1].'), personalA()));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ check: null });
  });

  it('logs the action, status and counts only, never the question, answer or block text', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { POST } = await importRoute();
    await POST(request(check(IDS.chunkA, 'The total is 210 units [S1].'), personalA()));
    await POST(request(execute(IDS.chunkA), personalA()));
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).toContain('[Voice Calc]');
    expect(logged).not.toContain('north');
    expect(logged).not.toContain('The total is');
    expect(logged).not.toContain(QUESTION);
  });
});

describe('voice-calc route, single-tenant', () => {
  let fixture: FixtureDatabase;
  let edge: FakeEdge;
  const single = () => token(mintScope('single', null, null));

  beforeAll(async () => {
    fixture = await createFixtureDatabase({ deploymentMode: 'single-tenant', corpusDir: path.resolve('eval/fixtures/corpus') });
    await fixture.db.query('INSERT INTO documents (id, filename, content) VALUES ($1, $2, $3)', [IDS.singleDoc, 'single-tally.md', TALLY]);
    const insert = 'INSERT INTO document_chunks (id, document_id, content, chunk_index, status) VALUES ($1, $2, $3, 0, $4)';
    await fixture.db.query(insert, [IDS.singleChunk, IDS.singleDoc, TALLY, 'ready']);
    await fixture.db.query(insert, [IDS.singleQuarantined, IDS.singleDoc, TALLY, 'quarantined']);
    edge = await startFakeEdge({ db: fixture.db });
  });

  afterAll(async () => {
    await edge?.close();
    await fixture?.db.close();
    restoreEnv();
  });

  beforeEach(() => {
    Object.assign(process.env, fixtureProcessEnv(edge.url));
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'single-tenant';
    process.env.MYRAG_DEPLOYMENT_MODE = 'single-tenant';
    process.env.MYRAG_INTERNAL_API_KEY = INTERNAL_API_KEY;
    process.env.RAG_VOICE_TOKEN_SECRET = SECRET;
    setSwitches({ tool: true, check: true });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setSwitches({});
  });

  it('execute evaluates against a current, ready chunk', async () => {
    const { POST } = await importRoute();
    const response = await POST(request(execute(IDS.singleChunk), single()));
    expect(response.status).toBe(200);
    expect(((await response.json()) as { result: unknown }).result).toMatchObject({ status: 'ok', value: '200' });
  });

  it('execute treats a quarantined chunk and an unknown id as unknown sources', async () => {
    const { POST } = await importRoute();
    for (const id of [IDS.singleQuarantined, '00000000-0000-4000-8000-0000000000ff']) {
      const response = await POST(request(execute(id), single()));
      expect(((await response.json()) as { result: unknown }).result).toMatchObject({ status: 'rejected', reject_reason: 'unknown_source' });
    }
  });

  it('a multi-tenant token is refused in single-tenant mode', async () => {
    const { POST } = await importRoute();
    const response = await POST(request(execute(IDS.singleChunk), token(mintScope('personal', TWO_TENANT_IDS.userA, null))));
    expect(response.status).toBe(401);
  });
});
