import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { estimateTokens, factorFor, promptBudgetConfig } from '@/lib/rag/context/prompt-budget-config';
import { fixedText } from '@/lib/rag/lang/texts';
import type { RunRetrievalInput } from '@/lib/rag/types';

const API_KEY = 'internal-key-placeholder-0123456789';

const state = vi.hoisted(() => ({ inputs: [] as Array<Record<string, unknown>>, dropped: 0 }));

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return { ...actual, env: new Proxy(actual.env, { get: (target, key) => (key === 'MYRAG_INTERNAL_API_KEY' ? 'internal-key-placeholder-0123456789' : Reflect.get(target, key)) }) };
});

vi.mock('@/lib/rag', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rag')>();
  const { mintScope: mint } = await import('@/lib/rag/tenant/scope');
  return {
    ...actual,
    resolveVoiceScope: async () => ({ ok: true, scope: mint('single', null, null), actorUserId: null }),
    runRetrieval: async (input: RunRetrievalInput) => {
      state.inputs.push({ ...input });
      const budget = (input.options as { documentTokenBudget?: number } | undefined)?.documentTokenBudget;
      return {
        status: 'ok',
        traceId: '0123456789abcdef0123456789abcdef',
        stages: [],
        ...(budget !== undefined ? { packing: { documentBudget: budget, droppedDocuments: state.dropped, keptParents: 0 } } : {}),
        voice: { results: [{ chunk_id: 'c1', document_id: 'd1', content: 'synthetic block text', similarity: 0.9 }], source_images: [] },
      };
    },
  };
});

const { POST } = await import('@/app/api/internal/voice-rag/route');

const QUERY = 'What does the synthetic block say about the sample?';
const CONFIG = promptBudgetConfig();
const FACTOR = factorFor(null).factor;
/** Packing counts raw counter tokens: the planned (factor-scaled) budget reaches retrieval divided by the factor. */
const packing = (documents: number) => Math.floor(documents / FACTOR);

function request(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/internal/voice-rag', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ query: QUERY, ...body }),
  });
}

function documentBudgetFor(window: number, historyTokens: number, query = QUERY): number {
  const margin = Math.ceil(CONFIG.margin_ratio * window) + CONFIG.margin_tokens;
  const question = estimateTokens(query, null);
  return Math.min(CONFIG.voice_document_budget, window - CONFIG.voice_system_reserve - historyTokens - question - CONFIG.voice_answer_reserve - margin);
}

function lastOptions(): Record<string, unknown> {
  return (state.inputs[state.inputs.length - 1]?.options ?? {}) as Record<string, unknown>;
}

function budgetStage(): { status: string; counts?: Record<string, number> } | undefined {
  const trace = state.inputs[state.inputs.length - 1]?.trace as { stages(): Array<{ name: string; status: string; counts?: Record<string, number> }> } | undefined;
  return trace?.stages().find((stage) => stage.name === 'prompt_budget');
}

const saved = { ...process.env };

beforeEach(() => {
  state.inputs.length = 0;
  state.dropped = 0;
  process.env.RAG_SUPPORTED_LANGUAGES = 'zh,en,it';
  process.env.RAG_PRIMARY_LANGUAGE = 'en';
  delete process.env.RAG_PROMPT_BUDGET;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
  Object.assign(process.env, saved);
});

describe('voice-rag prompt budget (D-87)', () => {
  test('switch off: the fields are accepted and ignored; retrieval gets no documentTokenBudget and the body is unchanged', async () => {
    const plain = await (await POST(request({}))).json();
    const withFields = await POST(request({ modelContextLength: 4096, historyTokens: 500 }));
    expect(withFields.status).toBe(200);
    expect(await withFields.json()).toEqual(plain);
    expect(state.inputs).toHaveLength(2);
    for (const input of state.inputs) expect(input.options).toEqual({ maxResults: 5 });
    expect(state.inputs[1]!.trace).toBeUndefined();
  });

  test('switch off parity: unset and an explicit false give the same retrieval input and a byte-identical body', async () => {
    const unset = await (await POST(request({ modelContextLength: 4096, historyTokens: 500 }))).text();
    process.env.RAG_PROMPT_BUDGET = 'false';
    const off = await (await POST(request({ modelContextLength: 4096, historyTokens: 500 }))).text();
    expect(off).toBe(unset);
    expect(JSON.stringify(state.inputs[1]!.options)).toBe(JSON.stringify(state.inputs[0]!.options));
    expect(state.inputs[1]!.options).toEqual({ maxResults: 5 });
  });

  test('switch on with both fields: the planned voice budget reaches retrieval and the trace carries prompt_budget', async () => {
    process.env.RAG_PROMPT_BUDGET = 'true';
    state.dropped = 2;
    const response = await POST(request({ modelContextLength: 4096, historyTokens: 1000 }));
    expect(response.status).toBe(200);
    const expected = documentBudgetFor(4096, 1000);
    expect(expected).toBeGreaterThan(0);
    expect(expected).toBeLessThan(CONFIG.voice_document_budget);
    expect(lastOptions().documentTokenBudget).toBe(packing(expected));
    expect(lastOptions().documentTokenBudget).toBeLessThan(expected);
    expect(budgetStage()).toMatchObject({
      status: 'ok',
      counts: { window: 4096, documents: expected, history: 1000, system: CONFIG.voice_system_reserve, reserve: CONFIG.voice_answer_reserve, dropped_documents: 2 },
    });
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['results', 'source_images', 'traceId']);
  });

  test('switch on with a large window: the voice budget caps the documents', async () => {
    process.env.RAG_PROMPT_BUDGET = 'true';
    await POST(request({ modelContextLength: 128000, historyTokens: 2000 }));
    expect(lastOptions().documentTokenBudget).toBe(packing(CONFIG.voice_document_budget));
  });

  test('switch on without the fields: the fixed voice budget', async () => {
    process.env.RAG_PROMPT_BUDGET = 'true';
    const response = await POST(request({}));
    expect(response.status).toBe(200);
    expect(lastOptions().documentTokenBudget).toBe(packing(CONFIG.voice_document_budget));
  });

  test('switch on, a window too small for the question: 413 prompt_budget_exceeded in the question language, no retrieval', async () => {
    process.env.RAG_PROMPT_BUDGET = 'true';
    const response = await POST(request({ modelContextLength: 1024, historyTokens: 0 }));
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'prompt_budget_exceeded', message: fixedText('notices.prompt_too_long', 'en') });
    const italian = await POST(request({ query: 'Che cosa dice il blocco sintetico sul campione di prova della settimana?', modelContextLength: 1024 }));
    expect(italian.status).toBe(413);
    expect(((await italian.json()) as { message: string }).message).toBe(fixedText('notices.prompt_too_long', 'it'));
    expect(state.inputs).toHaveLength(0);
  });

  test('a modelContextLength below 1,024 or a negative historyTokens answers 400 and runs no search, with the switch on or off', async () => {
    for (const on of [false, true]) {
      if (on) process.env.RAG_PROMPT_BUDGET = 'true';
      for (const body of [{ modelContextLength: 1023 }, { modelContextLength: 4096.5 }, { historyTokens: -1 }, { modelContextLength: 10_000_001 }]) {
        const response = await POST(request(body));
        expect(response.status).toBe(400);
      }
    }
    expect(state.inputs).toHaveLength(0);
  });
});

