import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RAG_AFFECTING_NAMES, ragSettingsHash } from '@/lib/rag/config-gate/settings-hash';
import { ADMIN_ID, makeEnvDir, request, silenceConsole } from '../helpers/admin-guard-fixture';

const ENV_FILE = ['NEXT_PUBLIC_APP_NAME=Demo', 'RAG_PRE_CONTEXT=Answer from the provided documents only.', 'RAG_BEHAVIOR_MODE=strict', ''].join('\n');
const NEW_PRE = 'Answer only from the supplied passages.';
const REASON = 'Reviewed by the operator before saving.';
const CHECK_ID = '22222222-2222-4222-8222-222222222222';

type Row = Record<string, unknown>;

interface Db {
  inserts: Row[];
  failInsert: boolean;
}

let db: Db;
let writeSpy: ReturnType<typeof vi.fn>;
const savedMode = process.env.RAG_CONFIG_GATE;

function fakeAdmin() {
  return {
    auth: { getUser: async () => ({ data: { user: null }, error: { message: 'invalid' } }) },
    from(table: string) {
      if (table === 'rag_config_change_records') {
        let row: Row | null = null;
        const b = {
          insert: (value: Row) => ((row = value), b),
          select: () => b,
          single: async () => {
            if (db.failInsert || !row) return { data: null, error: { code: 'PGRST500', message: 'down' } };
            const id = crypto.randomUUID();
            db.inserts.push({ ...row, id });
            return { data: { id }, error: null };
          },
        };
        return b;
      }
      const filters: Record<string, unknown> = {};
      const b = {
        select: () => b,
        abortSignal: () => b,
        eq: (column: string, value: unknown) => ((filters[column] = value), b),
        maybeSingle: async () => ({ data: filters.id === ADMIN_ID ? { id: ADMIN_ID } : null, error: null }),
      };
      return b;
    },
  };
}

async function load<T>(modulePath: string): Promise<T> {
  vi.resetModules();
  vi.doMock('@/lib/supabase/server', () => ({
    createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: ADMIN_ID } } }) } }),
  }));
  vi.doMock('@/lib/supabase', () => ({ getSupabaseAdmin: () => fakeAdmin(), getSupabase: () => ({}) }));
  vi.doMock('@/lib/env-file', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/env-file')>();
    writeSpy = vi.fn(actual.writeEnvUpdates);
    return { ...actual, writeEnvUpdates: writeSpy };
  });
  return (await import(modulePath)) as T;
}

type Route = { POST: (req: Request) => Promise<Response> };

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) out[line.slice(0, at)] = line.slice(at + 1);
  }
  return out;
}

function storeCheck(root: string, after: Record<string, string>, result: 'pass' | 'fail' = 'pass', id = CHECK_ID) {
  const dir = path.join(root, 'eval/out/config-gate');
  fs.mkdirSync(dir, { recursive: true });
  const check = {
    check_id: id,
    status: 'done',
    stage: null,
    started_at: '2026-11-26T10:00:00Z',
    finished_at: '2026-11-26T10:05:00Z',
    mode: 'enforce',
    cached: false,
    rag_settings_hash: ragSettingsHash(after, RAG_AFFECTING_NAMES),
    changed_keys: Object.keys(after).filter((name) => RAG_AFFECTING_NAMES.includes(name)),
    result,
    error_reason: null,
    layers: [
      {
        layer: 'deterministic',
        set_hash: null,
        result,
        reason: null,
        checks: [
          { check: 'refusal_rate', slice: 'overall', measured: 0.9, numerator: null, denominator: null, limit: 0.8, limit_kind: 'min', result: result === 'pass' ? 'passed' : 'failed', reason: null },
        ],
      },
      { layer: 'live', set_hash: null, result: 'skipped', reason: 'switch_off', checks: [] },
      { layer: 'real_set', set_hash: null, result: 'skipped', reason: 'real_set_too_small', checks: [] },
    ],
    saved_as: null,
  };
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(check));
}

function promptBody(ragGate?: unknown) {
  return { preContext: NEW_PRE, ...(ragGate !== undefined ? { ragGate } : {}) };
}

function promptAfter(): Record<string, string> {
  return { ...parseEnv(ENV_FILE), RAG_PRE_CONTEXT: NEW_PRE };
}

beforeEach(() => {
  db = { inserts: [], failInsert: false };
  silenceConsole();
});

afterEach(() => {
  if (savedMode === undefined) delete process.env.RAG_CONFIG_GATE;
  else process.env.RAG_CONFIG_GATE = savedMode;
  vi.restoreAllMocks();
  vi.doUnmock('@/lib/supabase/server');
  vi.doUnmock('@/lib/supabase');
  vi.doUnmock('@/lib/env-file');
});

describe('POST /api/config/rag-prompt guard', () => {
  const post = (route: Route, body: unknown) => route.POST(request('/api/config/rag-prompt', { method: 'POST', body }));

  it('enforce without ragGate answers 409 rag_gate_required and writes nothing', async () => {
    process.env.RAG_CONFIG_GATE = 'enforce';
    const env = makeEnvDir(ENV_FILE);
    const route = await load<Route>('@/app/api/config/rag-prompt/route');

    const res = await post(route, promptBody());
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json).toMatchObject({ success: false, error: 'rag_gate_required' });
    expect(typeof json.message).toBe('string');
    expect(writeSpy).not.toHaveBeenCalled();
    expect(env.read()).toBe(ENV_FILE);
    expect(db.inserts).toHaveLength(0);
  });

  it('enforce with a stored passed check of the same hash writes and records once with the admin as actor', async () => {
    process.env.RAG_CONFIG_GATE = 'enforce';
    const env = makeEnvDir(ENV_FILE);
    storeCheck(env.dir, promptAfter());
    const route = await load<Route>('@/app/api/config/rag-prompt/route');

    const res = await post(route, promptBody({ check_id: CHECK_ID }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(env.read()).toContain(`RAG_PRE_CONTEXT=${NEW_PRE}`);
    expect(db.inserts).toHaveLength(1);
    const row = db.inserts[0];
    expect(row).toMatchObject({ actor: ADMIN_ID, source: 'config_ui', gate_result: 'pass', changed_keys: ['RAG_PRE_CONTEXT'], override_reason: null });
    expect(row.after_hash).toBe(ragSettingsHash(promptAfter(), RAG_AFFECTING_NAMES));
    expect(row.before_hash).toBe(ragSettingsHash(parseEnv(ENV_FILE), RAG_AFFECTING_NAMES));
    expect(JSON.stringify(row)).not.toContain(NEW_PRE);
    expect(json.ragGate).toEqual({ record_id: row.id, gate_result: 'pass' });
  });

  it('enforce with a passed check of another hash answers 409', async () => {
    process.env.RAG_CONFIG_GATE = 'enforce';
    const env = makeEnvDir(ENV_FILE);
    storeCheck(env.dir, { ...promptAfter(), RAG_PRE_CONTEXT: 'A different proposal.' });
    const route = await load<Route>('@/app/api/config/rag-prompt/route');

    const res = await post(route, promptBody({ check_id: CHECK_ID }));

    expect(res.status).toBe(409);
    expect(env.read()).toBe(ENV_FILE);
  });

  it('enforce with an override reason writes and records the reason', async () => {
    process.env.RAG_CONFIG_GATE = 'enforce';
    const env = makeEnvDir(ENV_FILE);
    const route = await load<Route>('@/app/api/config/rag-prompt/route');

    const res = await post(route, promptBody({ override: { reason: REASON } }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(env.read()).toContain(`RAG_PRE_CONTEXT=${NEW_PRE}`);
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0]).toMatchObject({ gate_result: 'skipped', override_reason: REASON, actor: ADMIN_ID });
    expect(json.ragGate.gate_result).toBe('skipped');
  });

  it('a reason of 9 characters answers 400 invalid_reason and writes nothing', async () => {
    process.env.RAG_CONFIG_GATE = 'enforce';
    const env = makeEnvDir(ENV_FILE);
    const route = await load<Route>('@/app/api/config/rag-prompt/route');

    const res = await post(route, promptBody({ override: { reason: 'too short' } }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_reason');
    expect(writeSpy).not.toHaveBeenCalled();
    expect(env.read()).toBe(ENV_FILE);
  });

  it('an override whose record cannot be written answers 503 rag_gate_record_failed and writes nothing', async () => {
    process.env.RAG_CONFIG_GATE = 'enforce';
    db.failInsert = true;
    const env = makeEnvDir(ENV_FILE);
    const route = await load<Route>('@/app/api/config/rag-prompt/route');

    const res = await post(route, promptBody({ override: { reason: REASON } }));

    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('rag_gate_record_failed');
    expect(writeSpy).not.toHaveBeenCalled();
    expect(env.read()).toBe(ENV_FILE);
  });

  it('a missing check store directory in enforce mode answers 409, not 500', async () => {
    process.env.RAG_CONFIG_GATE = 'enforce';
    const env = makeEnvDir(ENV_FILE);
    const route = await load<Route>('@/app/api/config/rag-prompt/route');

    const res = await post(route, promptBody({ check_id: CHECK_ID }));

    expect(fs.existsSync(path.join(env.dir, 'eval/out/config-gate'))).toBe(false);
    expect(res.status).toBe(409);
    expect(env.read()).toBe(ENV_FILE);
  });

  it('warn writes without a check and records skipped', async () => {
    process.env.RAG_CONFIG_GATE = 'warn';
    const env = makeEnvDir(ENV_FILE);
    const route = await load<Route>('@/app/api/config/rag-prompt/route');

    const res = await post(route, promptBody());

    expect(res.status).toBe(200);
    expect(env.read()).toContain(`RAG_PRE_CONTEXT=${NEW_PRE}`);
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0].gate_result).toBe('skipped');
  });

  it('mode off reads no check, writes no record and answers as before', async () => {
    delete process.env.RAG_CONFIG_GATE;
    const env = makeEnvDir(ENV_FILE);
    const readSpy = vi.spyOn(fs, 'readFileSync');
    const route = await load<Route>('@/app/api/config/rag-prompt/route');

    const res = await post(route, promptBody({ check_id: CHECK_ID }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ragGate).toBeUndefined();
    expect(Object.keys(json).sort()).toEqual(['assembledPrompt', 'message', 'postContext', 'preContext', 'success']);
    expect(env.read()).toContain(`RAG_PRE_CONTEXT=${NEW_PRE}`);
    expect(db.inserts).toHaveLength(0);
    expect(readSpy.mock.calls.some(([file]) => String(file).includes('config-gate'))).toBe(false);
  });
});

describe('POST /api/config guard (in-app settings)', () => {
  const post = (route: Route, body: unknown) => route.POST(request('/api/config', { method: 'POST', body }));
  const ragChange = { RAG_BEHAVIOR_MODE: 'balanced' };
  const configAfter = () => ({ ...parseEnv(ENV_FILE), ...ragChange });

  it('enforce with a RAG-affecting change and no ragGate answers 409 with the Config UI message and writes nothing', async () => {
    process.env.RAG_CONFIG_GATE = 'enforce';
    const env = makeEnvDir(ENV_FILE);
    const route = await load<Route>('@/app/api/config/route');
    const { RAG_GATE_REQUIRED_MESSAGE } = await import('@/lib/rag/config-gate/guard');

    const res = await post(route, { config: ragChange });
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json).toEqual({ success: false, error: 'rag_gate_required', message: RAG_GATE_REQUIRED_MESSAGE });
    expect(RAG_GATE_REQUIRED_MESSAGE).toContain('Config UI');
    expect(writeSpy).not.toHaveBeenCalled();
    expect(env.read()).toBe(ENV_FILE);
  });

  it('enforce with a stored passed check of the same hash writes and records once', async () => {
    process.env.RAG_CONFIG_GATE = 'enforce';
    const env = makeEnvDir(ENV_FILE);
    storeCheck(env.dir, configAfter());
    const route = await load<Route>('@/app/api/config/route');

    const res = await post(route, { config: ragChange, ragGate: { check_id: CHECK_ID } });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(env.read()).toContain('RAG_BEHAVIOR_MODE=balanced');
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0]).toMatchObject({ actor: ADMIN_ID, gate_result: 'pass', changed_keys: ['RAG_BEHAVIOR_MODE'] });
    expect(json.ragGate).toEqual({ record_id: db.inserts[0].id, gate_result: 'pass' });
  });

  it('a change of only non-RAG-affecting names is written without a check in enforce mode', async () => {
    process.env.RAG_CONFIG_GATE = 'enforce';
    const env = makeEnvDir(ENV_FILE);
    const route = await load<Route>('@/app/api/config/route');

    const res = await post(route, { config: { NEXT_PUBLIC_APP_NAME: 'Renamed' } });

    expect(res.status).toBe(200);
    expect(env.read()).toContain('NEXT_PUBLIC_APP_NAME=Renamed');
    expect(db.inserts).toHaveLength(0);
    expect((await res.json()).ragGate).toBeUndefined();
  });

  it('mode off writes exactly as before', async () => {
    delete process.env.RAG_CONFIG_GATE;
    const env = makeEnvDir(ENV_FILE);
    const route = await load<Route>('@/app/api/config/route');

    const res = await post(route, { config: ragChange });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, message: 'Configuration saved' });
    expect(env.read()).toBe(ENV_FILE.replace('RAG_BEHAVIOR_MODE=strict', 'RAG_BEHAVIOR_MODE=balanced'));
    expect(db.inserts).toHaveLength(0);
  });
});

describe('POST /api/config/models guard', () => {
  const post = (route: Route, body: unknown) => route.POST(request('/api/config/models', { method: 'POST', body }));
  const models = {
    provider: 'openrouter',
    openaiModels: [{ id: 'model-a', displayName: 'Model A' }],
    openrouterModels: [{ id: 'vendor/model-b', displayName: 'Model B' }],
    groqModels: [],
  };
  const modelsAfter = async () => {
    const { stringifyJsonForEnv } = await import('@/lib/env-file');
    return {
      ...parseEnv(ENV_FILE),
      NEXT_PUBLIC_AI_PROVIDER: models.provider,
      NEXT_PUBLIC_OPENAI_MODELS: stringifyJsonForEnv(models.openaiModels),
      NEXT_PUBLIC_OPENROUTER_MODELS: stringifyJsonForEnv(models.openrouterModels),
      NEXT_PUBLIC_GROQ_MODELS: stringifyJsonForEnv(models.groqModels),
    };
  };

  it('enforce with a model change and no ragGate answers 409 and writes nothing', async () => {
    process.env.RAG_CONFIG_GATE = 'enforce';
    const env = makeEnvDir(ENV_FILE);
    const route = await load<Route>('@/app/api/config/models/route');

    const res = await post(route, models);

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('rag_gate_required');
    expect(writeSpy).not.toHaveBeenCalled();
    expect(env.read()).toBe(ENV_FILE);
  });

  it('enforce with a stored passed check of the same hash writes and records once', async () => {
    process.env.RAG_CONFIG_GATE = 'enforce';
    const env = makeEnvDir(ENV_FILE);
    storeCheck(env.dir, await modelsAfter());
    const route = await load<Route>('@/app/api/config/models/route');

    const res = await post(route, { ...models, ragGate: { check_id: CHECK_ID } });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(env.read()).toContain('NEXT_PUBLIC_AI_PROVIDER=openrouter');
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0]).toMatchObject({ actor: ADMIN_ID, gate_result: 'pass' });
    expect(json.ragGate).toEqual({ record_id: db.inserts[0].id, gate_result: 'pass' });
  });

  it('mode off writes exactly as before', async () => {
    delete process.env.RAG_CONFIG_GATE;
    const env = makeEnvDir(ENV_FILE);
    const route = await load<Route>('@/app/api/config/models/route');

    const res = await post(route, models);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(Object.keys(json).sort()).toEqual(['config', 'message', 'success']);
    expect(env.read()).toContain('NEXT_PUBLIC_AI_PROVIDER=openrouter');
    expect(db.inserts).toHaveLength(0);
  });
});

describe('unguarded app writers', () => {
  it('updateEnvFile (logo and favicon uploads) and custom-servers-store write no RAG-affecting name', () => {
    const file = path.join(process.cwd(), 'src/lib/rag/config-gate/rag-affecting.generated.json');
    const generated = JSON.parse(fs.readFileSync(file, 'utf8')) as { names: string[] };
    expect(generated.names.length).toBeGreaterThan(0);
    for (const name of ['NEXT_PUBLIC_HEADER_LOGO_URL', 'NEXT_PUBLIC_AI_RESPONSE_LOGO_URL', 'NEXT_PUBLIC_FAVICON_URL', 'MCP_CUSTOM_SERVERS']) {
      expect(generated.names, name).not.toContain(name);
    }
  });

  it('the unguarded writers write only those names', () => {
    const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), 'utf8');
    const logo = read('src/app/api/config/upload-logo/route.ts');
    const favicon = read('src/app/api/config/upload-favicon/route.ts');
    const servers = read('src/lib/mcp/custom-servers-store.ts');
    expect([...logo.matchAll(/'(NEXT_PUBLIC_[A-Z_]+)'/g)].map((m) => m[1]).sort()).toEqual(['NEXT_PUBLIC_AI_RESPONSE_LOGO_URL', 'NEXT_PUBLIC_HEADER_LOGO_URL']);
    expect([...favicon.matchAll(/updateEnvFile\('([A-Z_]+)'/g)].map((m) => m[1])).toEqual(['NEXT_PUBLIC_FAVICON_URL']);
    expect([...servers.matchAll(/writeEnvUpdates\(\{\s*([A-Z_]+):/g)].map((m) => m[1])).toEqual(['MCP_CUSTOM_SERVERS']);
  });
});

describe('guardAppEnvWrite actor', () => {
  it('an override without a resolvable admin id answers 503 and is not written; the resolver is not called in off mode', async () => {
    process.env.RAG_CONFIG_GATE = 'enforce';
    makeEnvDir(ENV_FILE);
    await load<Route>('@/app/api/config/rag-prompt/route');
    const { guardAppEnvWrite } = await import('@/lib/rag/config-gate/guard');
    const resolver = vi.fn(async () => null);

    const refused = await guardAppEnvWrite({ updates: { RAG_PRE_CONTEXT: NEW_PRE }, ragGate: { override: { reason: REASON } }, actorUserId: resolver, route: 'rag-prompt' });
    expect(refused).toMatchObject({ ok: false, status: 503, body: { error: 'rag_gate_record_failed' } });
    expect(db.inserts).toHaveLength(0);

    delete process.env.RAG_CONFIG_GATE;
    resolver.mockClear();
    const off = await guardAppEnvWrite({ updates: { RAG_PRE_CONTEXT: NEW_PRE }, ragGate: undefined, actorUserId: resolver, route: 'rag-prompt' });
    expect(off).toEqual({ ok: true, ragGate: null });
    expect(resolver).not.toHaveBeenCalled();
  });
});
