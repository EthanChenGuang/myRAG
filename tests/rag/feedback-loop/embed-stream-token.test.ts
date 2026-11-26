import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createUIMessageStreamResponse } from 'ai';
import type { TraceCollector } from '@/lib/rag';
import { verifyEmbedFeedbackToken } from '@/lib/rag/feedback-loop/embed-token';
import { TWO_TENANT_IDS } from '../../../eval/harness/two-tenant.mts';
import { startRouteFixture, type RouteFixture } from '../../helpers/route-fixture';

const SECRET = 'k'.repeat(40);
const { orgO } = TWO_TENANT_IDS;
const TENANT = `o:${orgO}`;

const h = await vi.hoisted(async () => {
  const fakes = await import('../../helpers/chat-route-fakes');
  return {
    capture: fakes.createStreamTextCapture(),
    responseOptions: [] as Array<Record<string, unknown> | undefined>,
    logMode: 'ids' as 'off' | 'ids' | 'masked_query',
    logModeCalls: [] as string[],
    finished: [] as TraceCollector[],
  };
});

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    streamText: async (params: Record<string, unknown>) => {
      const result = await h.capture.streamText(params);
      return {
        ...result,
        // The embed route builds its response from toUIMessageStream, the composition toUIMessageStreamResponse uses (04.2-10)
        toUIMessageStream: (options?: Record<string, unknown>) => {
          h.responseOptions.push(options);
          const stream = result.toUIMessageStream(options as never);
          (params.onFinish as ((event: { text: string }) => void) | undefined)?.({ text: 'ok' });
          return stream;
        },
      };
    },
  };
});
vi.mock('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: () => (modelId: string) => ({ specificationVersion: 'v3', provider: 'fake', modelId }),
}));
vi.mock('@/lib/rag/trace/schedule', () => ({ scheduleAfterResponse: () => undefined }));
vi.mock('@/lib/rag/trace/finish', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rag/trace/finish')>();
  return {
    ...actual,
    finishTrace: (...args: Parameters<typeof actual.finishTrace>) => {
      h.finished.push(args[0]);
      return actual.finishTrace(...args);
    },
  };
});
vi.mock('@/lib/rag/feedback-loop/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rag/feedback-loop/settings')>();
  return {
    ...actual,
    effectiveLogMode: async (tenantKey: string) => {
      h.logModeCalls.push(tenantKey);
      return h.logMode;
    },
  };
});

void createUIMessageStreamResponse;

const env = process.env as Record<string, string | undefined>;

function embedRequest(): NextRequest {
  return new NextRequest('http://localhost/api/embed/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.21' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Two tenant isolation canary phrase: organization shared handbook' }] }),
  });
}

function parts(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter((payload) => payload !== '' && payload !== '[DONE]')
    .map((payload) => JSON.parse(payload) as Record<string, unknown>);
}

describe('embed stream feedback token (D-11)', () => {
  let fixture: RouteFixture;

  beforeAll(async () => {
    fixture = await startRouteFixture({
      deploymentMode: 'multi-tenant',
      twoTenant: true,
      env: { RAG_EMBED_TENANT: TENANT, RAG_EMBED_FEEDBACK: undefined, RAG_EMBED_FEEDBACK_SECRET: undefined, RAG_RETRIEVAL_LOG: undefined },
    });
  });

  afterAll(async () => {
    await fixture.close();
  });

  beforeEach(() => {
    h.capture.reset();
    h.responseOptions.length = 0;
    h.logModeCalls.length = 0;
    h.finished.length = 0;
    h.logMode = 'ids';
    delete env.RAG_EMBED_FEEDBACK;
    delete env.RAG_EMBED_FEEDBACK_SECRET;
    delete env.RAG_RETRIEVAL_LOG;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  async function run(): Promise<string> {
    const { POST } = await fixture.loadRoute('embed/chat');
    const response = await POST(embedRequest());
    expect(response.status).toBe(200);
    return response.text();
  }

  it('defaults: the start part carries no metadata and no token is minted or looked up', async () => {
    const body = await run();
    expect(parts(body)[0]).toEqual({ type: 'start' });
    expect(body).not.toContain('feedbackToken');
    expect(body).not.toContain('messageMetadata');
    expect(h.responseOptions).toHaveLength(1);
    expect(h.responseOptions[0]).not.toHaveProperty('messageMetadata');
    expect(h.logModeCalls).toEqual([]);
  });

  it('enabled with a usable secret and logging on: the start metadata carries a token for this trace and tenant', async () => {
    env.RAG_EMBED_FEEDBACK = 'true';
    env.RAG_EMBED_FEEDBACK_SECRET = SECRET;
    env.RAG_RETRIEVAL_LOG = 'ids';
    const body = await run();
    const start = parts(body)[0] as { type: string; messageMetadata?: { feedbackToken?: string } };
    expect(start.type).toBe('start');
    const feedbackToken = start.messageMetadata?.feedbackToken;
    expect(typeof feedbackToken).toBe('string');
    expect(h.finished).toHaveLength(1);
    expect(verifyEmbedFeedbackToken(feedbackToken, { secret: SECRET })).toEqual({ traceId: h.finished[0].traceId, tenantKey: TENANT });
    expect(h.logModeCalls).toEqual([TENANT]);
    expect(parts(body).filter((part) => 'messageMetadata' in part)).toHaveLength(1);
  });

  it('no token when the secret is too short, the switch is off or the tenant log mode is off; bytes equal the default', async () => {
    const reference = await run();
    const variants: Array<() => void> = [
      () => {
        env.RAG_EMBED_FEEDBACK = 'true';
        env.RAG_EMBED_FEEDBACK_SECRET = 'short';
        env.RAG_RETRIEVAL_LOG = 'ids';
      },
      () => {
        env.RAG_EMBED_FEEDBACK = 'false';
        env.RAG_EMBED_FEEDBACK_SECRET = SECRET;
        env.RAG_RETRIEVAL_LOG = 'masked_query';
      },
      () => {
        env.RAG_EMBED_FEEDBACK = 'true';
        env.RAG_EMBED_FEEDBACK_SECRET = SECRET;
        env.RAG_RETRIEVAL_LOG = 'ids';
        h.logMode = 'off';
      },
    ];
    for (const apply of variants) {
      apply();
      h.capture.reset();
      expect(await run()).toBe(reference);
    }
  });
});
