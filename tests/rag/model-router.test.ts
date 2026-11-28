import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueryClassification } from '@/lib/query-classifier';
import type { QueryPlan } from '@/lib/rag-eval/contracts.generated';
import { DEFAULT_ROUTING_FAST_MODEL, DEFAULT_ROUTING_QUALITY_MODEL, loadRagConfig, type ModelRoutingConfig } from '@/lib/rag/config';
import { routeModel, resolveRequestedModel, type RouteModelInput } from '@/lib/rag/generation/model-router';
import type { GateResult, GateRuleId } from '@/lib/rag/query/rewrite-gate';
import { createCitationSession, type ContextBlock } from '@/lib/rag';
import { preRetrievalCitations } from '@/lib/rag/generation/citations/strategy';

const FAST = DEFAULT_ROUTING_FAST_MODEL;
const QUALITY = DEFAULT_ROUTING_QUALITY_MODEL;
const ON: ModelRoutingConfig = { requestedMode: 'auto', mode: 'auto', fastModel: FAST, qualityModel: QUALITY };
const OFF: ModelRoutingConfig = { ...ON, requestedMode: 'off', mode: 'off' };

function classification(category: QueryClassification['category'] = 'document_search'): QueryClassification {
  return { needsMcp: false, confidence: 0.9, category, reasoningText: 'synthetic' };
}

function gate(reasons: GateRuleId[] = []): GateResult {
  return { rewrite: false, transforms: [], reasons, lang: 'en', protectedTokens: [] };
}

function plan(overrides: Partial<QueryPlan> = {}): QueryPlan {
  return {
    original: 'What is the alpha value?',
    standalone: 'What is the alpha value?',
    framework: 'llamaindex',
    language: 'en',
    gate: { lang: 'en', protected_tokens: [], reasons: [], rewrite: false, skip_retrieval: false, transforms: [] },
    variants: [{ kind: 'original', language: 'en', protected_ok: true, sub_question_index: null, text: 'What is the alpha value?' }],
    date_range: null,
    ...overrides,
  } as QueryPlan;
}

function input(overrides: Partial<RouteModelInput> = {}): RouteModelInput {
  return {
    query: 'What is the alpha value?',
    classification: classification(),
    gate: gate(),
    plan: plan(),
    contextTokens: 400,
    params: { routing_fast_max_context_tokens: 2000 },
    ids: { fastModel: FAST, qualityModel: QUALITY },
    ...overrides,
  };
}

describe('routeModel (D-20)', () => {
  it('sends a simple lookup to the fast model', () => {
    expect(routeModel(input())).toEqual({ tier: 'fast', rule: 'simple_lookup', modelId: FAST });
  });

  it.each([
    ['not_document_search', { classification: classification('complex') }],
    ['no_classification', { classification: undefined }],
    ['gate_comparison', { gate: gate(['R3_COMPARISON']) }],
    ['gate_elliptical', { gate: gate(['R5_ELLIPTICAL']) }],
    ['gate_compound', { gate: gate(['R6_COMPOUND']) }],
    ['gate_language_mismatch', { gate: gate(['R8_LANGUAGE_MISMATCH']) }],
    ['decomposed', { plan: plan({ sub_questions: ['What is alpha?', 'What is beta?'] }) }],
    [
      'decomposed',
      { plan: plan({ variants: [...plan().variants!, { kind: 'sub_question', language: 'en', protected_ok: true, sub_question_index: 0, text: 'What is alpha?' }] }) },
    ],
    [
      'translated',
      { plan: plan({ variants: [...plan().variants!, { kind: 'translated', language: 'zh', protected_ok: true, sub_question_index: null, text: '阿尔法的值是多少？' }] }) },
    ],
    ['long_query', { query: 'What is the recorded alpha value of the synthetic sample listed in the third section of the neutral test document?' }],
    ['large_context', { contextTokens: 2000 }],
  ] as Array<[string, Partial<RouteModelInput>]>)('gives the quality model with rule %s', (rule, overrides) => {
    expect(routeModel(input(overrides))).toEqual({ tier: 'quality', rule, modelId: QUALITY });
  });

  it('reads the gate reasons from the plan when no gate result is passed', () => {
    const withPlanGate = plan({ gate: { lang: 'en', protected_tokens: [], reasons: ['R6_COMPOUND'], rewrite: true, skip_retrieval: false, transforms: ['decompose'] } });
    expect(routeModel(input({ gate: undefined, plan: withPlanGate })).rule).toBe('gate_compound');
  });

  it('lets other gate rules (R1, R2, R4) through to the fast tier', () => {
    expect(routeModel(input({ gate: gate(['R1_PRONOUN', 'R2_RELATIVE_TIME', 'R4_EXACT_CODE']) })).tier).toBe('fast');
  });

  it('measures the length rule in CJK units for zh', () => {
    const zhGate: GateResult = { ...gate(), lang: 'zh' };
    expect(routeModel(input({ gate: zhGate, query: '阿尔法的值是多少？' })).tier).toBe('fast');
    expect(routeModel(input({ gate: zhGate, query: '请说明中性测试文档第三节列出的合成样本所记录的阿尔法数值以及它的测量单位和记录日期是什么' })).rule).toBe('long_query');
  });

  it('never returns auto, even when a configured id is auto', () => {
    const auto = routeModel(input({ ids: { fastModel: 'auto', qualityModel: QUALITY } }));
    expect(auto.modelId).not.toBe('auto');
    expect(auto).toEqual({ tier: 'quality', rule: 'invalid_routing_id', modelId: QUALITY });
    const both = routeModel(input({ ids: { fastModel: 'auto', qualityModel: 'auto' } }));
    expect(both.modelId).toBe(QUALITY);
  });
});

describe('resolveRequestedModel (D-19, research Pitfall 7)', () => {
  it('keeps an explicit model id, with routing on or off', () => {
    for (const routing of [ON, OFF]) {
      expect(resolveRequestedModel('openai/gpt-4.1-mini', routing)).toEqual({
        modelId: 'openai/gpt-4.1-mini',
        selection: 'explicit',
        routable: false,
      });
    }
  });

  it('resolves auto to the quality model when routing is off', () => {
    expect(resolveRequestedModel('auto', OFF)).toEqual({ modelId: QUALITY, selection: 'auto', routable: false });
  });

  it('resolves auto to the quality model marked routable when routing is auto', () => {
    expect(resolveRequestedModel('auto', ON)).toEqual({ modelId: QUALITY, selection: 'auto', routable: true });
    expect(resolveRequestedModel(' Auto ', ON).routable).toBe(true);
  });

  it('follows the given fallback for an empty request and never returns auto', () => {
    expect(resolveRequestedModel(null, ON, 'openai/gpt-4o-mini')).toEqual({ modelId: 'openai/gpt-4o-mini', selection: 'explicit', routable: false });
    expect(resolveRequestedModel('', OFF, 'openai/gpt-4o-mini').modelId).toBe('openai/gpt-4o-mini');
    expect(resolveRequestedModel('auto', { ...OFF, qualityModel: 'auto' }).modelId).toBe(DEFAULT_ROUTING_QUALITY_MODEL);
    expect(resolveRequestedModel(undefined, ON, 'auto').modelId).toBe(QUALITY);
  });

  it('uses the D-35 defaults when no routing variable is set', () => {
    const routing = loadRagConfig({ RAG_PIPELINE: 'v2', RAG_QUERY_LAYER: 'true' } as Parameters<typeof loadRagConfig>[0]).modelRouting;
    expect(routing.fastModel).toBe('anthropic/claude-haiku-5.5');
    expect(routing.qualityModel).toBe('anthropic/claude-sonnet-5.5');
    expect(routing.mode).toBe('off');
    expect(resolveRequestedModel('auto', routing)).toEqual({ modelId: 'anthropic/claude-sonnet-5.5', selection: 'auto', routable: false });
  });
});

describe('model-router boundary (D-30)', () => {
  it('imports no retrieval, search or embedding code', () => {
    const source = readFileSync(path.resolve(__dirname, '../../src/lib/rag/generation/model-router.ts'), 'utf8');
    const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const specifier of imports) {
      expect(specifier).not.toMatch(/retriev|search|embed|pipeline|backend|rerank|supabase|^@\/lib\/rag$/);
    }
    expect(source).not.toMatch(/generateText|streamText|generateObject/);
  });
});

const MODEL_LIST = JSON.stringify([
  { id: 'openai/gpt-4.1-mini', displayName: 'Synthetic GPT' },
  { id: FAST, displayName: 'Synthetic fast', anthropicId: 'claude-haiku-5-5' },
  { id: QUALITY, displayName: 'Synthetic quality', anthropicId: 'claude-sonnet-5-5' },
]);
const CLAUDE_CONFIG = { citations: false, claudeCitations: true, anthropicApiKey: 'placeholder-key' };
const NO_FACTS = { mcp: false, multiStep: false, webSearch: false, reasoning: false };

function block(alias: string, text: string): ContextBlock {
  return {
    documentId: `doc-${alias}`,
    documentName: 'neutral.md',
    documentVersion: 1,
    chunkIds: [`chunk-${alias}`],
    page: null,
    sectionPath: null,
    title: 'neutral.md',
    text,
    isImage: false,
    alias,
  };
}

describe('citation session final model (P-30)', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.NEXT_PUBLIC_OPENROUTER_MODELS;
    process.env.NEXT_PUBLIC_OPENROUTER_MODELS = MODEL_LIST;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.NEXT_PUBLIC_OPENROUTER_MODELS;
    else process.env.NEXT_PUBLIC_OPENROUTER_MODELS = saved;
    vi.restoreAllMocks();
  });

  function session(modelId: string, routingCandidates?: readonly string[]) {
    return createCitationSession({
      capabilities: { citations: true },
      ragMode: 'strict',
      modelId,
      language: 'en',
      config: CLAUDE_CONFIG,
      facts: NO_FACTS,
      ...(routingCandidates ? { routingCandidates } : {}),
    });
  }

  it('turns the labeler on before retrieval when either routing candidate needs it', () => {
    expect(session('openai/gpt-4.1-mini').labeler).toBeUndefined();
    expect(session('openai/gpt-4.1-mini', ['openai/gpt-4.1-mini', FAST]).labeler).toBeDefined();
    expect(
      preRetrievalCitations({ config: CLAUDE_CONFIG, modelId: 'openai/gpt-4.1-mini', capabilities: { citations: true }, facts: NO_FACTS, candidateModelIds: [QUALITY] }),
    ).toBe(true);
    expect(
      preRetrievalCitations({ config: CLAUDE_CONFIG, modelId: 'openai/gpt-4.1-mini', capabilities: { citations: true }, facts: NO_FACTS, candidateModelIds: [] }),
    ).toBe(false);
  });

  it('switches the strategy to the final model set before attach', () => {
    const routed = session(QUALITY, [FAST, QUALITY]);
    routed.setFinalModel('openai/gpt-4.1-mini');
    routed.attach({ blocks: [block('S1', 'The alpha value is seven.')] });
    expect(routed.strategy).toBeNull();

    const toClaude = session('openai/gpt-4.1-mini', ['openai/gpt-4.1-mini', FAST]);
    toClaude.setFinalModel(FAST);
    toClaude.attach({ blocks: [block('S1', 'The alpha value is seven.')] });
    expect(toClaude.strategy).toBe('claude-citations');
  });

  it('a routed Claude fast model uses the Citations path with its own Anthropic id', () => {
    const routed = session(QUALITY, [FAST, QUALITY]);
    routed.setFinalModel(FAST);
    routed.attach({ blocks: [block('S1', 'The alpha value is seven.')] });
    expect(routed.strategy).toBe('claude-citations');
    expect(routed.finalModel()).toBe(FAST);
  });

  it('keeps the first model when no final model is set', () => {
    const plain = session(QUALITY);
    plain.attach({ blocks: [block('S1', 'The alpha value is seven.')] });
    expect(plain.strategy).toBe('claude-citations');
    expect(plain.finalModel()).toBe(QUALITY);
  });

  it('refuses auto and a change after attach', () => {
    const routed = session(QUALITY, [FAST, QUALITY]);
    expect(() => routed.setFinalModel('auto')).toThrow();
    routed.attach({ blocks: [block('S1', 'The alpha value is seven.')] });
    expect(() => routed.setFinalModel(FAST)).toThrow();
    expect(routed.finalModel()).toBe(QUALITY);
  });
});
