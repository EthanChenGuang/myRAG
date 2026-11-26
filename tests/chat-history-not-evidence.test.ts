import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  appendHistoryNotEvidence,
  HISTORY_NOT_EVIDENCE_INSTRUCTION,
  historyNotEvidenceEnabled,
} from '@/lib/chat/history-not-evidence';
import { chatRequest, installChatPipeline, readSse, retrievalWith } from './helpers/chat-route-fakes';

const h = await vi.hoisted(async () => {
  const fakes = await import('./helpers/chat-route-fakes');
  return fakes.createChatRouteHarness();
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
vi.mock('@supabase/supabase-js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@supabase/supabase-js')>()),
  createClient: () => h.supabase.client,
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.ssr }));
vi.mock('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: () => (modelId: string) => ({ specificationVersion: 'v3', provider: 'fake', modelId }),
}));
vi.mock('exa-js', () => ({ default: h.exa.Exa }));

const SWITCH = 'RAG_HISTORY_NOT_EVIDENCE';
const PROCESS_ENV: Record<string, string> = {
  NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE: 'single-tenant',
  NEXT_PUBLIC_EMBED_ENABLED: 'true',
  NEXT_PUBLIC_EMBED_ALLOWED_DOMAINS: '*',
  EMBED_RATE_LIMIT: '100000',
};
const env = process.env as Record<string, string | undefined>;
const saved: Record<string, string | undefined> = {};

const HISTORY = [
  { role: 'user', content: 'What is the refund window?' },
  { role: 'assistant', content: 'The refund window is 90 days.' },
  { role: 'user', content: 'And for annual plans, what is the refund window?' },
];

function row(id: string) {
  return {
    chunk_id: `chunk-${id}`,
    document_id: `doc-${id}`,
    content: `Chunk 1 of 1 about the refund window ${id}`,
    similarity: 0.9,
    metadata: null,
    temporal_score: 0,
    financial_score: 0,
    final_score: 0.9,
    match_reason: 'similarity',
  };
}

function seedDocuments() {
  h.supabase.store.documents = [
    { id: 'doc-1', filename: 'refund-window.md', created_at: '2026-01-01T00:00:00.000Z', content: 'refund window', metadata: {} },
  ];
  h.supabase.store.document_chunks = [{ id: 'chunk-1', document_id: 'doc-1', metadata: null }];
}

function setSwitch(value: string | undefined) {
  if (value === undefined) delete env[SWITCH];
  else env[SWITCH] = value;
}

async function loadChat(value: string | undefined) {
  setSwitch(value);
  vi.resetModules();
  await installChatPipeline(h);
  return import('@/app/api/chat/route');
}

async function loadEmbed(value: string | undefined) {
  setSwitch(value);
  vi.resetModules();
  await installChatPipeline(h);
  return import('@/app/api/embed/chat/route');
}

type Messages = Array<{ role: string; content: unknown }>;

async function chatMessages(value: string | undefined, data: Record<string, unknown> = {}): Promise<Messages> {
  h.capture.reset();
  const route = await loadChat(value);
  await readSse(
    await route.POST(chatRequest({ messages: HISTORY, data: { ragMode: 'strict', settings: { webSearch: false }, ...data } })),
  );
  expect(h.capture.streamText).toHaveBeenCalledTimes(1);
  return h.capture.calls[0].messages as Messages;
}

async function embedMessages(value: string | undefined): Promise<Messages> {
  h.capture.reset();
  const route = await loadEmbed(value);
  const response = await route.POST(
    new NextRequest('http://localhost/api/embed/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.21' },
      body: JSON.stringify({ messages: HISTORY }),
    }),
  );
  await response.text();
  expect(h.capture.streamText).toHaveBeenCalledTimes(1);
  return h.capture.calls[0].messages as Messages;
}

function occurrences(messages: Messages): number {
  return JSON.stringify(messages).split(JSON.stringify(HISTORY_NOT_EVIDENCE_INSTRUCTION).slice(1, -1)).length - 1;
}

function withoutInstruction(messages: Messages): Messages {
  return messages.map((message) =>
    typeof message.content === 'string'
      ? { ...message, content: message.content.replace(`\n\n${HISTORY_NOT_EVIDENCE_INSTRUCTION}`, '') }
      : message,
  );
}

describe('history-not-evidence helper', () => {
  it('is on only for true', () => {
    expect(historyNotEvidenceEnabled(undefined)).toBe(false);
    expect(historyNotEvidenceEnabled('')).toBe(false);
    expect(historyNotEvidenceEnabled('false')).toBe(false);
    expect(historyNotEvidenceEnabled('1')).toBe(false);
    expect(historyNotEvidenceEnabled('true')).toBe(true);
    expect(historyNotEvidenceEnabled(' TRUE ')).toBe(true);
  });

  it('off returns the same prompt; on appends the instruction once', () => {
    const prompt = 'Base prompt\n\nContext: x';
    expect(appendHistoryNotEvidence(prompt, false)).toBe(prompt);
    const once = appendHistoryNotEvidence(prompt, true);
    expect(once).toBe(`${prompt}\n\n${HISTORY_NOT_EVIDENCE_INSTRUCTION}`);
    expect(appendHistoryNotEvidence(once, true)).toBe(once);
  });

  it('carries no context placeholder and no language or domain literal', () => {
    expect(HISTORY_NOT_EVIDENCE_INSTRUCTION).not.toContain('{{context}}');
    expect(HISTORY_NOT_EVIDENCE_INSTRUCTION).not.toMatch(/myrag|refund|medical|legal|financ/i);
  });
});

describe('RAG_HISTORY_NOT_EVIDENCE in the chat and embed routes', () => {
  beforeAll(() => {
    for (const [name, value] of Object.entries({ ...PROCESS_ENV, [SWITCH]: undefined })) {
      saved[name] = env[name];
      if (value === undefined) delete env[name];
      else env[name] = value;
    }
  });

  afterAll(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete env[name];
      else env[name] = value;
    }
  });

  beforeEach(() => {
    h.capture.reset();
    h.retrieval.mockReset();
    h.retrieval.mockResolvedValue(retrievalWith([row('1')]));
    h.supabase.store.reset();
    seedDocuments();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => setSwitch(undefined));

  it('chat: unset and false send the same messages, without the instruction', async () => {
    const unset = await chatMessages(undefined);
    const off = await chatMessages('false');
    expect(JSON.stringify(unset)).toContain('RELEVANT INFORMATION FROM DOCUMENTS');
    expect(occurrences(unset)).toBe(0);
    expect(off).toEqual(unset);
  });

  it.each(['strict', 'balanced', 'flexible'])('chat %s: on adds the instruction once to the system prompt and changes nothing else', async (ragMode) => {
    const off = await chatMessages('false', { ragMode });
    const on = await chatMessages('true', { ragMode });
    expect(occurrences(on)).toBe(1);
    const carrier = on.filter((message) => typeof message.content === 'string' && message.content.includes(HISTORY_NOT_EVIDENCE_INSTRUCTION));
    expect(carrier).toHaveLength(1);
    expect(carrier[0].role).toBe('system');
    expect(withoutInstruction(on)).toEqual(off);
    expect(on.filter((message) => message.role === 'assistant')).toEqual(off.filter((message) => message.role === 'assistant'));
  });

  it('chat bypass: on adds nothing', async () => {
    const off = await chatMessages('false', { ragMode: 'bypass' });
    const on = await chatMessages('true', { ragMode: 'bypass' });
    expect(occurrences(on)).toBe(0);
    expect(on).toEqual(off);
  });

  it('chat balanced with no matching chunks still runs the knowledge-base prompt, so on adds the instruction once', async () => {
    h.retrieval.mockResolvedValue(retrievalWith([]));
    h.supabase.store.documents = [];
    const off = await chatMessages('false', { ragMode: 'balanced' });
    const on = await chatMessages('true', { ragMode: 'balanced' });
    expect(occurrences(off)).toBe(0);
    expect(occurrences(on)).toBe(1);
    expect(withoutInstruction(on)).toEqual(off);
  });

  it('strict refusal is unchanged with the switch on', async () => {
    h.retrieval.mockResolvedValue(retrievalWith([]));
    h.supabase.store.documents = [];
    const route = await loadChat('true');
    const body = await readSse(
      await route.POST(chatRequest({ messages: HISTORY, data: { ragMode: 'strict', settings: { webSearch: false } } })),
    );
    expect(body).toContain('Information Not Available');
    expect(h.capture.streamText).not.toHaveBeenCalled();
  });

  it('embed: off sends today\'s messages; on adds the instruction once to the system message', async () => {
    const unset = await embedMessages(undefined);
    const off = await embedMessages('false');
    expect(off).toEqual(unset);
    expect(occurrences(off)).toBe(0);
    const on = await embedMessages('true');
    expect(occurrences(on)).toBe(1);
    expect(on[0].role).toBe('system');
    expect(String(on[0].content)).toContain(HISTORY_NOT_EVIDENCE_INSTRUCTION);
    expect(withoutInstruction(on)).toEqual(off);
  });
});
