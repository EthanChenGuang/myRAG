import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { answerLanguageInstruction } from '@/lib/rag/generation/answer-language';
import type { RetrievalResult } from '@/lib/rag/types';
import { chatRequest } from '../helpers/chat-route-fakes';
import { readGoldenQuestions, startRouteFixture, systemTextOf, type RouteFixture } from '../helpers/route-fixture';

const h = await vi.hoisted(async () => {
  const fakes = await import('../helpers/chat-route-fakes');
  return {
    capture: fakes.createStreamTextCapture(),
    exa: fakes.createExaFake(),
    ssr: { auth: { getUser: async () => ({ data: { user: null }, error: null }) } },
    plan: null as null | { askerLanguage: 'zh' | 'en' | 'it'; documentLanguage: string },
  };
});

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  streamText: h.capture.streamText,
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.ssr }));
vi.mock('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: () => (modelId: string) => ({ specificationVersion: 'v3', provider: 'fake', modelId }),
}));
vi.mock('exa-js', () => ({ default: h.exa.Exa }));
vi.mock('@/lib/rag', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/rag')>();
  return {
    ...original,
    runRetrieval: async (input: Parameters<typeof original.runRetrieval>[0]): Promise<RetrievalResult> => {
      const result = await original.runRetrieval(input);
      const plan = h.plan;
      if (!plan) return result;
      // Stands in for the query layer: a plan in the asker's language and documents in another one.
      return {
        ...result,
        candidates: result.candidates.map((candidate) => ({ ...candidate, language: plan.documentLanguage })),
        queryPlan: {
          date_range: null,
          framework: 'llamaindex',
          gate: { lang: plan.askerLanguage, protected_tokens: [], reasons: [], rewrite: false, skip_retrieval: false, transforms: [] },
          language: plan.askerLanguage,
          original: input.query,
          standalone: input.query,
        },
      };
    },
  };
});

function embedRequest(question: string): NextRequest {
  return new NextRequest('http://localhost/api/embed/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
    body: JSON.stringify({ messages: [{ role: 'user', content: question }] }),
  });
}

type Post = (request: NextRequest) => Promise<Response>;

/** The system text of the first golden question that reaches the model. */
async function firstAnsweredSystem(post: Post, build: (question: string) => NextRequest): Promise<string> {
  for (const { question } of readGoldenQuestions()) {
    h.capture.reset();
    const response = await post(build(question));
    await response.text();
    if (h.capture.calls.length === 1) return systemTextOf(h.capture.calls[0]);
  }
  throw new Error('no golden question reached the model');
}

const chatBuild = (question: string) =>
  chatRequest({ messages: [{ role: 'user', content: question }], data: { ragMode: 'strict', settings: { webSearch: false } } });

describe('answer-language line in the chat and embed routes (D-25)', () => {
  let fixture: RouteFixture;

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    fixture = await startRouteFixture({ deploymentMode: 'single-tenant', env: { RAG_PIPELINE: 'legacy' } });
  });

  afterAll(async () => {
    await fixture.close();
    vi.useRealTimers();
  });

  beforeEach(() => {
    h.capture.reset();
    h.exa.reset();
    h.plan = null;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('chat: a plan in another language than the documents adds the line; no plan adds nothing', async () => {
    const { POST } = await fixture.loadRoute<{ POST: Post }>('chat');
    const line = answerLanguageInstruction({ answerLanguage: 'it', contextLanguages: ['zh'] }) as string;

    const without = await firstAnsweredSystem(POST, chatBuild);
    expect(without).not.toContain(line);

    h.plan = { askerLanguage: 'it', documentLanguage: 'zh' };
    const withPlan = await firstAnsweredSystem(POST, chatBuild);
    expect(withPlan).toContain(line);
    expect(withPlan.replace(`\n\n${line}`, '')).toBe(without);
  });

  it('chat: matching languages leave the system prompt unchanged', async () => {
    const { POST } = await fixture.loadRoute<{ POST: Post }>('chat');
    const without = await firstAnsweredSystem(POST, chatBuild);
    h.plan = { askerLanguage: 'en', documentLanguage: 'en' };
    expect(await firstAnsweredSystem(POST, chatBuild)).toBe(without);
  });

  it('embed: a plan in another language than the documents adds the line; no plan adds nothing', async () => {
    const { POST } = await fixture.loadRoute<{ POST: Post }>('embed/chat');
    const line = answerLanguageInstruction({ answerLanguage: 'zh', contextLanguages: ['en'] }) as string;

    const without = await firstAnsweredSystem(POST, embedRequest);
    expect(without).not.toContain(line);

    h.plan = { askerLanguage: 'zh', documentLanguage: 'en' };
    const withPlan = await firstAnsweredSystem(POST, embedRequest);
    expect(withPlan).toContain(line);
    expect(withPlan.replace(`\n\n${line}`, '')).toBe(without);
  });
});
