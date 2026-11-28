import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RefusalThresholds } from '@/lib/rag-eval/contracts.generated';
import { loadRagConfig, resetRagConfigForTests, type RagEnvInput } from '@/lib/rag/config';
import { LEXICAL_VERSION } from '@/lib/rag/lexical/chunk-text';
import { RERANK_TEXT_VERSION } from '@/lib/rag/rerank/types';
import { refusalCalibrationStatus } from '@/lib/rag/refusal/status';

type Cell = NonNullable<RefusalThresholds['cells']>[number];
type Language = 'zh' | 'en' | 'it';

const HASH = 'a'.repeat(64);

function cell(provider: string, model: string, language: Language, over: Partial<Cell> = {}): Cell {
  const pairing = over.pairing ?? 'same';
  return {
    config_hash: HASH,
    dev: { answerable_count: 27, correct_refusal_rate: 0.43, false_refusal_rate: 0, false_refusal_rate_upper_bound: 0.105, no_answer_count: 7 },
    holdout: { answerable_count: 7, correct_refusal_rate: 0.5, false_refusal_rate: 0.142, false_refusal_rate_upper_bound: 0.52, no_answer_count: 2 },
    holdout_evaluations: 1,
    key: `${provider}|${model}|${language}|${pairing}`,
    model,
    pairing,
    provider,
    query_language: language,
    recorded_at: '2026-11-25',
    rerank_text_version: RERANK_TEXT_VERSION,
    source: 'live',
    status: 'calibrated',
    threshold: 0.31,
    tokenizer_version: LEXICAL_VERSION,
    ...over,
  };
}

function thresholds(cells: Cell[]): RefusalThresholds {
  return { cells, config_hash: HASH, schema_version: 1 };
}

const config = (env: RagEnvInput) => loadRagConfig({ RAG_PIPELINE: 'v2', ...env });
const COHERE_ON = { RAG_RERANKER: 'cohere', RAG_REFUSAL_THRESHOLD: 'true' };
const codes = (status: { warnings: Array<{ code: string }> }) => status.warnings.map((warning) => warning.code);

beforeEach(() => resetRagConfigForTests());
afterEach(() => resetRagConfigForTests());

describe('refusalCalibrationStatus', () => {
  it('reports the switch, the reranker and the model per tier and language', () => {
    const status = refusalCalibrationStatus(thresholds([]), config(COHERE_ON));
    expect(status.pipeline).toBe('v2');
    expect(status.refusal_threshold).toBe(true);
    expect(status.reranker.provider).toBe('cohere');
    expect(status.reranker.score_semantics).toBe('calibrated');
    expect(status.reranker.tiers.chat).toEqual({ tier: 'quality', models: { zh: 'rerank-v5.0-pro', en: 'rerank-v5.0-pro', it: 'rerank-v5.0-pro' } });
    expect(status.reranker.tiers.voice).toEqual({ tier: 'fast', models: { zh: 'rerank-v5.0-fast', en: 'rerank-v5.0-fast', it: 'rerank-v5.0-fast' } });
    expect(status.versions).toEqual({ tokenizer: LEXICAL_VERSION, rerank_text: RERANK_TEXT_VERSION });
  });

  it('lists every cell with status, source, threshold, point estimates, 95% upper bounds, counts and staleness', () => {
    const fresh = cell('cohere', 'rerank-v5.0-pro', 'en');
    const oldTokenizer = cell('cohere', 'rerank-v5.0-pro', 'zh', { tokenizer_version: LEXICAL_VERSION - 1 });
    const oldRerankText = cell('cohere', 'rerank-v5.0-pro', 'it', { rerank_text_version: RERANK_TEXT_VERSION + 1, status: 'insufficient_data', threshold: null });
    const status = refusalCalibrationStatus(thresholds([fresh, oldTokenizer, oldRerankText]), config(COHERE_ON));
    expect(status.cells).toHaveLength(3);
    expect(status.cells[0]).toEqual({
      key: 'cohere|rerank-v5.0-pro|en|same',
      provider: 'cohere',
      model: 'rerank-v5.0-pro',
      query_language: 'en',
      pairing: 'same',
      status: 'calibrated',
      source: 'live',
      threshold: 0.31,
      stale: false,
      tokenizer_version: LEXICAL_VERSION,
      rerank_text_version: RERANK_TEXT_VERSION,
      recorded_at: '2026-11-25',
      holdout_evaluations: 1,
      dev: {
        answerable_count: 27,
        no_answer_count: 7,
        false_refusal_point_estimate: 0,
        false_refusal_upper_bound_95: 0.105,
        correct_refusal_point_estimate: 0.43,
      },
      holdout: {
        answerable_count: 7,
        no_answer_count: 2,
        false_refusal_point_estimate: 0.142,
        false_refusal_upper_bound_95: 0.52,
        correct_refusal_point_estimate: 0.5,
      },
    });
    expect(status.cells.map((entry) => entry.stale)).toEqual([false, true, true]);
    expect(status.cells[2]?.threshold).toBeNull();
  });

  it('warns refusal_on_without_calibrated_cell naming the languages without a usable live cell for the configured model', () => {
    const cells = [
      cell('cohere', 'rerank-v5.0-pro', 'en'),
      cell('cohere', 'rerank-v5.0-fast', 'en'),
      cell('cohere', 'rerank-v5.0-pro', 'zh', { source: 'fixture' }),
      cell('cohere', 'rerank-v5.0-fast', 'zh'),
      cell('cohere', 'rerank-v5.0-pro', 'it', { status: 'failed_holdout' }),
      cell('cohere', 'rerank-v5.0-fast', 'it'),
      cell('voyage', 'rerank-3', 'it'),
    ];
    const status = refusalCalibrationStatus(thresholds(cells), config(COHERE_ON));
    const warning = status.warnings.find((entry) => entry.code === 'refusal_on_without_calibrated_cell');
    expect(warning).toBeDefined();
    expect(warning?.languages).toEqual(['zh', 'it']);
    expect(warning?.missing).toEqual([
      { tier: 'chat', model: 'rerank-v5.0-pro', query_language: 'zh' },
      { tier: 'chat', model: 'rerank-v5.0-pro', query_language: 'it' },
    ]);
    expect(warning?.message).toMatch(/similarity floor/);
  });

  it('gives no refusal_on_without_calibrated_cell when every configured model and language has a live calibrated cell', () => {
    const cells = (['zh', 'en', 'it'] as const).flatMap((language) => [
      cell('cohere', 'rerank-v5.0-pro', language),
      cell('cohere', 'rerank-v5.0-fast', language),
    ]);
    expect(codes(refusalCalibrationStatus(thresholds(cells), config(COHERE_ON)))).toEqual([]);
  });

  it('gives no refusal_on_without_calibrated_cell while the refusal switch is off', () => {
    expect(codes(refusalCalibrationStatus(thresholds([]), config({ RAG_RERANKER: 'cohere' })))).not.toContain('refusal_on_without_calibrated_cell');
  });

  it('treats a stale calibrated cell as missing and warns stale_cells with its key', () => {
    const cells = (['zh', 'en', 'it'] as const).flatMap((language) => [
      cell('cohere', 'rerank-v5.0-pro', language, language === 'zh' ? { tokenizer_version: LEXICAL_VERSION + 1 } : {}),
      cell('cohere', 'rerank-v5.0-fast', language),
    ]);
    const status = refusalCalibrationStatus(thresholds(cells), config(COHERE_ON));
    expect(codes(status)).toEqual(['refusal_on_without_calibrated_cell', 'stale_cells']);
    expect(status.warnings.find((entry) => entry.code === 'stale_cells')?.keys).toEqual(['cohere|rerank-v5.0-pro|zh|same']);
    expect(status.warnings.find((entry) => entry.code === 'refusal_on_without_calibrated_cell')?.languages).toEqual(['zh']);
  });

  it('warns fixture_cells_only when every cell comes from the fixture run', () => {
    const cells = [cell('cohere', 'fake-quality-v1', 'en', { source: 'fixture' }), cell('cohere', 'fake-quality-v1', 'it', { source: 'fixture' })];
    expect(codes(refusalCalibrationStatus(thresholds(cells), config({ RAG_RERANKER: 'cohere' })))).toEqual(['fixture_cells_only']);
    expect(codes(refusalCalibrationStatus(thresholds([...cells, cell('cohere', 'rerank-v5.0-pro', 'en')]), config({ RAG_RERANKER: 'cohere' })))).toEqual([]);
  });

  it('warns relative_reranker for local_bm25 and gives no cell warning for it', () => {
    const status = refusalCalibrationStatus(thresholds([]), config({ RAG_RERANKER: 'local_bm25', RAG_REFUSAL_THRESHOLD: 'true' }));
    expect(status.reranker.score_semantics).toBe('relative');
    expect(codes(status)).toEqual(['relative_reranker']);
    expect(status.warnings[0]?.message).toMatch(/relative/);
  });

  it('with refusal on and no reranker names every language: the similarity floor decides everywhere', () => {
    const status = refusalCalibrationStatus(thresholds([]), config({ RAG_RERANKER: 'none', RAG_REFUSAL_THRESHOLD: 'true' }));
    expect(status.reranker.score_semantics).toBeNull();
    expect(status.warnings).toEqual([expect.objectContaining({ code: 'refusal_on_without_calibrated_cell', languages: ['zh', 'en', 'it'], missing: [] })]);
  });

  it('an invalid thresholds file gives no cells and thresholds_invalid', () => {
    const status = refusalCalibrationStatus(null, config({ RAG_RERANKER: 'cohere' }));
    expect(status.cells).toEqual([]);
    expect(codes(status)).toEqual(['thresholds_invalid']);
  });

  it('labels say point estimate and 95% upper bound and no text claims a rate at or below the target', () => {
    const cells = [cell('cohere', 'fake-quality-v1', 'en', { source: 'fixture', tokenizer_version: 0 })];
    const status = refusalCalibrationStatus(thresholds(cells), config({ RAG_RERANKER: 'cohere', RAG_REFUSAL_THRESHOLD: 'true' }));
    expect(status.labels).toEqual({ false_refusal_point_estimate: 'point estimate', false_refusal_upper_bound_95: '95% upper bound' });
    const text = JSON.stringify(status);
    expect(text).not.toMatch(/≤|<=|at or below|under 5|below 5|(?<!9)5%/i);
  });
});

const ADMIN_ID = '00000000-0000-4000-8000-0000000000a1';
const USER_ID = '00000000-0000-4000-8000-0000000000b1';

const guard = {
  admins: [ADMIN_ID] as string[],
  session: null as { id: string } | null,
  tokens: {} as Record<string, string>,
  sessionThrows: false,
  lookupFails: false,
  statusCalls: 0,
};

function fakeGuardClient() {
  return {
    auth: {
      getUser: async (token: string) => {
        const id = guard.tokens[token];
        return id ? { data: { user: { id } }, error: null } : { data: { user: null }, error: { message: 'invalid' } };
      },
    },
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const builder = {
        select: () => builder,
        abortSignal: () => builder,
        eq(column: string, value: unknown) {
          filters[column] = value;
          return builder;
        },
        maybeSingle() {
          if (table !== 'admin_users') throw new Error(`the guard read ${table}`);
          if (guard.lookupFails) return Promise.resolve({ data: null, error: { message: 'down' } });
          return Promise.resolve({ data: guard.admins.includes(filters.id as string) ? { id: filters.id } : null, error: null });
        },
      };
      return builder;
    },
  };
}

async function loadRoute(env: RagEnvInput = { RAG_PIPELINE: 'v2', RAG_RERANKER: 'cohere', RAG_REFUSAL_THRESHOLD: 'true' }) {
  vi.resetModules();
  vi.doMock('@/lib/supabase/server', () => ({
    createClient: async () => ({
      auth: {
        getUser: async () => {
          if (guard.sessionThrows) throw new Error('auth down');
          return { data: { user: guard.session } };
        },
      },
    }),
  }));
  vi.doMock('@/lib/supabase', () => ({ getSupabaseAdmin: () => fakeGuardClient(), getSupabase: () => ({}) }));
  vi.doMock('@/lib/rag', async (importOriginal) => {
    const original = await importOriginal<Record<string, unknown>>();
    return {
      ...original,
      currentRefusalCalibrationStatus: () => {
        guard.statusCalls += 1;
        return (original.currentRefusalCalibrationStatus as () => unknown)();
      },
    };
  });
  const ragDeps = await import('@/lib/rag/deps');
  ragDeps.setRagDepsForTests({ adminClient: () => null, ragEnv: () => env });
  const session = await import('@/lib/admin-session');
  const route = await import('@/app/api/rag/admin/refusal-calibration/route');
  return { session, route };
}

function get(init: { cookie?: string; authorization?: string } = {}) {
  const headers: Record<string, string> = {};
  if (init.cookie) headers.cookie = init.cookie;
  if (init.authorization) headers.authorization = init.authorization;
  return new NextRequest('http://localhost/api/rag/admin/refusal-calibration', { method: 'GET', headers });
}

const cookieOf = (value: string | null) => `admin_session=${value}`;

describe('GET /api/rag/admin/refusal-calibration', () => {
  beforeEach(() => {
    guard.admins = [ADMIN_ID];
    guard.session = null;
    guard.tokens = {};
    guard.sessionThrows = false;
    guard.lookupFails = false;
    guard.statusCalls = 0;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('@/lib/rag');
    vi.resetModules();
  });

  it('exports runtime nodejs and dynamic force-dynamic', async () => {
    const { route } = await loadRoute();
    expect(route.runtime).toBe('nodejs');
    expect(route.dynamic).toBe('force-dynamic');
  });

  it('without any credential gives 401 and computes nothing', async () => {
    const { route } = await loadRoute();
    const response = await route.GET(get());
    expect(response.status).toBe(401);
    expect((await response.json()).success).toBe(false);
    expect(guard.statusCalls).toBe(0);
  });

  it('gives 401 to a forged or unsigned admin_session cookie and to the literal admin bearer', async () => {
    const { route, session } = await loadRoute();
    expect((await route.GET(get({ cookie: cookieOf(ADMIN_ID) }))).status).toBe(401);
    const signed = session.mintAdminSessionValue(ADMIN_ID) as string;
    const [id, expiry, signature] = signed.split('.');
    const flipped = `${signature!.slice(0, -1)}${signature!.endsWith('A') ? 'B' : 'A'}`;
    expect((await route.GET(get({ cookie: cookieOf(`${id}.${expiry}.${flipped}`) }))).status).toBe(401);
    expect((await route.GET(get({ authorization: 'Bearer admin' }))).status).toBe(401);
    expect(guard.statusCalls).toBe(0);
  });

  it('gives 403 to a signed cookie of a non-admin and to a non-admin session or token', async () => {
    const { route, session } = await loadRoute();
    guard.session = { id: USER_ID };
    expect((await route.GET(get({ cookie: cookieOf(session.mintAdminSessionValue(USER_ID)) }))).status).toBe(403);
    expect((await route.GET(get())).status).toBe(403);
    guard.session = null;
    guard.tokens = { 'token-user': USER_ID };
    expect((await route.GET(get({ authorization: 'Bearer token-user' }))).status).toBe(403);
    expect(guard.statusCalls).toBe(0);
  });

  it('gives 503 when auth throws and when the admin_users lookup fails', async () => {
    const { route } = await loadRoute();
    guard.sessionThrows = true;
    expect((await route.GET(get())).status).toBe(503);
    guard.sessionThrows = false;
    guard.session = { id: ADMIN_ID };
    guard.lookupFails = true;
    expect((await route.GET(get())).status).toBe(503);
    expect(guard.statusCalls).toBe(0);
  });

  it('admits a signed admin cookie and an admin bearer token and returns the status, no-store', async () => {
    const { route, session } = await loadRoute();
    guard.session = { id: ADMIN_ID };
    const withCookie = await route.GET(get({ cookie: cookieOf(session.mintAdminSessionValue(ADMIN_ID)) }));
    expect(withCookie.status).toBe(200);
    expect(withCookie.headers.get('cache-control')).toBe('no-store');
    const body = await withCookie.json();
    expect(body.success).toBe(true);
    expect(body.refusal_threshold).toBe(true);
    expect(body.reranker.provider).toBe('cohere');
    expect(Array.isArray(body.cells)).toBe(true);
    expect(body.cells.length).toBeGreaterThan(0);
    expect(body.warnings.map((warning: { code: string }) => warning.code)).toContain('refusal_on_without_calibrated_cell');
    expect(body.warnings.map((warning: { code: string }) => warning.code)).toContain('fixture_cells_only');
    guard.session = null;
    guard.tokens = { 'token-admin': ADMIN_ID };
    expect((await route.GET(get({ authorization: 'Bearer token-admin' }))).status).toBe(200);
    expect(guard.statusCalls).toBe(2);
  });

  it('offers no way to change a threshold', async () => {
    const { route } = await loadRoute();
    expect(Object.keys(route).filter((name) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(name))).toEqual([]);
  });
});

describe('refusalCalibrationStatus with the effective lexical version and mode cells (D-24, D-42)', () => {
  beforeEach(() => resetRagConfigForTests());

  it('with both lexical switches off reports tokenizer 2 and no cell at version 2 is stale', () => {
    const status = refusalCalibrationStatus(thresholds([cell('cohere', 'rerank-v5.0-pro', 'en', { tokenizer_version: 2 })]), config(COHERE_ON));
    expect(status.versions.tokenizer).toBe(2);
    expect(status.cells[0]?.stale).toBe(false);
    expect(codes(status)).not.toContain('stale_cells');
  });

  it.each([
    [{ RAG_LEXICAL_DICTIONARY: 'true' }, 3],
    [{ RAG_LEXICAL_STEM_IT: 'true' }, 4],
    [{ RAG_LEXICAL_DICTIONARY: 'true', RAG_LEXICAL_STEM_IT: 'true' }, 5],
  ])('with %o on every cell calibrated at version 2 is stale against version %i', (env, version) => {
    const cells = [cell('cohere', 'rerank-v5.0-pro', 'en', { tokenizer_version: 2 }), cell('cohere', 'rerank-v5.0-pro', 'zh', { tokenizer_version: 2 })];
    const status = refusalCalibrationStatus(thresholds(cells), config({ ...COHERE_ON, RAG_LEXICAL_SEARCH: 'true', ...env }));
    expect(status.versions.tokenizer).toBe(version);
    expect(status.cells.every((entry) => entry.stale)).toBe(true);
    expect(codes(status)).toContain('stale_cells');
  });

  it('lists the mode of a mode cell and adds no mode field to a base cell', () => {
    const base = cell('cohere', 'rerank-v5.0-pro', 'en');
    const strict = cell('cohere', 'rerank-v5.0-pro', 'en', { key: 'cohere|rerank-v5.0-pro|en|same|strict', mode: 'strict' });
    const status = refusalCalibrationStatus({ ...thresholds([base, strict]), schema_version: 2 }, config(COHERE_ON));
    expect(status.cells[0]).not.toHaveProperty('mode');
    expect(status.cells[1]?.mode).toBe('strict');
  });
});
