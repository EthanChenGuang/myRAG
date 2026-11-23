import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  createFaithfulEnhancedPrompt,
  expectCharacterization,
  readGoldenQuestions,
  startRouteFixture,
  systemTextOf,
  type RouteFixture,
} from '../helpers/route-fixture';

const h = await vi.hoisted(async () => {
  const fakes = await import('../helpers/chat-route-fakes');
  return { capture: fakes.createStreamTextCapture() };
});

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  streamText: h.capture.streamText,
}));
vi.mock('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: () => (modelId: string) => ({ specificationVersion: 'v3', provider: 'fake', modelId }),
}));
vi.mock('@/lib/thinking-rag-enhancer', async (importOriginal) => {
  const { RAG_MODE_CONFIGS } = await import('@/lib/rag-mode');
  return {
    ...(await importOriginal<typeof import('@/lib/thinking-rag-enhancer')>()),
    createEnhancedRAGPrompt: createFaithfulEnhancedPrompt(RAG_MODE_CONFIGS),
  };
});

function embedRequest(question: string): NextRequest {
  return new NextRequest('http://localhost/api/embed/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
    body: JSON.stringify({ messages: [{ role: 'user', content: question }] }),
  });
}

describe('embed route characterization', () => {
  let fixture: RouteFixture;

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    fixture = await startRouteFixture({ deploymentMode: 'single-tenant' });
  });

  afterAll(async () => {
    await fixture.close();
    vi.useRealTimers();
  });

  beforeEach(() => {
    h.capture.reset();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('hands the model the same system prompt for every fixture question', async () => {
    const { POST } = await fixture.loadRoute('embed/chat');
    const questions = readGoldenQuestions();
    const actual: Array<{ id: string; system: string }> = [];
    for (const { id, question } of questions) {
      h.capture.reset();
      const response = await POST(embedRequest(question));
      await response.text();
      expect(h.capture.calls, `embed route did not reach streamText for ${id}`).toHaveLength(1);
      actual.push({ id, system: systemTextOf(h.capture.calls[0]) });
    }
    expect(actual).toHaveLength(72);
    expect(actual.every((entry) => entry.system.length > 0)).toBe(true);
    expect(fixture.edge.errors).toHaveLength(0);
    expectCharacterization('embed', actual);
  });
});
