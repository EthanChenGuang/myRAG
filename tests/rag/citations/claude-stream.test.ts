import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { jsonSchema, tool, type TextStreamPart, type ToolSet } from 'ai';
import { buildAliasMap } from '@/lib/rag/generation/citations/blocks';
import { createClaudeProvider, startClaudeCitationStream } from '@/lib/rag/generation/citations/claude';
import { claudeMarkerTransform, type ClaudeCitation } from '@/lib/rag/generation/citations/claude-transform';
import type { ContextBlock } from '@/lib/rag';
import {
  FAKE_ANTHROPIC_BASE_URL,
  FAKE_ANTHROPIC_KEY,
  createFakeAnthropicFetch,
  type FakeAnthropicResponse,
} from '../../helpers/fake-anthropic';

const CITED = 'The blue lantern festival moved to May this year.';

function blocks(): ContextBlock[] {
  const texts = ['Ferries run hourly in summer.', CITED, 'Tickets for the festival stay free.'];
  return texts.map((text, index) => ({
    documentId: `doc-${index + 1}`,
    documentName: `doc-${index + 1}.pdf`,
    documentVersion: 1,
    chunkIds: [`chunk-${index + 1}`],
    page: null,
    sectionPath: null,
    title: `Doc ${index + 1}`,
    text,
    isImage: false,
    alias: `S${index + 1}`,
  }));
}

async function run(response: FakeAnthropicResponse, options: { tools?: ToolSet; anthropicId?: string } = {}) {
  const fake = createFakeAnthropicFetch(response);
  const stream = startClaudeCitationStream({
    provider: createClaudeProvider({ apiKey: FAKE_ANTHROPIC_KEY, baseUrl: FAKE_ANTHROPIC_BASE_URL, fetch: fake.fetch }),
    aliasMap: buildAliasMap(blocks()),
    system: 'sys',
    history: [],
    question: 'When is the festival?',
    anthropicId: options.anthropicId ?? 'claude-sonnet-5-5',
    ...(options.tools ? { tools: options.tools } : {}),
  });
  const parts: TextStreamPart<ToolSet>[] = [];
  for await (const part of stream.result.fullStream) parts.push(part);
  const text = parts
    .filter((part): part is Extract<TextStreamPart<ToolSet>, { type: 'text-delta' }> => part.type === 'text-delta')
    .map((part) => part.text)
    .join('');
  return { parts, text, citations: stream.citations() };
}

function sse(events: Array<Record<string, unknown>>): string {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

const START = { type: 'message_start', message: { id: 'msg_inline', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } };
const END = [
  { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
  { type: 'message_stop' },
];

function textBlock(index: number, text: string, cites: Array<{ doc: number; cited: string }>) {
  return [
    { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index, delta: { type: 'text_delta', text } },
    ...cites.map((cite) => ({
      type: 'content_block_delta',
      index,
      delta: {
        type: 'citations_delta',
        citation: { type: 'char_location', cited_text: cite.cited, document_index: cite.doc, document_title: null, start_char_index: 0, end_char_index: cite.cited.length },
      },
    })),
    { type: 'content_block_stop', index },
  ];
}

describe('Claude citations stream (D-01, D-09)', () => {
  it('injects the marker before the cited block ends, swallows the source part and records the cited text', async () => {
    const { parts, text, citations } = await run({ sse: 'citations.sse' });
    expect(text).toBe('According to the attached notes, the blue lantern festival moved to May.[S2]');
    expect(parts.some((part) => part.type === 'source')).toBe(false);

    const markerIndex = parts.findIndex((part) => part.type === 'text-delta' && part.text === '[S2]');
    const marker = parts[markerIndex] as { id: string };
    const endIndex = parts.findIndex((part) => part.type === 'text-end' && part.id === marker.id);
    expect(markerIndex).toBeGreaterThan(-1);
    expect(endIndex).toBe(markerIndex + 1);
    const firstEnd = parts.findIndex((part) => part.type === 'text-end');
    expect(firstEnd).toBeLessThan(markerIndex);

    expect(citations.invalidCitations).toBe(0);
    expect(citations.citations).toHaveLength(1);
    expect(citations.citations[0]).toMatchObject({
      n: 1,
      alias: 'S2',
      strategy: 'claude-citations',
      documentId: 'doc-2',
      chunkIds: ['chunk-2'],
      quote: CITED,
      quoteHash: createHash('sha256').update(CITED).digest('hex'),
    });
  });

  it('marks two documents cited in one block once each and numbers repeated aliases by first appearance', async () => {
    const { text, citations } = await run({
      sse: sse([
        START,
        ...textBlock(0, 'Ferries and tickets.', [
          { doc: 2, cited: 'Tickets for the festival stay free.' },
          { doc: 0, cited: 'Ferries run hourly in summer.' },
          { doc: 2, cited: 'Tickets for the festival' },
        ]),
        ...textBlock(1, ' Again ferries.', [{ doc: 0, cited: 'Ferries run hourly' }]),
        ...END,
      ]),
    });
    expect(text).toBe('Ferries and tickets.[S3][S1] Again ferries.[S1]');
    expect(citations.citations.map((record) => [record.n, record.alias, record.quote])).toEqual([
      [1, 'S3', 'Tickets for the festival stay free.'],
      [2, 'S1', 'Ferries run hourly in summer.'],
    ]);
  });

  it('drops a source whose filename is not in the alias map and counts it invalid', async () => {
    const cited: ClaudeCitation[] = [];
    let invalid = 0;
    const transform = claudeMarkerTransform(buildAliasMap(blocks()), {
      cite: (citation) => cited.push(citation),
      invalid: () => {
        invalid++;
      },
    })({ tools: {}, stopStream: () => {} });
    const input: TextStreamPart<ToolSet>[] = [
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', text: 'Hello.' },
      { type: 'source', sourceType: 'document', id: 'src1', mediaType: 'text/plain', title: 'x', filename: 'S9', providerMetadata: { anthropic: { citedText: 'forged' } } },
      { type: 'source', sourceType: 'document', id: 'src2', mediaType: 'text/plain', title: 'y', providerMetadata: { anthropic: { citedText: 'no name' } } },
      { type: 'source', sourceType: 'document', id: 'src3', mediaType: 'text/plain', title: 'Doc 1', filename: 'S1', providerMetadata: { anthropic: { citedText: 'Ferries', startCharIndex: 0, endCharIndex: 7 } } },
      { type: 'text-end', id: 't1' },
    ];
    const output: TextStreamPart<ToolSet>[] = [];
    const readable = new ReadableStream<TextStreamPart<ToolSet>>({
      start(controller) {
        for (const part of input) controller.enqueue(part);
        controller.close();
      },
    }).pipeThrough(transform);
    for await (const part of readable as unknown as AsyncIterable<TextStreamPart<ToolSet>>) output.push(part);

    expect(invalid).toBe(2);
    expect(cited).toEqual([{ alias: 'S1', citedText: 'Ferries', startCharIndex: 0, endCharIndex: 7 }]);
    expect(output.map((part) => part.type)).toEqual(['text-start', 'text-delta', 'text-delta', 'text-end']);
    expect(output[2]).toEqual({ type: 'text-delta', id: 't1', text: '[S1]' });
  });

  it('handles a thinking block before cited text and forwards the reasoning parts', async () => {
    const { parts, text, citations } = await run({ sse: 'thinking-citations.sse' }, { anthropicId: 'claude-opus-5-5' });
    expect(text).toBe('According to the attached notes, the blue lantern festival moved to May.[S2]');
    expect(parts.some((part) => part.type === 'reasoning-delta')).toBe(true);
    expect(citations.citations.map((record) => [record.alias, record.quote])).toEqual([['S2', CITED]]);
  });

  it('surfaces a webSearch tool call unchanged next to the cited text', async () => {
    const webSearch = tool({
      description: 'Search the web',
      inputSchema: jsonSchema<{ query: string }>({ type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }),
    });
    const { parts, text, citations } = await run({ sse: 'websearch-tool.sse' }, { tools: { webSearch } });
    expect(text).toBe('The festival moved to May.[S2]');
    const call = parts.find((part) => part.type === 'tool-call');
    expect(call).toMatchObject({ type: 'tool-call', toolCallId: 'toolu_fixture_01', toolName: 'webSearch', input: { query: 'lantern festival tickets' } });
    expect(parts.find((part) => part.type === 'finish')).toMatchObject({ finishReason: 'tool-calls' });
    expect(citations.citations.map((record) => record.alias)).toEqual(['S2']);
  });

  it('yields an error part before any text when the stream fails before the first token', async () => {
    const { parts, text, citations } = await run({ sse: 'error-before-first-token.sse' });
    const errorIndex = parts.findIndex((part) => part.type === 'error');
    expect(errorIndex).toBeGreaterThan(-1);
    expect(parts.slice(0, errorIndex).some((part) => part.type === 'text-delta')).toBe(false);
    expect(text).toBe('');
    expect(citations.citations).toEqual([]);
  });

  it('yields an error part before any text on HTTP 429', async () => {
    const { parts, text } = await run({ status: 429, body: { type: 'error', error: { type: 'rate_limit_error', message: 'Rate limited' } } });
    const errorIndex = parts.findIndex((part) => part.type === 'error');
    expect(errorIndex).toBeGreaterThan(-1);
    expect(parts.slice(0, errorIndex).some((part) => part.type === 'text-delta')).toBe(false);
    expect(text).toBe('');
  });

  it('ends a refusal with no text and a content-filter finish reason', async () => {
    const { parts, text, citations } = await run({ sse: 'refusal-before-first-token.sse' });
    expect(text).toBe('');
    expect(parts.find((part) => part.type === 'finish')).toMatchObject({ finishReason: 'content-filter' });
    expect(citations.citations).toEqual([]);
  });
});
