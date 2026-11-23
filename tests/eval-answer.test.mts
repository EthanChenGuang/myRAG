import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockLanguageModelV3 } from 'ai/test';
import { NextRequest } from 'next/server';
import { prepareInProcessEval, type InProcessEval } from '../eval/harness/run-eval.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS_DIR = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const ROUTE_PATH = '/api/internal/rag/run';
const TRACER_QUESTION = 'What is the refund window for annual plans?';
const OFF_TOPIC_QUESTION = 'Who won the 1998 football world cup final in Paris?';
const DEFAULT_FIRST_LINE = 'You are a helpful AI assistant with access to a knowledge base. When answering questions:';

type AnswerModule = typeof import('../src/lib/rag-eval/answer.ts');

interface TraceBody {
  answer: string | null;
  refused: boolean;
  context: string;
  stage_latency_ms: Record<string, number>;
  effective_config: { generator_model: string | null };
}

let prepared: InProcessEval;
let answer: AnswerModule;
const silentLog = (): (() => void) => {
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => undefined;
  console.warn = () => undefined;
  console.error = () => undefined;
  return () => Object.assign(console, original);
};

function mockModel(text: string, calls: { count: number }) {
  return new MockLanguageModelV3({
    doGenerate: async () => {
      calls.count += 1;
      return {
        content: [{ type: 'text' as const, text }],
        finishReason: { unified: 'stop' as const, raw: 'stop' },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
}

async function postRoute(body: Record<string, unknown>): Promise<{ status: number; json: TraceBody }> {
  const req = new NextRequest(`http://localhost${ROUTE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rag-eval-secret': prepared.secret },
    body: JSON.stringify({ schema_version: 1, rag_mode: 'strict', web_search: false, options: {}, ...body }),
  });
  const res = await prepared.POST(req);
  return { status: res.status, json: (await res.json()) as TraceBody };
}

before(async () => {
  const restore = silentLog();
  try {
    prepared = await prepareInProcessEval({ corpusDir: CORPUS_DIR, deploymentMode: 'single-tenant' });
    answer = await import('../src/lib/rag-eval/answer.ts');
  } finally {
    restore();
  }
});

after(async () => {
  answer?.setEvalLanguageModelFactory(null);
  await prepared?.close();
});

describe('buildEvalSystemPrompt', () => {
  test('default prompt carries the route text, the context and no placeholder', () => {
    const restore = silentLog();
    try {
      const prompt = answer.buildEvalSystemPrompt({ context: 'CTX-ALPHA', ragMode: 'strict', promptEnv: {} });
      assert.ok(prompt.includes(DEFAULT_FIRST_LINE));
      assert.ok(prompt.includes('CTX-ALPHA'));
      assert.ok(!prompt.includes('{{context}}'));
    } finally {
      restore();
    }
  });

  test('RAG_PRE_CONTEXT and RAG_POST_CONTEXT are unescaped and placed around the context', () => {
    const restore = silentLog();
    try {
      const prompt = answer.buildEvalSystemPrompt({
        context: 'CTX-BETA',
        ragMode: 'strict',
        promptEnv: { RAG_PRE_CONTEXT: 'PRE\\nLINE', RAG_POST_CONTEXT: 'POST' },
      });
      assert.ok(prompt.includes('PRE\nLINE'));
      assert.ok(prompt.includes('Context:'));
      assert.ok(prompt.includes('CTX-BETA'));
      assert.ok(prompt.indexOf('CTX-BETA') < prompt.indexOf('POST'));
      assert.ok(!prompt.includes('{{context}}'));
    } finally {
      restore();
    }
  });

  test('RAG_SYSTEM_PROMPT without a placeholder gets the context section appended', () => {
    const restore = silentLog();
    try {
      const prompt = answer.buildEvalSystemPrompt({
        context: 'CTX-GAMMA',
        ragMode: 'balanced',
        promptEnv: { RAG_SYSTEM_PROMPT: 'Answer briefly.\\nBe precise.' },
      });
      assert.ok(prompt.includes('Answer briefly.\nBe precise.'));
      assert.ok(prompt.includes('CTX-GAMMA'));
      assert.ok(!prompt.includes('{{context}}'));
    } finally {
      restore();
    }
  });

  test('an empty context uses injectContext and skips the mode wrapper', () => {
    const restore = silentLog();
    try {
      const prompt = answer.buildEvalSystemPrompt({ context: '', ragMode: 'strict', promptEnv: {} });
      assert.equal(prompt, answer.EVAL_DEFAULT_SYSTEM_PROMPT.replace('{{context}}', ''));
      assert.ok(!prompt.includes('Context from knowledge base'));
    } finally {
      restore();
    }
  });
});

describe('resolveGeneratorModel', () => {
  test('falls back to the isDefault entry of the model list', () => {
    assert.equal(answer.resolveGeneratorModel(), 'anthropic/claude-sonnet-4.5');
    assert.equal(answer.resolveGeneratorModel(null), 'anthropic/claude-sonnet-4.5');
  });

  test('the requested model wins', () => {
    assert.equal(answer.resolveGeneratorModel('openai/gpt-4.1-mini'), 'openai/gpt-4.1-mini');
  });
});

describe('generateEvalAnswer', () => {
  test('passes temperature 0.1, the built system prompt and the query as the user message', async () => {
    const calls = { count: 0 };
    const model = mockModel('MOCK-ANSWER', calls);
    answer.setEvalLanguageModelFactory(() => model);
    const restore = silentLog();
    try {
      const text = await answer.generateEvalAnswer({
        query: 'QUERY-TEXT',
        context: 'CTX-DELTA',
        ragMode: 'strict',
        generatorModel: 'anthropic/claude-sonnet-4.5',
        promptEnv: {},
      });
      assert.equal(text, 'MOCK-ANSWER');
    } finally {
      restore();
      answer.setEvalLanguageModelFactory(null);
    }
    assert.equal(model.doGenerateCalls.length, 1);
    const call = model.doGenerateCalls[0];
    assert.equal(call.temperature, 0.1);
    const system = call.prompt.find((message) => message.role === 'system');
    assert.ok(system && typeof system.content === 'string' && system.content.includes('CTX-DELTA'));
    const user = call.prompt.filter((message) => message.role === 'user');
    assert.equal(user.length, 1);
    assert.deepEqual(user[0].content, [{ type: 'text', text: 'QUERY-TEXT' }]);
  });
});

describe('eval route with include_answer', () => {
  test('returns the generator text for a non-refused item and records the model', async () => {
    const calls = { count: 0 };
    answer.setEvalLanguageModelFactory(() => mockModel('ROUTE-ANSWER', calls));
    const restore = silentLog();
    try {
      const { status, json } = await postRoute({ query: TRACER_QUESTION, include_answer: true, item_id: 'en-general-001' });
      assert.equal(status, 200);
      assert.equal(json.refused, false);
      assert.equal(json.answer, 'ROUTE-ANSWER');
      assert.equal(json.effective_config.generator_model, 'anthropic/claude-sonnet-4.5');
      assert.equal(typeof json.stage_latency_ms.generation, 'number');
      assert.equal(calls.count, 1);
    } finally {
      restore();
      answer.setEvalLanguageModelFactory(null);
    }
  });

  test('honors options.generator_model', async () => {
    const calls = { count: 0 };
    answer.setEvalLanguageModelFactory(() => mockModel('ROUTE-ANSWER', calls));
    const restore = silentLog();
    try {
      const { json } = await postRoute({
        query: TRACER_QUESTION,
        include_answer: true,
        options: { generator_model: 'openai/gpt-4.1-mini' },
      });
      assert.equal(json.effective_config.generator_model, 'openai/gpt-4.1-mini');
    } finally {
      restore();
      answer.setEvalLanguageModelFactory(null);
    }
  });

  test('a refused item gets a null answer and no generator call', async () => {
    const calls = { count: 0 };
    answer.setEvalLanguageModelFactory(() => mockModel('SHOULD-NOT-APPEAR', calls));
    const restore = silentLog();
    try {
      const { status, json } = await postRoute({ query: OFF_TOPIC_QUESTION, include_answer: true });
      assert.equal(status, 200);
      assert.equal(json.refused, true);
      assert.equal(json.answer, null);
      assert.equal(calls.count, 0);
    } finally {
      restore();
      answer.setEvalLanguageModelFactory(null);
    }
  });

  test('include_answer false leaves answer and generator_model null and never builds a model', async () => {
    let built = 0;
    answer.setEvalLanguageModelFactory(() => {
      built += 1;
      return mockModel('NOPE', { count: 0 });
    });
    const restore = silentLog();
    try {
      const { status, json } = await postRoute({ query: TRACER_QUESTION });
      assert.equal(status, 200);
      assert.equal(json.answer, null);
      assert.equal(json.effective_config.generator_model, null);
      assert.equal('generation' in json.stage_latency_ms, false);
      assert.equal(built, 0);
    } finally {
      restore();
      answer.setEvalLanguageModelFactory(null);
    }
  });

  test('a generator failure returns 500 without prompt or context text in the log', async () => {
    answer.setEvalLanguageModelFactory(
      () =>
        new MockLanguageModelV3({
          doGenerate: async () => {
            throw new Error(`boom ${TRACER_QUESTION}`);
          },
        }),
    );
    const logged: string[] = [];
    const original = { log: console.log, warn: console.warn, error: console.error };
    console.log = () => undefined;
    console.warn = () => undefined;
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    };
    try {
      const { status } = await postRoute({ query: TRACER_QUESTION, include_answer: true });
      assert.equal(status, 500);
    } finally {
      Object.assign(console, original);
      answer.setEvalLanguageModelFactory(null);
    }
    const joined = logged.join('\n');
    assert.ok(joined.includes('[RAG Eval] generation failed'));
    assert.ok(!joined.includes(TRACER_QUESTION));
  });
});
