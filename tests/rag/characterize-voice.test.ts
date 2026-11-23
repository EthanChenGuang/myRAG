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

describe('voice-rag route characterization', () => {
  let fixture: RouteFixture;

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    fixture = await startRouteFixture({ deploymentMode: 'single-tenant' });
    process.env.RAG_VOICE_TOKEN_SECRET = TOKEN_SECRET;
    const minted = mintVoiceToken({ scope: mintScope('single', null, null), secret: TOKEN_SECRET, ttlSeconds: 3600 });
    if (!minted.ok) throw new Error(`token mint failed: ${minted.reason}`);
    scopeToken = minted.token;
  });

  afterAll(async () => {
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
    const queries = [...readGoldenQuestions().map((item) => item.question), ...INTENT_QUERIES];
    const actual: Array<{ query: string; results: unknown; source_images: unknown }> = [];
    for (const query of queries) {
      const response = await POST(voiceRequest(query));
      expect(response.status, `voice-rag failed for: ${query}`).toBe(200);
      const body = (await response.json()) as { results?: unknown; source_images?: unknown; debug_info?: unknown };
      actual.push({ query, results: body.results ?? [], source_images: body.source_images ?? [] });
    }
    expect(actual).toHaveLength(78);
    expect(actual.some((entry) => Array.isArray(entry.results) && entry.results.length > 0)).toBe(true);
    expectCharacterization('voice', actual);
  });
});
