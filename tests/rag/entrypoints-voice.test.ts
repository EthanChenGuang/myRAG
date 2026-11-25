import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { mintScope } from '@/lib/rag/tenant/scope';
import { mintVoiceToken } from '@/lib/rag/tenant/voice-token';
import { INTERNAL_API_KEY, startRouteFixture, type RouteFixture } from '../helpers/route-fixture';

interface TraceLine {
  profile: string;
  tenantKey: string;
  status: string;
  stages: Array<{ name: string; status: string }>;
}

function traceLines(spy: ReturnType<typeof vi.spyOn>): TraceLine[] {
  return spy.mock.calls
    .map((args: unknown[]) => String(args[0]))
    .filter((line: string) => line.startsWith('[RAG Trace] '))
    .map((line: string) => JSON.parse(line.slice('[RAG Trace] '.length)) as TraceLine);
}

describe('voice entry points call the pipeline', () => {
  const secret = crypto.randomBytes(24).toString('hex');
  let fixture: RouteFixture;
  let token = '';

  beforeAll(async () => {
    fixture = await startRouteFixture({ deploymentMode: 'single-tenant' });
    process.env.RAG_VOICE_TOKEN_SECRET = secret;
    const minted = mintVoiceToken({ scope: mintScope('single', null, null), secret, ttlSeconds: 600 });
    if (!minted.ok) throw new Error(`token mint failed: ${minted.reason}`);
    token = minted.token;
  });

  afterAll(async () => {
    await fixture.close();
  });

  it('voice-rag runs runRetrieval with the voice profile and its five stages', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { POST } = await fixture.loadRoute('internal/voice-rag');
      const response = await POST(
        new NextRequest('http://localhost/api/internal/voice-rag', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': INTERNAL_API_KEY, 'x-rag-scope-token': token },
          body: JSON.stringify({ query: 'refund window', matchCount: 5 }),
        }),
      );
      expect(response.status).toBe(200);

      const traces = traceLines(log);
      expect(traces).toHaveLength(1);
      expect(traces[0].profile).toBe('voice');
      expect(traces[0].tenantKey).toBe('s:default');
      expect(traces[0].stages.map((stage) => stage.name)).toEqual(['embed', 'search', 'voice_keyword_fallback', 'local_rerank', 'assemble']);
      expect(traces[0].stages.every((stage) => stage.status === 'ok')).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
