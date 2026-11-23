import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { runRetrieval } from '@/lib/rag';
import { mintScope } from '@/lib/rag/tenant/scope';
import type { Profile, RunRetrievalInput } from '@/lib/rag/types';
import {
  SEMANTIC_QUERY,
  fakeAssemblyAdmin,
  fakeEmbedder,
  fakeRpcClient,
  installDeps,
  rows,
  uninstallDeps,
} from './helpers/pipeline-fakes';

const scope = mintScope('single', null, null);
const SECRET = 'a'.repeat(48);
const ROUTE_URL = 'http://localhost/api/internal/rag/run';

function install(count = 4) {
  const rpc = fakeRpcClient({ rows: rows(count) });
  installDeps({
    anonClient: () => rpc.client,
    embedder: fakeEmbedder().embedder,
    ragEnv: () => ({}),
  });
}

function run(profile: Profile, degrade?: 'drop_top_candidate') {
  const extra: Partial<RunRetrievalInput> = degrade ? { options: { degrade } } : {};
  return runRetrieval({ scope, query: SEMANTIC_QUERY, profile, signal: new AbortController().signal, ...extra });
}

beforeEach(() => {
  uninstallDeps();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  uninstallDeps();
});

describe('degrade option in the pipeline', () => {
  test('the eval profile drops the best-ranked candidate before post_filter', async () => {
    install(4);
    const baseline = await run('eval');
    const degraded = await run('eval', 'drop_top_candidate');
    expect(baseline.candidates.map((candidate) => candidate.chunk_id)).toEqual(['chunk-1', 'chunk-2', 'chunk-3', 'chunk-4']);
    expect(degraded.candidates.map((candidate) => candidate.chunk_id)).toEqual(['chunk-2', 'chunk-3', 'chunk-4']);
    expect(degraded.stages.find((stage) => stage.name === 'post_filter')).toMatchObject({ candidates_in: 3, candidates_out: 3 });
    expect(degraded.kept.map((chunk) => chunk.chunk_id)).toEqual(['chunk-2', 'chunk-3', 'chunk-4']);
  });

  test.each<Profile>(['chat', 'embed', 'media'])('the %s profile ignores degrade', async (profile) => {
    install(4);
    const baseline = await run(profile);
    const degraded = await run(profile, 'drop_top_candidate');
    expect(degraded.candidates.map((candidate) => candidate.chunk_id)).toEqual(baseline.candidates.map((candidate) => candidate.chunk_id));
    expect(degraded.status).toBe(baseline.status);
    expect(degraded.reason).toBe(baseline.reason);
    expect(degraded.context).toBe(baseline.context);
  });

  test('the voice profile ignores degrade', async () => {
    const rpc = fakeRpcClient({ rows: rows(3) });
    const assemblyAdmin = fakeAssemblyAdmin()() as unknown as { from: unknown };
    installDeps({
      embedder: fakeEmbedder().embedder,
      ragEnv: () => ({ RAG_DISABLED_STAGES: 'voice_keyword_fallback' }),
      adminClient: (() => ({ rpc: rpc.client.rpc.bind(rpc.client), from: assemblyAdmin.from })) as never,
    });
    const baseline = await run('voice');
    const degraded = await run('voice', 'drop_top_candidate');
    expect(degraded.voice?.results.map((row) => row.chunk_id)).toEqual(baseline.voice?.results.map((row) => row.chunk_id));
  });
});

describe('degrade option on the eval route', () => {
  const env = process.env as Record<string, string | undefined>;
  const names = ['RAG_EVAL_SECRET', 'RAG_EVAL_ENDPOINT_ENABLED', 'NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE', 'NODE_ENV'] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(names.map((name) => [name, env[name]]));
  });

  afterEach(async () => {
    for (const name of names) {
      if (saved[name] === undefined) delete env[name];
      else env[name] = saved[name];
    }
    const deps = await import('@/lib/rag/deps');
    deps.resetRagDepsForTests();
    vi.resetModules();
  });

  async function post(options: Record<string, unknown>) {
    env.RAG_EVAL_SECRET = SECRET;
    env.NODE_ENV = 'test';
    delete env.RAG_EVAL_ENDPOINT_ENABLED;
    env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'single-tenant';
    vi.resetModules();
    const deps = await import('@/lib/rag/deps');
    const rpc = fakeRpcClient({ rows: rows(4) });
    deps.setRagDepsForTests({
      embedder: fakeEmbedder().embedder,
      anonClient: () => rpc.client,
      adminClient: fakeAssemblyAdmin(),
    });
    const route = await import('@/app/api/internal/rag/run/route');
    const req = new NextRequest(ROUTE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rag-eval-secret': SECRET },
      body: JSON.stringify({ schema_version: 1, query: SEMANTIC_QUERY, rag_mode: 'strict', options }),
    });
    const res = await route.POST(req);
    return { status: res.status, json: (await res.json()) as { candidates?: Array<{ chunk_id: string }> } };
  }

  test('options.degrade reaches the pipeline', async () => {
    const res = await post({ degrade: 'drop_top_candidate' });
    expect(res.status).toBe(200);
    expect(res.json.candidates?.map((candidate) => candidate.chunk_id)).toEqual(['chunk-2', 'chunk-3', 'chunk-4']);
  });

  test('without degrade the full candidate list is returned', async () => {
    const res = await post({});
    expect(res.status).toBe(200);
    expect(res.json.candidates).toHaveLength(4);
  });

  test('an unknown degrade value is rejected by validation', async () => {
    const res = await post({ degrade: 'drop_everything' });
    expect(res.status).toBe(400);
  });
});
