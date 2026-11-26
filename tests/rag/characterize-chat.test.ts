import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '@/lib/env';
import { chatRequest } from '../helpers/chat-route-fakes';
import {
  expectCharacterization,
  readGoldenQuestions,
  startRouteFixture,
  systemTextOf,
  type RouteFixture,
} from '../helpers/route-fixture';

const h = await vi.hoisted(async () => {
  const fakes = await import('../helpers/chat-route-fakes');
  return {
    capture: fakes.createStreamTextCapture(),
    exa: fakes.createExaFake(),
    ssr: { auth: { getUser: async () => ({ data: { user: null }, error: null }) } },
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

const GPT_PATTERN = /gpt-4|o1|chatgpt/;

function configuredModelIds(): string[] {
  const models = JSON.parse(env.NEXT_PUBLIC_OPENROUTER_MODELS) as Array<{ id: string }>;
  return models.map((model) => model.id);
}

function readSseText(body: string): string {
  let text = '';
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '' || payload === '[DONE]') continue;
    try {
      const chunk = JSON.parse(payload) as { type?: string; delta?: string };
      if (chunk.type === 'text-delta' && typeof chunk.delta === 'string') text += chunk.delta;
    } catch {
      continue;
    }
  }
  return text;
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

describe.each(CONFIGURATIONS)('chat route characterization (strict mode, web search off), $name', (configuration) => {
  let fixture: RouteFixture;
  const gptModel = configuredModelIds().find((id) => GPT_PATTERN.test(id));
  const otherModel = configuredModelIds().find((id) => !GPT_PATTERN.test(id) && !id.includes('claude'));

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    fixture = await startRouteFixture({ deploymentMode: 'single-tenant', env: configuration.env });
  });

  afterAll(async () => {
    await applyDefaultPipeline(null);
    await fixture.close();
    vi.useRealTimers();
  });

  beforeEach(() => {
    h.capture.reset();
    h.exa.reset();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('configures one GPT model and one other model', () => {
    expect(gptModel).toBeTruthy();
    expect(otherModel).toBeTruthy();
  });

  it('builds the same system prompt or refusal for every fixture question and model kind', async () => {
    const { POST } = await fixture.loadRoute('chat');
    await applyDefaultPipeline(configuration.defaultPipeline);
    const hybridBefore = hybridCalls(fixture);
    const questions = readGoldenQuestions();
    const kinds: Array<{ kind: 'other' | 'gpt'; model: string }> = [
      { kind: 'other', model: otherModel as string },
      { kind: 'gpt', model: gptModel as string },
    ];
    const actual: Array<Record<string, unknown>> = [];
    for (const { kind, model } of kinds) {
      for (const { id, question } of questions) {
        h.capture.reset();
        const response = await POST(
          chatRequest({
            messages: [{ role: 'user', content: question }],
            data: { ragMode: 'strict', settings: { webSearch: false, model } },
          }),
        );
        const body = await response.text();
        if (h.capture.calls.length === 0) {
          const text = readSseText(body);
          expect(text, `chat route neither refused nor reached streamText for ${id} (${kind})`).not.toBe('');
          actual.push({ id, model_kind: kind, refused: true, text });
        } else {
          expect(h.capture.calls).toHaveLength(1);
          actual.push({ id, model_kind: kind, system: systemTextOf(h.capture.calls[0]) });
        }
      }
    }
    expect(actual).toHaveLength(questions.length * kinds.length);
    expect(hybridCalls(fixture) - hybridBefore).toBe(0);
    expectCharacterization('chat', actual);
  });

  it.runIf(configuration.defaultPipeline === 'v2')('languages unset under a defaulted v2 never calls hybrid_search_chunks', async () => {
    const { POST } = await fixture.loadRoute('chat');
    await applyDefaultPipeline(configuration.defaultPipeline);
    const before = hybridCalls(fixture);
    for (const { question } of readGoldenQuestions().slice(0, 5)) {
      h.capture.reset();
      const response = await POST(
        chatRequest({ messages: [{ role: 'user', content: question }], data: { ragMode: 'strict', settings: { webSearch: false } } }),
      );
      await response.text();
    }
    expect(hybridCalls(fixture) - before).toBe(0);
    expect(fixture.edge.calls.some((call) => /\/rest\/v1\/rpc\/match_document_chunks$/.test(call.path))).toBe(true);
  });
});
