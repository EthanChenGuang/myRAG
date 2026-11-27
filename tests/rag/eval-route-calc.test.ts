import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { LanguageModel } from 'ai';
import type { LanguageModelV3CallOptions, LanguageModelV3Content } from '@ai-sdk/provider';
import { MockLanguageModelV3 } from 'ai/test';
import { RagTraceSchema } from '@/lib/rag-eval/contracts.generated';
import { CALC_BLOCK_CLOSE, CALC_BLOCK_OPEN } from '@/lib/rag/calc/block-tag';
import { emitNotice, renderNoticeAsText } from '@/lib/rag/generation/notices';
import { installChatPipeline, retrievalWith } from '../helpers/chat-route-fakes';
import { contextBlocks, promptParts } from '../../eval/harness/fake-citation-generator.mts';
import { installFakeAnswerModels, isFakeGeneratorModel } from '../../eval/harness/fake-answer-models.mts';
import {
  FAKE_CALC_FOLLOW_BLOCK_MODEL,
  FAKE_CALC_FOLLOW_MODEL,
  FAKE_CALC_MISSING_OPERAND_MODEL,
  FAKE_CALC_SKIP_RULE_MODEL,
  loadCalcFakeScripts,
} from '../../eval/harness/fake-calc-models.mts';
import { loadRunConfig } from '../../eval/harness/run-config.mts';

const REPO_ROOT = path.resolve(__dirname, '../..');

const SECRET = 'c'.repeat(48);
const ENV_NAMES = [
  'RAG_EVAL_SECRET',
  'RAG_EVAL_ENDPOINT_ENABLED',
  'NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE',
  'NEXT_PUBLIC_AI_PROVIDER',
  'RAG_SUPPORTED_LANGUAGES',
  'RAG_PRIMARY_LANGUAGE',
  'RAG_REGISTRY_TEXTS',
  'RAG_CITATIONS',
  'RAG_CALC_TOOL',
  'RAG_CALC_CHECK',
  'RAG_SYSTEM_PROMPT',
  'RAG_PRE_CONTEXT',
  'RAG_POST_CONTEXT',
] as const;
const env = process.env as Record<string, string | undefined>;

const QUESTION = 'Three lots of 25, 52 and 61 pell are tallied under the Varnel cap rule. What is the counted total in pell?';
const RULE_TEXT = 'Under the Varnel cap rule each lot counts for at most 40 pell.';
const OTHER_TEXT = 'The Varnel ledger is kept in the north hall.';
const TOOL_MODEL = 'test/calc-tool-model';
const NO_TOOL_MODEL = 'test/calc-no-tool-model';

const h = await vi.hoisted(async () => {
  const fakes = await import('../helpers/chat-route-fakes');
  return fakes.createChatRouteHarness();
});

vi.mock('@/lib/supabase', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/supabase')>()),
  getSupabaseAdmin: () => h.supabase.client,
}));

let saved: Record<string, string | undefined>;

function chunkRow(id: string, content: string, similarity: number) {
  return {
    chunk_id: `chunk-${id}`,
    document_id: `doc-${id}`,
    content,
    similarity,
    metadata: null,
    temporal_score: 0,
    financial_score: 0,
    final_score: similarity,
    match_reason: 'similarity',
  };
}

function seed(rows: Array<ReturnType<typeof chunkRow>>) {
  h.supabase.store.documents = rows.map((row) => ({
    id: row.document_id,
    filename: `varnel-notes-${row.document_id}.md`,
    created_at: '2026-01-01T00:00:00.000Z',
    content: 'varnel notes',
    metadata: {},
  }));
  h.supabase.store.document_chunks = rows.map((row) => ({ id: row.chunk_id, document_id: row.document_id, metadata: null }));
  h.retrieval.mockReset();
  h.retrieval.mockResolvedValue(retrievalWith(rows));
}

type Behaviour = 'follow' | 'skip_rule' | 'missing_operand' | 'plain';

interface Captured {
  system: string;
  tools: string[];
}

function ruleAlias(system: string): string | null {
  return contextBlocks(system).find((block) => block.text.includes('at most 40 pell'))?.alias ?? null;
}

function request(alias: string, cap: string) {
  return {
    operands: [
      { name: 'lots', values: ['25', '52', '61'], unit: 'pell', source: { kind: 'question' } },
      { name: 'cap', value: cap, unit: 'pell', source: { kind: 'chunk', alias } },
    ],
    steps: [
      { id: 'capped', op: 'cap_each', args: ['lots', 'cap'], label: 'each lot capped' },
      { id: 'total', op: 'sum', args: ['capped'], label: 'counted total' },
    ],
    result: 'total',
  };
}

/** A scripted calculation model: tool call when the tool is offered, the trailing block when its instruction is present. */
function calcModel(behaviour: Behaviour, calls: Captured[]): LanguageModel {
  return new MockLanguageModelV3({
    doGenerate: async (options: LanguageModelV3CallOptions) => {
      const { system } = promptParts(options);
      const tools = (options.tools ?? []).map((tool) => tool.name);
      calls.push({ system, tools });
      const alias = ruleAlias(system);
      const cap = behaviour === 'missing_operand' ? '45' : '40';
      const stated = behaviour === 'skip_rule' ? '138' : behaviour === 'missing_operand' ? '113' : '105';
      const sentence = `each lot capped: 105.\ncounted total: ${stated} pell.${alias ? ` [${alias}]` : ''}`;
      let content: LanguageModelV3Content[];
      let unified: 'stop' | 'tool-calls' = 'stop';
      if (behaviour !== 'plain' && alias && tools.includes('calculate') && !options.prompt.some((message) => message.role === 'tool')) {
        content = [{ type: 'tool-call', toolCallId: 'calc-1', toolName: 'calculate', input: JSON.stringify(request(alias, cap)) }];
        unified = 'tool-calls';
      } else if (behaviour !== 'plain' && alias && system.includes(CALC_BLOCK_OPEN)) {
        content = [{ type: 'text', text: `${sentence}\n\n${CALC_BLOCK_OPEN}${JSON.stringify(request(alias, cap))}${CALC_BLOCK_CLOSE}` }];
      } else {
        content = [{ type: 'text', text: behaviour === 'plain' ? 'The counted total is 138 pell.' : sentence }];
      }
      return {
        content,
        finishReason: { unified, raw: unified },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
        warnings: [],
      };
    },
  }) as unknown as LanguageModel;
}

async function loadRoute(factory: (modelId: string) => LanguageModel, canUseTools?: (modelId: string) => boolean | undefined) {
  vi.resetModules();
  await installChatPipeline(h);
  const answer = await import('@/lib/rag-eval/answer');
  answer.setEvalLanguageModelFactory(canUseTools ? Object.assign(factory, { canUseTools }) : factory);
  return import('@/app/api/internal/rag/run/route');
}

function evalRequest(generatorModel: string) {
  return new NextRequest('http://localhost/api/internal/rag/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rag-eval-secret': SECRET },
    body: JSON.stringify({
      schema_version: 1,
      query: QUESTION,
      rag_mode: 'balanced',
      include_answer: true,
      options: { generator_model: generatorModel },
    }),
  });
}

type Trace = ReturnType<typeof RagTraceSchema.parse> & Record<string, unknown>;

async function post(route: { POST: (req: NextRequest) => Promise<Response> }, generatorModel: string): Promise<{ status: number; trace: Trace }> {
  const response = await route.POST(evalRequest(generatorModel));
  const raw = await response.text();
  return { status: response.status, trace: JSON.parse(raw) as Trace };
}

const noToolCapability = (modelId: string) => (modelId === NO_TOOL_MODEL ? false : undefined);

describe('eval route calculation: offer, block, check and observation (05.2.1-17)', () => {
  beforeEach(() => {
    saved = Object.fromEntries(ENV_NAMES.map((name) => [name, env[name]]));
    for (const name of ENV_NAMES) delete env[name];
    env.RAG_EVAL_SECRET = SECRET;
    env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'single-tenant';
    env.RAG_SUPPORTED_LANGUAGES = 'en';
    env.RAG_PRIMARY_LANGUAGE = 'en';
    h.supabase.store.reset();
    seed([chunkRow('1', RULE_TEXT, 0.92), chunkRow('2', OTHER_TEXT, 0.88)]);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    const answer = await import('@/lib/rag-eval/answer');
    answer.setEvalLanguageModelFactory(null);
    for (const name of ENV_NAMES) {
      if (saved[name] === undefined) delete env[name];
      else env[name] = saved[name];
    }
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('RAG_CALC_TOOL off: no tool, no calculation rule, the answer unchanged and only calc_observed added', async () => {
    const calls: Captured[] = [];
    const route = await loadRoute(() => calcModel('follow', calls));
    const { status, trace } = await post(route, TOOL_MODEL);

    expect(status).toBe(200);
    expect(RagTraceSchema.safeParse(trace).success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].tools).toEqual([]);
    expect(calls[0].system).not.toContain('[rule:calculation]');
    expect(trace.answer).toBe('each lot capped: 105.\ncounted total: 105 pell.');
    expect(trace).not.toHaveProperty('calc');
    expect(trace).not.toHaveProperty('review_reasons');
    expect(trace).not.toHaveProperty('notices');
    expect(trace.calc_observed).toEqual({ stated: '105', steps_listed: false, tool_used: false, origin: null });
  });

  it('RAG_CALC_TOOL on with a tool-capable model: the calculation rule and the tool are offered and the trace shows the tool', async () => {
    env.RAG_CALC_TOOL = 'true';
    const calls: Captured[] = [];
    const route = await loadRoute(() => calcModel('follow', calls), noToolCapability);
    const { status, trace } = await post(route, TOOL_MODEL);

    expect(status).toBe(200);
    expect(RagTraceSchema.safeParse(trace).success).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0].tools).toEqual(['calculate']);
    expect(calls[0].system).toContain('[rule:calculation]');
    expect(calls[0].system).not.toContain(CALC_BLOCK_OPEN);
    expect(trace.answer).toBe('each lot capped: 105.\ncounted total: 105 pell.');
    expect(trace.calc_observed).toEqual({ stated: '105', steps_listed: true, tool_used: true, origin: 'tool' });
    expect(trace).not.toHaveProperty('calc');
  });

  it('RAG_CALC_TOOL on with a model without tool support: trailing-block mode, the block is removed from the answer', async () => {
    env.RAG_CALC_TOOL = 'true';
    const calls: Captured[] = [];
    const route = await loadRoute(() => calcModel('follow', calls), noToolCapability);
    const { status, trace } = await post(route, NO_TOOL_MODEL);

    expect(status).toBe(200);
    expect(RagTraceSchema.safeParse(trace).success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].tools).toEqual([]);
    expect(calls[0].system).toContain('[rule:calculation]');
    expect(calls[0].system).toContain(CALC_BLOCK_OPEN);
    expect(trace.answer).toBe('each lot capped: 105.\ncounted total: 105 pell.');
    expect(trace.answer).not.toContain(CALC_BLOCK_OPEN);
    expect(trace.calc_observed).toEqual({ stated: '105', steps_listed: true, tool_used: false, origin: 'trailing_block' });
  });

  it('a claude-sonnet-4 generator id declares no tool support through the chat route rule', async () => {
    env.RAG_CALC_TOOL = 'true';
    const calls: Captured[] = [];
    const route = await loadRoute(() => calcModel('follow', calls));
    const { trace } = await post(route, 'anthropic/claude-sonnet-4');

    expect(calls[0].tools).toEqual([]);
    expect(calls[0].system).toContain(CALC_BLOCK_OPEN);
    expect(trace.calc_observed?.origin).toBe('trailing_block');
  });

  it('RAG_CALC_CHECK on with a rule-skipping answer: corrected with both values, the notice last and calc_mismatch', async () => {
    env.RAG_CALC_TOOL = 'true';
    env.RAG_CALC_CHECK = 'true';
    const route = await loadRoute(() => calcModel('skip_rule', []), noToolCapability);
    const { status, trace } = await post(route, TOOL_MODEL);

    expect(status).toBe(200);
    expect(RagTraceSchema.safeParse(trace).success).toBe(true);
    expect(trace.calc).toHaveLength(1);
    expect(trace.calc?.[0]).toMatchObject({ status: 'corrected', stated: '138', recomputed: '105', origin: 'tool', reason: null });
    const notice = emitNotice('calc_corrected', { language: 'en', params: { value: '105 pell' } });
    expect(trace.answer).toBe(`each lot capped: 105.\ncounted total: 138 pell.${renderNoticeAsText(notice)}`);
    expect(trace.notices).toEqual([notice]);
    expect(trace.review_reasons).toEqual(['calc_mismatch']);
    expect(trace.calc_observed).toEqual({ stated: '138', steps_listed: true, tool_used: true, origin: 'tool' });
  });

  it('RAG_CALC_CHECK off with the same answer: calc_observed only, no check, no notice', async () => {
    env.RAG_CALC_TOOL = 'true';
    const route = await loadRoute(() => calcModel('skip_rule', []), noToolCapability);
    const { trace } = await post(route, TOOL_MODEL);

    expect(trace).not.toHaveProperty('calc');
    expect(trace).not.toHaveProperty('review_reasons');
    expect(trace.answer).toBe('each lot capped: 105.\ncounted total: 138 pell.');
    expect(trace.calc_observed).toEqual({ stated: '138', steps_listed: true, tool_used: true, origin: 'tool' });
  });

  it('RAG_CALC_CHECK on with an operand missing from its block: not_verified, operand_not_located and calc_unverified', async () => {
    env.RAG_CALC_TOOL = 'true';
    env.RAG_CALC_CHECK = 'true';
    const route = await loadRoute(() => calcModel('missing_operand', []), noToolCapability);
    const { status, trace } = await post(route, TOOL_MODEL);

    expect(status).toBe(200);
    expect(RagTraceSchema.safeParse(trace).success).toBe(true);
    expect(trace.calc?.[0]).toMatchObject({ status: 'not_verified', reason: 'operand_not_located' });
    const notice = emitNotice('calc_not_verified', { language: 'en' });
    expect(trace.answer?.endsWith(renderNoticeAsText(notice))).toBe(true);
    expect(trace.review_reasons).toEqual(['calc_unverified']);
  });

  it('RAG_CALC_CHECK on in block mode checks the extracted block', async () => {
    env.RAG_CALC_TOOL = 'true';
    env.RAG_CALC_CHECK = 'true';
    const route = await loadRoute(() => calcModel('skip_rule', []), noToolCapability);
    const { trace } = await post(route, NO_TOOL_MODEL);

    expect(trace.calc?.[0]).toMatchObject({ status: 'corrected', stated: '138', recomputed: '105', origin: 'trailing_block' });
    expect(trace.answer).not.toContain(CALC_BLOCK_OPEN);
    expect(trace.review_reasons).toEqual(['calc_mismatch']);
  });

  it('a question without a quantity or computation term is never offered the calculation', async () => {
    env.RAG_CALC_TOOL = 'true';
    env.RAG_CALC_CHECK = 'true';
    const calls: Captured[] = [];
    const route = await loadRoute(() => calcModel('plain', calls), noToolCapability);
    const response = await route.POST(
      new NextRequest('http://localhost/api/internal/rag/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-rag-eval-secret': SECRET },
        body: JSON.stringify({
          schema_version: 1,
          query: 'Where is the Varnel ledger kept?',
          rag_mode: 'balanced',
          include_answer: true,
          options: { generator_model: TOOL_MODEL },
        }),
      }),
    );
    const trace = JSON.parse(await response.text()) as Trace;
    expect(calls[0].tools).toEqual([]);
    expect(calls[0].system).not.toContain('[rule:calculation]');
    expect(trace).not.toHaveProperty('calc');
    expect(trace.calc_observed?.tool_used).toBe(false);
  });
  describe('calculation fakes and run configs (05.2.1-17 Task 3, D-78)', () => {
    const SCRIPTS = loadCalcFakeScripts();
    const THRESHOLD = SCRIPTS.groups.find((group) => group.paraphrase_group === 'en-calc-threshold')!;
    const THRESHOLD_ROW = chunkRow('1', `Tally note: ${THRESHOLD.blocks.B1.quote}.`, 0.92);
    const RUN_CONFIGS = {
      'calc-tool-follow': { model: FAKE_CALC_FOLLOW_MODEL, check: 'true' },
      'calc-block-follow': { model: FAKE_CALC_FOLLOW_BLOCK_MODEL, check: 'true' },
      'calc-skip-rule-check-off': { model: FAKE_CALC_SKIP_RULE_MODEL, check: 'false' },
      'calc-skip-rule-check-on': { model: FAKE_CALC_SKIP_RULE_MODEL, check: 'true' },
      'calc-missing-operand': { model: FAKE_CALC_MISSING_OPERAND_MODEL, check: 'true' },
    } as const;

    beforeEach(() => {
      seed([THRESHOLD_ROW, chunkRow('2', OTHER_TEXT, 0.88)]);
    });

    async function run(modelId: string, query: string = THRESHOLD.questions[0]) {
      const factory = installFakeAnswerModels({ items: [] });
      const calls: Captured[] = [];
      const route = await loadRoute(
        Object.assign(
          (id: string) => {
            const inner = factory(id) as unknown as { doGenerate: (options: LanguageModelV3CallOptions) => Promise<unknown> };
            return new MockLanguageModelV3({
              doGenerate: async (options) => {
                calls.push({ system: promptParts(options).system, tools: (options.tools ?? []).map((tool) => tool.name) });
                return (await inner.doGenerate(options)) as Awaited<ReturnType<NonNullable<MockLanguageModelV3['doGenerate']>>>;
              },
            }) as unknown as LanguageModel;
          },
          { canUseTools: factory.canUseTools },
        ),
      );
      const response = await route.POST(
        new NextRequest('http://localhost/api/internal/rag/run', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-rag-eval-secret': SECRET },
          body: JSON.stringify({ schema_version: 1, query, rag_mode: 'balanced', include_answer: true, options: { generator_model: modelId } }),
        }),
      );
      const trace = JSON.parse(await response.text()) as Trace;
      expect(response.status).toBe(200);
      expect(RagTraceSchema.safeParse(trace).success).toBe(true);
      return { trace, calls };
    }

    it('the follow fake calls the tool only with the instruction, lists every step and states the tool value', async () => {
      env.RAG_CALC_TOOL = 'true';
      env.RAG_CALC_CHECK = 'true';
      const { trace, calls } = await run(FAKE_CALC_FOLLOW_MODEL);
      expect(calls[0].tools).toEqual(['calculate']);
      expect(trace.calc_observed).toEqual({ stated: THRESHOLD.expected_value, steps_listed: true, tool_used: true, origin: 'tool' });
      expect(trace.calc?.[0]).toMatchObject({ status: 'verified', stated: THRESHOLD.expected_value, recomputed: THRESHOLD.expected_value });
      expect(trace.review_reasons).toEqual([]);
    });

    it('the follow fake without the calculation instruction answers in plain text and calls no tool', async () => {
      const { trace, calls } = await run(FAKE_CALC_FOLLOW_MODEL);
      expect(calls).toHaveLength(1);
      expect(calls[0].system).not.toContain('[rule:calculation]');
      expect(trace.calc_observed?.tool_used).toBe(false);
      expect(trace.calc_observed?.stated).toBe(THRESHOLD.skip_rule.stated_value);
    });

    it('the block fake declares no tool support and writes the steps and the request in the trailing block', async () => {
      env.RAG_CALC_TOOL = 'true';
      env.RAG_CALC_CHECK = 'true';
      const { trace, calls } = await run(FAKE_CALC_FOLLOW_BLOCK_MODEL);
      expect(calls).toHaveLength(1);
      expect(calls[0].tools).toEqual([]);
      expect(calls[0].system).toContain(CALC_BLOCK_OPEN);
      expect(trace.answer).not.toContain(CALC_BLOCK_OPEN);
      expect(trace.calc_observed).toEqual({ stated: THRESHOLD.expected_value, steps_listed: true, tool_used: false, origin: 'trailing_block' });
      expect(trace.calc?.[0]).toMatchObject({ status: 'verified', origin: 'trailing_block' });
    });

    it('the skip-rule fake sends the correct trace and states the rule-skipping total: corrected with the check on', async () => {
      env.RAG_CALC_TOOL = 'true';
      env.RAG_CALC_CHECK = 'true';
      const { trace } = await run(FAKE_CALC_SKIP_RULE_MODEL);
      expect(trace.calc?.[0]).toMatchObject({ status: 'corrected', stated: THRESHOLD.skip_rule.stated_value, recomputed: THRESHOLD.expected_value });
      expect(trace.review_reasons).toEqual(['calc_mismatch']);
      const notice = emitNotice('calc_corrected', { language: 'en', params: { value: `${THRESHOLD.expected_value} ${THRESHOLD.unit}` } });
      expect(trace.answer?.endsWith(renderNoticeAsText(notice))).toBe(true);
    });

    it('the skip-rule fake with the check off: the wrong total stands, observed but not checked', async () => {
      env.RAG_CALC_TOOL = 'true';
      const { trace } = await run(FAKE_CALC_SKIP_RULE_MODEL);
      expect(trace).not.toHaveProperty('calc');
      expect(trace.calc_observed).toMatchObject({ stated: THRESHOLD.skip_rule.stated_value, tool_used: true, steps_listed: true });
    });

    it('the missing-operand fake cites an operand value its block does not hold: not verified', async () => {
      env.RAG_CALC_TOOL = 'true';
      env.RAG_CALC_CHECK = 'true';
      const { trace } = await run(FAKE_CALC_MISSING_OPERAND_MODEL);
      expect(trace.calc?.[0]).toMatchObject({ status: 'not_verified', reason: 'operand_not_located' });
      expect(trace.review_reasons).toEqual(['calc_unverified']);
    });

    it('a question outside the scripts is answered by the fallback generator', async () => {
      const { trace } = await run(FAKE_CALC_FOLLOW_MODEL, 'Where is the Varnel ledger kept?');
      expect(typeof trace.answer).toBe('string');
      expect(trace.calc_observed?.tool_used).toBe(false);
    });

    it('every scripted question belongs to a golden multi_step_calc item of the same group', () => {
      const golden = fs
        .readFileSync(path.join(REPO_ROOT, 'eval/fixtures/golden.jsonl'), 'utf8')
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as { id: string; question: string; category: string });
      for (const group of SCRIPTS.groups) {
        group.items.forEach((id, index) => {
          const item = golden.find((candidate) => candidate.id === id);
          expect(item?.category).toBe('multi_step_calc');
          expect(item?.question).toBe(group.questions[index]);
        });
      }
    });

    it('the five run configs validate and select their fake with the switches each gate needs', () => {
      for (const [name, expected] of Object.entries(RUN_CONFIGS)) {
        const config = loadRunConfig(path.join(REPO_ROOT, 'eval/config/runs', `${name}.json`));
        expect(config.name).toBe(name);
        expect(config.generatorModel).toBe(expected.model);
        expect(isFakeGeneratorModel(expected.model)).toBe(true);
        expect(config.env.RAG_CALC_TOOL).toBe('true');
        expect(config.env.RAG_CALC_CHECK).toBe(expected.check);
      }
    });

    it('the fakes are reachable only through the eval harness', () => {
      const grep = spawnSync('git', ['grep', '-l', '-e', 'fake-calc', '-e', 'fake/calc-', '--', 'src'], { cwd: REPO_ROOT, encoding: 'utf8' });
      expect(grep.status).toBe(1);
      expect(grep.stdout.trim()).toBe('');
    });
  });
});
