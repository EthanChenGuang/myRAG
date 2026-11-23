import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { createLinkUsageInstructions } from '@/lib/url-extractor';
import {
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
  streamText: async (params: Record<string, unknown>) => ({
    ...(await h.capture.streamText(params)),
    toUIMessageStreamResponse: () => new Response('ok'),
  }),
}));
vi.mock('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: () => (modelId: string) => ({ specificationVersion: 'v3', provider: 'fake', modelId }),
}));

function defaultEmbedSystemPrompt(): string {
  return `You are a helpful AI assistant with access to a knowledge base. When answering questions:

1. If the context contains relevant information, use it to provide accurate and specific answers
2. If information is not available in the context, say so clearly and suggest alternative approaches
3. Always cite your sources when referencing specific documents
4. Provide balanced, objective information rather than opinions
5. For technical topics, include practical steps or examples when appropriate

${createLinkUsageInstructions()}

Context:
{{context}}`;
}

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
    const rag = await import('@/lib/rag');
    const scope = await rag.resolveEmbedScope({
      rawBody: {},
      configuredTenant: '',
      deploymentMode: 'single-tenant',
      signal: new AbortController().signal,
    });
    if (!scope.ok) throw new Error('single-tenant embed scope should resolve');
    const questions = readGoldenQuestions();
    const actual: Array<{ id: string; system: string }> = [];
    for (const { id, question } of questions) {
      h.capture.reset();
      const response = await POST(embedRequest(question));
      await response.text();
      expect(h.capture.calls, `embed route did not reach streamText for ${id}`).toHaveLength(1);
      const system = systemTextOf(h.capture.calls[0]);
      const chatResult = await rag.runRetrieval({
        scope: scope.scope,
        query: question,
        profile: 'chat',
        options: {
          maxResults: parseInt(env.RAG_FINAL_RESULT_COUNT || '25'),
          fallbackToLowerThreshold: true,
          isGPTModel: true,
          ragMode: 'balanced',
          webSearchEnabled: false,
        },
        signal: new AbortController().signal,
      });
      expect(system, `embed prompt differs from the shared chat-format assembly for ${id}`).toBe(
        rag.createEnhancedRAGPrompt(defaultEmbedSystemPrompt(), chatResult.context),
      );
      actual.push({ id, system });
    }
    expect(actual).toHaveLength(questions.length);
    expect(actual.every((entry) => entry.system.length > 0)).toBe(true);
    expect(fixture.edge.errors).toHaveLength(0);
    expectCharacterization('embed', actual);
  });
});
