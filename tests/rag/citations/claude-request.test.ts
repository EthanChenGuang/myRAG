import { describe, expect, it } from 'vitest';
import { buildAliasMap } from '@/lib/rag/generation/citations/blocks';
import {
  buildClaudeCitationRequest,
  claudeReasoningEligibility,
  createClaudeProvider,
  startClaudeCitationStream,
} from '@/lib/rag/generation/citations/claude';
import { DEFAULT_ANTHROPIC_BASE_URL } from '@/lib/rag/generation/config';
import type { ContextBlock } from '@/lib/rag';
import {
  FAKE_ANTHROPIC_BASE_URL,
  FAKE_ANTHROPIC_KEY,
  createFakeAnthropicFetch,
} from '../../helpers/fake-anthropic';

const TEXTS = [
  'Document: report.pdf. Chunk 1 of 3. Content: hello',
  'The blue lantern festival moved to May this year.',
  'Note: the ferry timetable changes in winter.',
];

function blocks(): ContextBlock[] {
  return TEXTS.map((text, index) => ({
    documentId: `doc-${index + 1}`,
    documentName: `doc-${index + 1}.pdf`,
    documentVersion: 1,
    chunkIds: [`chunk-${index + 1}`],
    page: index + 1,
    sectionPath: null,
    title: `Doc ${index + 1} · p.${index + 1}`,
    text,
    isImage: false,
    alias: `S${index + 1}`,
  }));
}

const HISTORY = [
  { role: 'user' as const, content: 'Earlier question' },
  { role: 'assistant' as const, content: 'Earlier answer' },
];

async function capture(options: { reasoning?: boolean; anthropicId?: string; baseUrl?: string } = {}) {
  const fake = createFakeAnthropicFetch({ sse: 'citations.sse' });
  const provider = createClaudeProvider({
    apiKey: FAKE_ANTHROPIC_KEY,
    baseUrl: options.baseUrl ?? FAKE_ANTHROPIC_BASE_URL,
    fetch: fake.fetch,
  });
  const stream = startClaudeCitationStream({
    provider,
    aliasMap: buildAliasMap(blocks()),
    system: 'You answer from the attached documents.',
    history: HISTORY,
    question: 'When is the festival?',
    anthropicId: options.anthropicId ?? 'claude-sonnet-5-5',
    reasoning: options.reasoning ?? false,
  });
  await stream.result.consumeStream();
  return fake.last();
}

type Block = Record<string, unknown>;

function lastUserContent(body: Record<string, unknown>): Block[] {
  const messages = body.messages as Array<{ role: string; content: Block[] }>;
  const last = messages[messages.length - 1];
  expect(last.role).toBe('user');
  return last.content;
}

describe('Claude citation request (D-09)', () => {
  it('sends one citation-enabled plain-text document per block, in alias order, before the question', async () => {
    const request = await capture();
    const content = lastUserContent(request.body);
    expect(content).toHaveLength(4);
    TEXTS.forEach((text, index) => {
      expect(content[index]).toMatchObject({
        type: 'document',
        source: { type: 'text', media_type: 'text/plain', data: text },
        title: `Doc ${index + 1} · p.${index + 1}`,
        citations: { enabled: true },
      });
    });
    expect(content[3]).toMatchObject({ type: 'text', text: 'When is the festival?' });
  });

  it('keeps chunk text that looks like a URL scheme as the exact text', async () => {
    const request = await capture();
    const first = lastUserContent(request.body)[0] as { source: { type: string; data: string } };
    expect(first.source.type).toBe('text');
    expect(first.source.data).toBe('Document: report.pdf. Chunk 1 of 3. Content: hello');
  });

  it('leaves earlier history turns without documents', async () => {
    const request = await capture();
    const messages = request.body.messages as Array<{ role: string; content: unknown }>;
    expect(messages).toHaveLength(3);
    for (const message of messages.slice(0, 2)) {
      expect(JSON.stringify(message.content)).not.toContain('"document"');
    }
  });

  it('carries no output, format or sampling field and posts to <baseURL>/messages with the key', async () => {
    const request = await capture();
    expect(request.url).toBe(`${FAKE_ANTHROPIC_BASE_URL}/messages`);
    expect(request.headers['x-api-key']).toBe(FAKE_ANTHROPIC_KEY);
    for (const field of ['output_config', 'output_format', 'temperature', 'top_p', 'top_k', 'thinking']) {
      expect(request.body).not.toHaveProperty(field);
    }
    expect(request.body.max_tokens).toBe(16384);
    expect(request.body.stream).toBe(true);
  });

  it('maps reasoning on an adaptive model to thinking {type: adaptive} without a budget or effort', async () => {
    const request = await capture({ reasoning: true, anthropicId: 'claude-opus-5-5' });
    expect(request.body.thinking).toEqual({ type: 'adaptive' });
    expect(JSON.stringify(request.body)).not.toContain('budget_tokens');
    expect(request.body).not.toHaveProperty('output_config');
  });

  it('decides reasoning eligibility from the adaptive-thinking model list (D-10)', () => {
    for (const id of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-sonnet-4-6', 'claude-opus-4-8']) {
      expect(claudeReasoningEligibility(id)).toEqual({ eligible: true });
    }
    for (const id of ['claude-sonnet-4-5', 'claude-opus-4-1-20250805', 'claude-haiku-4-5', 'gpt-5']) {
      expect(claudeReasoningEligibility(id)).toEqual({ eligible: false, reason: 'reasoning_unsupported' });
    }
  });

  it('builds the request with maxRetries 0 and an explicit base URL when the configured one is empty', async () => {
    const built = buildClaudeCitationRequest({
      provider: createClaudeProvider({ apiKey: FAKE_ANTHROPIC_KEY, baseUrl: '' }),
      aliasMap: buildAliasMap(blocks()),
      system: 'sys',
      history: [],
      question: 'q',
      anthropicId: 'claude-sonnet-5-5',
      reasoning: false,
    });
    expect(built.maxRetries).toBe(0);
    expect(built).not.toHaveProperty('temperature');
    const files = (built.messages[0].content as Array<{ type: string; data?: unknown }>).filter((part) => part.type === 'file');
    expect(files).toHaveLength(3);
    for (const file of files) expect(file.data).toBeInstanceOf(Uint8Array);

    const fake = createFakeAnthropicFetch({ sse: 'citations.sse' });
    const previous = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = '';
    try {
      const provider = createClaudeProvider({ apiKey: FAKE_ANTHROPIC_KEY, baseUrl: '  ', fetch: fake.fetch });
      const stream = startClaudeCitationStream({
        provider,
        aliasMap: buildAliasMap(blocks()),
        system: 'sys',
        history: [],
        question: 'q',
        anthropicId: 'claude-sonnet-5-5',
      });
      await stream.result.consumeStream();
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = previous;
    }
    expect(fake.last().url).toBe(`${DEFAULT_ANTHROPIC_BASE_URL}/messages`);
  });
});
