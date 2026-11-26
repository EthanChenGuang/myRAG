import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { NextRequest } from 'next/server';
import { mintScope } from '@/lib/rag/tenant/scope';
import { mintVoiceToken } from '@/lib/rag/tenant/voice-token';
import {
  expectCharacterization,
  INTERNAL_API_KEY,
  readGoldenQuestions,
  startRouteFixture,
  type RouteFixture,
} from '../helpers/route-fixture';

const INTENT_QUERIES = [
  'show me the warehouse floorplan image',
  'warehouse floorplan picture',
  'what does the logo look like',
  'who created this',
  'floorplan',
  'logo',
];

const TOKEN_SECRET = crypto.randomBytes(24).toString('hex');
let scopeToken = '';

function voiceRequest(query: string, apiKey: string = INTERNAL_API_KEY): NextRequest {
  return new NextRequest('http://localhost/api/internal/voice-rag', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'x-rag-scope-token': scopeToken },
    body: JSON.stringify({ query, matchCount: 5 }),
  });
}

interface Configuration {
  name: string;
  env: Record<string, string | undefined>;
  defaultPipeline: 'v2' | null;
}

// One snapshot file, two configurations: the explicit legacy pipeline, and a defaulted v2 whose languages are not chosen (D-24).
const CONFIGURATIONS: Configuration[] = [
  { name: 'explicit legacy', env: { RAG_PIPELINE: 'legacy' }, defaultPipeline: null },
  {
    name: 'languages unset under a defaulted v2',
    env: { RAG_PIPELINE: undefined, RAG_SUPPORTED_LANGUAGES: undefined, RAG_PRIMARY_LANGUAGE: undefined },
    defaultPipeline: 'v2',
  },
];

/** The route modules are re-imported per load, so the shipped default is set on the instance the route just loaded. */
async function applyDefaultPipeline(pipeline: 'v2' | null): Promise<void> {
  const config = await import('@/lib/rag/config');
  config.setDefaultPipelineForTests(pipeline);
  config.resetRagConfigForTests();
}

function hybridCalls(fixture: RouteFixture): number {
  return fixture.edge.calls.filter((call) => call.path === '/rest/v1/rpc/hybrid_search_chunks').length;
}

describe.each(CONFIGURATIONS)('voice-rag route characterization, $name', (configuration) => {
  let fixture: RouteFixture;

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    fixture = await startRouteFixture({ deploymentMode: 'single-tenant', env: configuration.env });
    process.env.RAG_VOICE_TOKEN_SECRET = TOKEN_SECRET;
    const minted = mintVoiceToken({ scope: mintScope('single', null, null), secret: TOKEN_SECRET, ttlSeconds: 3600 });
    if (!minted.ok) throw new Error(`token mint failed: ${minted.reason}`);
    scopeToken = minted.token;
  });

  afterAll(async () => {
    await applyDefaultPipeline(null);
    await fixture.close();
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('rejects a request without the internal key', async () => {
    const { POST } = await fixture.loadRoute('internal/voice-rag');
    const response = await POST(voiceRequest('refund window', 'wrong-key'));
    expect(response.status).toBe(401);
  });

  it('returns the same results and source images for every fixture and intent query', async () => {
    const { POST } = await fixture.loadRoute('internal/voice-rag');
    await applyDefaultPipeline(configuration.defaultPipeline);
    const hybridBefore = hybridCalls(fixture);
    const queries = [...readGoldenQuestions().map((item) => item.question), ...INTENT_QUERIES];
    const actual: Array<{ query: string; results: unknown; source_images: unknown }> = [];
    for (const query of queries) {
      const response = await POST(voiceRequest(query));
      expect(response.status, `voice-rag failed for: ${query}`).toBe(200);
      const body = (await response.json()) as { results?: unknown; source_images?: unknown; debug_info?: unknown };
      actual.push({ query, results: body.results ?? [], source_images: body.source_images ?? [] });
    }
    expect(actual).toHaveLength(queries.length);
    expect(actual.some((entry) => Array.isArray(entry.results) && entry.results.length > 0)).toBe(true);
    expect(hybridCalls(fixture) - hybridBefore).toBe(0);
    expectCharacterization('voice', actual);
  });

  it.runIf(configuration.defaultPipeline === 'v2')('languages unset under a defaulted v2 never calls hybrid_search_chunks', async () => {
    const { POST } = await fixture.loadRoute('internal/voice-rag');
    await applyDefaultPipeline(configuration.defaultPipeline);
    const before = hybridCalls(fixture);
    for (const query of INTENT_QUERIES) expect((await POST(voiceRequest(query))).status).toBe(200);
    expect(hybridCalls(fixture) - before).toBe(0);
  });

  it.runIf(configuration.defaultPipeline === null)('under RAG_PIPELINE=v2 returns the same wire contract as legacy for every fixture and intent query', async () => {
    const phase4Off = { RAG_LEXICAL_SEARCH: 'false', RAG_RERANKER: 'none', RAG_REFUSAL_THRESHOLD: 'false', RAG_REFUSAL_FLOOR: 'similarity' };
    const saved = Object.fromEntries(Object.keys(phase4Off).map((name) => [name, process.env[name]]));
    Object.assign(process.env, phase4Off, { RAG_PIPELINE: 'v2' });
    const { POST } = await fixture.loadRoute('internal/voice-rag');
    const queries = [...readGoldenQuestions().map((item) => item.question), ...INTENT_QUERIES];
    const actual: Array<{ query: string; results: unknown; source_images: unknown }> = [];
    for (const query of queries) {
      const response = await POST(voiceRequest(query));
      expect(response.status, `voice-rag v2 failed for: ${query}`).toBe(200);
      const body = (await response.json()) as { results?: unknown; source_images?: unknown };
      actual.push({ query, results: body.results ?? [], source_images: body.source_images ?? [] });
    }
    expectCharacterization('voice-v2', actual);
    process.env.RAG_PIPELINE = 'legacy';
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
});
