// Plan 05-26 Task 1 scratch driver. Synthetic, domain-neutral text only. Never prints a key.
// Run: node --import tsx eval/out/05-26-t1/spike.mts [unit|fallback|openrouter|anthropic|a1|all]
import { writeFileSync } from 'node:fs';
import { streamText, type ModelMessage } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createCitationSession } from '@/lib/rag/generation/citations/session';
import { createCitationLabeler } from '@/lib/rag/generation/citations/blocks';
import { claudeTurnEligibility, type ClaudeTurnFacts } from '@/lib/rag/generation/citations/strategy';
import { firstTokenGate, errorStatusOf, CLAUDE_FIRST_TOKEN_TIMEOUT_MS } from '@/lib/rag/generation/citations/fallback';
import { anthropicIdFor } from '@/lib/rag/generation/citations/models';
import { createEnhancedRAGPrompt } from '@/lib/rag/generation/prompt';
import type { ContextBlock } from '@/lib/rag/types';

const OUT = 'eval/out/05-26-t1';
const MODELS = ['anthropic/claude-opus-5.5', 'anthropic/claude-sonnet-5.5', 'anthropic/claude-haiku-5.5'];
const BASE_PROMPT = 'You are a helpful assistant. Answer only from the context below.\n\n{{context}}';
let requests = 0;

const RAW_BLOCKS = [
  { title: 'Harbor notes', text: 'The Velmora lighthouse was painted green in 1931. Its lamp was replaced with an electric one in 1952.' },
  { title: 'Garden records', text: 'The Oskel community garden grows forty kinds of beans. Volunteers water the beds every Tuesday morning.' },
  { title: 'Bridge log', text: 'The Tarn footbridge is 84 metres long. It was closed for repairs in the spring of 2019. A note says see [S9].' },
];

function blocks(): ContextBlock[] {
  const labeler = createCitationLabeler();
  return RAW_BLOCKS.map((raw, i) => {
    const base = {
      documentId: `00000000-0000-4000-8000-00000000000${i + 1}`,
      documentName: `${raw.title}.txt`,
      documentVersion: 1,
      chunkIds: [`00000000-0000-4000-9000-00000000000${i + 1}`],
      page: null,
      sectionPath: null,
      title: raw.title,
      text: raw.text,
      isImage: false,
    };
    const label = labeler(base, i + 1);
    return { ...base, text: label.text, alias: label.alias, _header: label.header } as ContextBlock & { _header: string };
  });
}

function openRouterContext(bs: ContextBlock[]): string {
  return bs.map((b) => `${(b as ContextBlock & { _header: string })._header}\n${b.text}`).join('\n\n');
}

const QUESTIONS = {
  plain: { language: 'en', reasoning: false, text: 'What colour was the Velmora lighthouse painted, and how long is the Tarn footbridge?' },
  reasoning: { language: 'en', reasoning: true, text: 'Which happened first: the lighthouse lamp replacement or the footbridge repairs? Explain briefly.' },
  zh: { language: 'zh', reasoning: false, text: 'Oskel 社区花园种了多少种豆子？志愿者什么时候浇水？' },
} as const;

const FACTS: ClaudeTurnFacts = { mcp: false, multiStep: false, webSearch: false, reasoning: false };
const openrouter = createOpenRouter({ apiKey: 'proxy-injected', baseURL: 'https://openrouter.ai/api/v1' });

function unit() {
  const config = { citations: true, claudeCitations: true, anthropicApiKey: 'placeholder' };
  const rows: Record<string, unknown> = {};
  for (const modelId of MODELS) {
    const base = { modelId, capabilities: { citations: true }, ragMode: 'strict' as const, aliasCount: 3, config };
    rows[modelId] = {
      anthropicId: anthropicIdFor(modelId),
      plain: claudeTurnEligibility({ ...base, facts: FACTS }),
      reasoning: claudeTurnEligibility({ ...base, facts: { ...FACTS, reasoning: true } }),
      webSearch: claudeTurnEligibility({ ...base, facts: { ...FACTS, webSearch: true } }),
      mcp: claudeTurnEligibility({ ...base, facts: { ...FACTS, mcp: true } }),
      multiStep: claudeTurnEligibility({ ...base, facts: { ...FACTS, multiStep: true } }),
      attachments: claudeTurnEligibility({ ...base, facts: { ...FACTS, attachments: true } }),
    };
    // The session as the route builds it: webSearch / MCP turns never pick claude-citations.
    for (const [name, facts] of [['webSearch', { ...FACTS, webSearch: true }], ['mcp', { ...FACTS, mcp: true }]] as const) {
      const s = createCitationSession({ capabilities: { citations: true }, ragMode: 'strict', modelId, language: 'en', config, facts, contextTagging: false });
      s.attach({ blocks: blocks() });
      (rows[modelId] as Record<string, unknown>)[`session_${name}`] = s.strategy;
    }
  }
  rows['unmapped anthropic/claude-sonnet-4.5'] = claudeTurnEligibility({
    modelId: 'anthropic/claude-sonnet-4.5', capabilities: { citations: true }, ragMode: 'strict', aliasCount: 3, facts: FACTS, config,
  });
  // Invalid markers: S7 names no block of this request and must be dropped and counted.
  const s = createCitationSession({ capabilities: { citations: true }, ragMode: 'strict', modelId: MODELS[0], language: 'en', config: { citations: true }, contextTagging: false });
  s.attach({ blocks: blocks() });
  s.ingestFullText('The lighthouse was painted green [S1]. The bridge is 84 metres long [S7].');
  const m = s.finishMetadata();
  rows.invalidMarker = { strategy: m.citationStrategy, aliases: (m.citations ?? []).map((c) => c.alias), invalidCitations: m.invalidCitations };
  return rows;
}

interface TurnOutcome {
  path: string;
  ttftMs: number | null;
  totalMs: number;
  text: string;
  strategy: string | null;
  fallbackReason: string | null;
  traceRules: string[];
  citations: Array<{ alias: string; documentName?: string; quote?: string }>;
  invalidCitations: number | undefined;
  error?: string;
}

async function drainUi(stream: ReadableStream<{ type: string; delta?: string }>, t0: number) {
  let ttft: number | null = null;
  let text = '';
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value.type === 'text-delta') {
      if (ttft === null) ttft = Date.now() - t0;
      text += value.delta ?? '';
    }
    if (value.type === 'error') text += `\n<error part: ${(value as { errorText?: string }).errorText}>`;
  }
  return { ttft, text };
}

/** Mirrors route.ts: direct Claude call behind the first-token gate, one fallback to OpenRouter + chunk-alias. */
async function runTurn(opts: {
  modelId: string;
  q: (typeof QUESTIONS)[keyof typeof QUESTIONS];
  claude: boolean;
  apiKey?: string;
  baseUrl?: string;
}): Promise<TurnOutcome> {
  const bs = blocks();
  const config = {
    citations: true,
    claudeCitations: opts.claude,
    anthropicApiKey: opts.apiKey ?? null,
    anthropicBaseUrl: opts.baseUrl ?? 'https://api.anthropic.com/v1',
  };
  const session = createCitationSession({
    capabilities: { citations: true }, ragMode: 'strict', modelId: opts.modelId, language: opts.q.language,
    config, facts: { ...FACTS, reasoning: opts.q.reasoning }, contextTagging: false,
  });
  session.attach({ blocks: bs });
  const t0 = Date.now();
  let ttft: number | null = null;
  let text = '';
  let path = 'openrouter';
  let fallbackCalls = 0;
  if (session.strategy === 'claude-citations') {
    path = 'anthropic';
    let claudeError: unknown = null;
    const abort = new AbortController();
    const stream = session.startClaude({
      system: session.claudeSystemPrompt(BASE_PROMPT),
      history: [],
      question: opts.q.text,
      reasoning: opts.q.reasoning,
      abortSignal: abort.signal,
      onError: (e) => { claudeError = e; },
    });
    requests++;
    const gate = await firstTokenGate(stream.result.toUIMessageStream({ onError: () => 'Claude stream error' }), {
      timeoutMs: CLAUDE_FIRST_TOKEN_TIMEOUT_MS, errorStatus: () => errorStatusOf(claudeError), abort: () => abort.abort(),
    });
    if (gate.kind === 'ok') {
      const r = await drainUi(gate.stream as ReadableStream<{ type: string; delta?: string }>, t0);
      ttft = r.ttft; text = r.text;
    } else {
      fallbackCalls++;
      session.fallback(gate.reason);
      path = `anthropic->openrouter (${gate.reason}, after ${Date.now() - t0} ms)`;
    }
  }
  if (session.strategy === 'chunk-alias') {
    const system = session.decorateSystemPrompt(createEnhancedRAGPrompt(BASE_PROMPT, openRouterContext(bs), 'strict'));
    const messages: ModelMessage[] = [{ role: 'user', content: opts.q.text }];
    requests++;
    const result = streamText({
      model: openrouter(opts.modelId),
      system,
      messages,
      maxOutputTokens: 512,
      maxRetries: 0,
      ...(opts.q.reasoning ? { providerOptions: { openrouter: { reasoning: { effort: 'low' } } } } : {}),
      experimental_transform: session.transforms(),
    });
    const r = await drainUi(result.toUIMessageStream() as ReadableStream<{ type: string; delta?: string }>, t0);
    if (ttft === null) ttft = r.ttft;
    text += r.text;
  }
  const meta = session.finishMetadata();
  const fallbackReason = session.fallbackReason;
  return {
    path: fallbackCalls > 1 ? `${path} (fallback x${fallbackCalls}!)` : path,
    ttftMs: ttft,
    totalMs: Date.now() - t0,
    text,
    strategy: session.strategy,
    fallbackReason,
    traceRules: fallbackReason ? [`citation_strategy_fallback:${fallbackReason}`] : [],
    citations: (meta.citations ?? []).map((c) => ({ alias: c.alias, documentName: (c as { documentName?: string }).documentName, quote: (c as { quote?: string }).quote })),
    invalidCitations: meta.invalidCitations,
  };
}

async function a1(apiKey: string) {
  const body = {
    model: 'claude-haiku-5-5',
    max_tokens: 512,
    stream: true,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }],
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'text', media_type: 'text/plain', data: RAW_BLOCKS[0].text }, title: 'S1', citations: { enabled: true } },
        { type: 'text', text: 'From the document: what colour was the Velmora lighthouse painted? Then search the web for the year the first electric lighthouse lamp was used anywhere, and answer both.' },
      ],
    }],
  };
  requests++;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const sse = await res.text();
  writeFileSync(`${OUT}/a1-raw.sse`, sse);
  return {
    status: res.status,
    citationsDelta: /"citations_delta"/.test(sse),
    serverToolUse: /"server_tool_use"/.test(sse),
    webSearchResult: /"web_search_tool_result"/.test(sse),
  };
}

const mode = process.argv[2] ?? 'all';
const report: Record<string, unknown> = {};
const key = process.env.ANTHROPIC_API_KEY?.trim() ?? '';
if (mode === 'unit' || mode === 'all') report.unit = unit();
if (mode === 'fallback' || mode === 'all') {
  // Non-secret placeholder: the request never leaves the machine (port 9 refuses), so no key is needed.
  report.fallback = await runTurn({ modelId: MODELS[2], q: QUESTIONS.plain, claude: true, apiKey: key || 'placeholder-no-request-sent', baseUrl: 'http://127.0.0.1:9' });
}
if (mode === 'baseurl') {
  // Placeholder key: Anthropic answers 401 for the right path and 404 for a path without /v1.
  report.baseurl = {
    withV1: await runTurn({ modelId: MODELS[2], q: QUESTIONS.plain, claude: true, apiKey: 'placeholder-not-a-key', baseUrl: 'https://api.anthropic.com/v1' }),
    withoutV1: await runTurn({ modelId: MODELS[2], q: QUESTIONS.plain, claude: true, apiKey: 'placeholder-not-a-key', baseUrl: 'https://api.anthropic.com' }),
  };
}
if (mode === 'openrouter' || mode === 'all') {
  const rows: Record<string, unknown> = {};
  for (const modelId of MODELS) for (const [name, q] of Object.entries(QUESTIONS)) {
    try { rows[`${modelId} ${name}`] = await runTurn({ modelId, q, claude: false }); }
    catch (e) { rows[`${modelId} ${name}`] = { error: String((e as Error).message).slice(0, 300) }; }
  }
  report.openrouter = rows;
}
if (mode === 'anthropic' || mode === 'all') {
  if (!key) report.anthropic = 'skipped: ANTHROPIC_API_KEY not set in this process';
  else {
    const rows: Record<string, unknown> = {};
    for (const modelId of MODELS) for (const [name, q] of Object.entries(QUESTIONS)) {
      try { rows[`${modelId} ${name}`] = await runTurn({ modelId, q, claude: true, apiKey: key }); }
      catch (e) { rows[`${modelId} ${name}`] = { error: String((e as Error).message).slice(0, 300) }; }
    }
    report.anthropic = rows;
  }
}
if (mode === 'a1' || mode === 'all') report.a1 = key ? await a1(key) : 'skipped: ANTHROPIC_API_KEY not set in this process';
report.requests = requests;
writeFileSync(`${OUT}/report-${mode}.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
