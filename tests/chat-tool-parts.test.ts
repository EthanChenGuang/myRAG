import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chatRequest, installChatPipeline, readSse, retrievalWith } from './helpers/chat-route-fakes';

const IMAGE_URL = 'https://example.com/fixtures/diagram.png';

const h = await vi.hoisted(async () => {
  const fakes = await import('./helpers/chat-route-fakes');
  return fakes.createChatRouteHarness();
});

// Plan 05.2.1-02 adds calcTool to the answer-config reader; until it lands it is read here from the same env name.
vi.mock('@/lib/rag/generation/answer-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rag/generation/answer-config')>();
  return {
    ...actual,
    readAnswerConfig: (source: Record<string, string | undefined> = process.env) => ({
      ...actual.readAnswerConfig(source),
      calcTool: source.RAG_CALC_TOOL === 'true',
    }),
  };
});

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  streamText: h.capture.streamText,
}));
vi.mock('@/lib/document-processor', () => ({ getQueryEmbedding: vi.fn(async () => []) }));
vi.mock('@/lib/supabase', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/supabase')>()),
  getSupabaseAdmin: () => h.supabase.client,
  searchSimilarChunks: vi.fn(async () => []),
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.ssr }));
vi.mock('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: () => (modelId: string) => ({ specificationVersion: 'v3', provider: 'fake', modelId }),
}));
vi.mock('exa-js', () => ({ default: h.exa.Exa }));

type StepPart = Record<string, any>;
type ApprovalEntry = { approved: boolean; toolCall: { name: string; params: unknown } };

const globals = globalThis as unknown as {
  toolApprovalState: Record<string, ApprovalEntry>;
  lastReasoningDetails?: Record<string, unknown>;
};

async function loadRoute() {
  vi.resetModules();
  await installChatPipeline(h);
  return import('@/app/api/chat/route');
}

function seedImageDocument() {
  h.supabase.store.documents = [
    { id: 'doc-image-1', filename: 'diagram.png', created_at: '2026-01-01T00:00:00.000Z', content: 'A fixture diagram', metadata: {} },
  ];
  h.supabase.store.document_chunks = [
    { id: 'chunk-image-1', document_id: 'doc-image-1', metadata: { image_url: IMAGE_URL } },
  ];
  h.retrieval.mockResolvedValue(
    retrievalWith([
      {
        chunk_id: 'chunk-image-1',
        document_id: 'doc-image-1',
        content: 'Diagram of the architecture',
        similarity: 0.3,
        metadata: { image_url: IMAGE_URL },
        temporal_score: 0,
        financial_score: 0,
        final_score: 0.3,
        match_reason: 'similarity',
      },
    ]),
  );
}

async function postQuery() {
  const { POST } = await loadRoute();
  return POST(
    chatRequest({
      messages: [{ role: 'user', content: 'zzzz' }],
      data: { ragMode: 'strict', settings: { webSearch: false } },
    }),
  );
}

async function stepParams() {
  const response = await postQuery();
  const body = await readSse(response);
  return { params: h.capture.calls[0], body };
}

function finishChunk(body: string): { messageMetadata: Record<string, any> } {
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload.startsWith('{')) continue;
    const chunk = JSON.parse(payload) as { type?: string; messageMetadata?: Record<string, any> };
    if (chunk.type === 'finish') return { messageMetadata: chunk.messageMetadata ?? {} };
  }
  throw new Error('no finish chunk in the stream');
}

function toolCall(toolCallId: string, toolName: string, input: unknown): StepPart {
  return { type: 'tool-call', toolCallId, toolName, input };
}

describe('chat route AI SDK v6 tool parts', () => {
  const createdCallIds: string[] = [];

  beforeEach(() => {
    h.capture.reset();
    h.retrieval.mockReset();
    h.supabase.store.documents = [];
    h.supabase.store.document_chunks = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    seedImageDocument();
  });

  afterEach(() => {
    for (const id of createdCallIds) delete globals.toolApprovalState?.[id];
    createdCallIds.length = 0;
    delete globals.lastReasoningDetails;
    vi.useRealTimers();
  });

  it('stores the streamed tool-call input as the approval-state params', async () => {
    const { params } = await stepParams();
    createdCallIds.push('call-input-1');

    await params.onStepFinish({
      text: '',
      toolCalls: [toolCall('call-input-1', 'calendar_create_event', { title: 'Planning', day: 'monday' })],
      toolResults: [],
    });

    const entry = globals.toolApprovalState['call-input-1'];
    expect(entry.toolCall.name).toBe('calendar_create_event');
    expect(JSON.stringify(entry.toolCall.params ?? null)).toBe('{"title":"Planning","day":"monday"}');
    expect(entry.approved).toBe(false);
  });

  it('keeps a draft call as a draft when its instructions show send intent', async () => {
    const { params } = await stepParams();
    createdCallIds.push('call-redirect-1');
    const calls = [toolCall('call-redirect-1', 'gmail_create_draft', { instructions: 'send it now' })];

    await params.onStepFinish({ text: '', toolCalls: calls, toolResults: [] });

    expect(globals.toolApprovalState['call-redirect-1'].toolCall.name).toBe('gmail_create_draft');
    expect(calls[0].toolName).toBe('gmail_create_draft');
  });

  it('keeps tool-call arguments out of the logs', async () => {
    const { params } = await stepParams();
    createdCallIds.push('call-log-1');
    const secretText = 'private-instruction-text-for-log-check';

    await params.onStepFinish({
      text: '',
      toolCalls: [toolCall('call-log-1', 'gmail_create_draft', { instructions: `send an email now ${secretText}` })],
      toolResults: [],
    });

    const logged = vi.mocked(console.log).mock.calls.map((args) => JSON.stringify(args)).join('\n');
    expect(logged).not.toContain(secretText);
  });

  it('clears the tool-result output of approval-gated tools and keeps allowed tools', async () => {
    const { params } = await stepParams();
    createdCallIds.push('call-gated-1', 'call-search-1');

    const gated: StepPart = { type: 'tool-result', toolCallId: 'call-gated-1', toolName: 'drive_list_files', output: { files: ['a'] } };
    const search: StepPart = { type: 'tool-result', toolCallId: 'call-search-1', toolName: 'webSearch', output: { results: [{ title: 'x' }] } };
    await params.onStepFinish({
      text: '',
      toolCalls: [toolCall('call-gated-1', 'drive_list_files', {}), toolCall('call-search-1', 'webSearch', { query: 'x' })],
      toolResults: [gated, search],
    });

    expect(gated.output).toBeNull();
    expect(search.output).toEqual({ results: [{ title: 'x' }] });
    expect(globals.toolApprovalState['call-gated-1']).toBeDefined();
    expect(globals.toolApprovalState['call-search-1']).toBeUndefined();
  });

  it('reports the document sources in the synthetic query_documents result output', async () => {
    const { params } = await stepParams();
    const toolResults: StepPart[] = [];

    await params.onStepFinish({ text: '', toolCalls: [], toolResults });

    const documentSources = toolResults.find((part) => part.toolName === 'query_documents');
    expect(documentSources?.output?.images).toEqual([{ name: 'diagram.png', size: 0, type: 'image/jpeg', url: IMAGE_URL }]);
    expect(documentSources?.output?.documents?.[0]).toMatchObject({ id: 'doc-image-1', name: 'diagram.png' });
  });

  it('sends reasoning from provider metadata through the finish messageMetadata, never through a global', async () => {
    h.capture.setFinishStepProviderMetadata({ openrouter: { reasoning_content: 'step one then step two', reasoning_tokens: 12 } });
    const { body } = await stepParams();

    const finish = finishChunk(body);
    expect(finish.messageMetadata.reasoningText).toMatchObject({ content: 'step one then step two', token_count: 12 });
    expect(globals.lastReasoningDetails).toBeUndefined();
  });

  it('sends no reasoning when provider metadata carries none', async () => {
    h.capture.setFinishStepProviderMetadata({ openrouter: { usage: 1 } });
    const { body } = await stepParams();

    expect(JSON.stringify(finishChunk(body))).not.toContain('reasoningText');
    expect(globals.lastReasoningDetails).toBeUndefined();
  });

  it('sends the Claude Sonnet 4 document sources through the finish messageMetadata', async () => {
    const { POST } = await loadRoute();
    const body = await readSse(
      await POST(
        chatRequest({
          messages: [{ role: 'user', content: 'zzzz' }],
          data: { ragMode: 'strict', settings: { webSearch: false, model: 'anthropic/claude-sonnet-4.5' } },
        }),
      ),
    );

    const finish = finishChunk(body);
    expect(finish.messageMetadata.documentSources).toEqual([expect.objectContaining({ id: 'doc-image-1' })]);
  });

  it('writes the source_images and usedDocuments chunks to the wire unchanged', async () => {
    const { body } = await stepParams();

    expect(body).toContain(`"type":"source_images","source_images":[{"name":"diagram.png","size":0,"type":"image/jpeg","url":"${IMAGE_URL}"}]`);
    expect(body).toContain('"type":"metadata","usedDocuments":[{"type":"document","id":"doc-image-1","name":"diagram.png","filename":"diagram.png"');
    expect(body.indexOf('"type":"source_images"')).toBeLessThan(body.indexOf('"type":"metadata"'));
    expect(body.indexOf('"type":"metadata"')).toBeLessThan(body.indexOf('"delta":"ok"'));
  });
});

describe('chat route server-executed calculate tool (05.2.1-14)', () => {
  const createdCallIds: string[] = [];
  const QUESTION = 'What is 3 times 4 for item one?';

  function seedTextDocument() {
    h.supabase.store.documents = [
      { id: 'doc-calc-1', filename: 'values.txt', created_at: '2026-01-01T00:00:00.000Z', content: 'Item one has value 12 units.', metadata: {} },
    ];
    h.supabase.store.document_chunks = [{ id: 'chunk-calc-1', document_id: 'doc-calc-1', content: 'Item one has value 12 units.', metadata: {} }];
    h.retrieval.mockResolvedValue(
      retrievalWith([
        {
          chunk_id: 'chunk-calc-1',
          document_id: 'doc-calc-1',
          content: 'Item one has value 12 units.',
          similarity: 0.9,
          metadata: {},
          temporal_score: 0,
          financial_score: 0,
          final_score: 0.9,
          match_reason: 'similarity',
        },
      ]),
    );
  }

  async function calcStepParams() {
    const { POST } = await loadRoute();
    await readSse(
      await POST(
        chatRequest({
          messages: [{ role: 'user', content: QUESTION }],
          data: { ragMode: 'strict', settings: { webSearch: false, model: 'openai/gpt-4.1' } },
        }),
      ),
    );
    return h.capture.calls[0];
  }

  beforeEach(() => {
    h.capture.reset();
    h.retrieval.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    seedTextDocument();
  });

  afterEach(() => {
    for (const id of createdCallIds) delete globals.toolApprovalState?.[id];
    createdCallIds.length = 0;
    delete process.env.RAG_CALC_TOOL;
    delete process.env.RAG_TOOL_RESULT_GUARD;
    vi.restoreAllMocks();
  });

  it('runs our calculate call without an approval entry and keeps its result', async () => {
    process.env.RAG_CALC_TOOL = 'true';
    const params = await calcStepParams();
    expect(Object.keys(params.tools)).toContain('calculate');
    createdCallIds.push('call-calc-1', 'call-search-2');

    const output = { status: 'ok', result: '12' };
    const calc: StepPart = { type: 'tool-result', toolCallId: 'call-calc-1', toolName: 'calculate', output };
    const search: StepPart = { type: 'tool-result', toolCallId: 'call-search-2', toolName: 'webSearch', output: { results: [] } };
    await params.onStepFinish({
      text: '',
      toolCalls: [toolCall('call-calc-1', 'calculate', { operands: [], steps: [], result: 's1' }), toolCall('call-search-2', 'webSearch', { query: 'x' })],
      toolResults: [calc, search],
    });

    expect(calc.output).toBe(output);
    expect(search.output).toEqual({ results: [] });
    expect(globals.toolApprovalState['call-calc-1']).toBeUndefined();
    expect(globals.toolApprovalState['call-search-2']).toBeUndefined();
  });

  it('sends a tool that only shares the name to approval and clears its output', async () => {
    const params = await calcStepParams();
    expect(Object.keys(params.tools)).not.toContain('calculate');
    createdCallIds.push('call-calc-2');

    const calc: StepPart = { type: 'tool-result', toolCallId: 'call-calc-2', toolName: 'calculate', output: { status: 'ok' } };
    await params.onStepFinish({ text: '', toolCalls: [toolCall('call-calc-2', 'calculate', {})], toolResults: [calc] });

    expect(calc.output).toBeNull();
    expect(globals.toolApprovalState['call-calc-2']).toBeDefined();
    expect(globals.toolApprovalState['call-calc-2'].approved).toBe(false);
  });

  it('keeps calculate out of the tool-result guard and the tool-result notice', async () => {
    process.env.RAG_CALC_TOOL = 'true';
    process.env.RAG_TOOL_RESULT_GUARD = 'tag';
    const params = await calcStepParams();
    const { isServerCalculateTool } = await import('@/lib/rag/generation/calc-tool');
    const { TOOL_RESULT_SENTENCE } = await import('@/lib/rag');

    expect(isServerCalculateTool(params.tools.calculate)).toBe(true);
    expect(JSON.stringify(params.messages)).not.toContain(TOOL_RESULT_SENTENCE);
  });
});

describe('documentSources text', () => {
  it('carries the first 200 characters of matched_chunk followed by an ellipsis', async () => {
    const { buildDocumentSources } = await import('@/lib/ui-stream-chunks');
    const matched = 'x'.repeat(300);

    const [source] = buildDocumentSources([{ id: 'd1', name: 'Doc', filename: 'doc.txt', similarity: 0.9, matched_chunk: matched }]);

    expect(source.chunk_text).toBe(`${'x'.repeat(200)}...`);
  });

  it('never emits the literal string undefined when no chunk text exists', async () => {
    const { buildDocumentSources } = await import('@/lib/ui-stream-chunks');

    const [source] = buildDocumentSources([{ id: 'd1', name: 'Doc', filename: 'doc.txt' }]);

    expect(JSON.stringify(source)).not.toContain('undefined');
  });
});
