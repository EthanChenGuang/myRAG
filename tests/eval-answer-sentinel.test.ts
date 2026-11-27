import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3CallOptions, LanguageModelV3Content } from '@ai-sdk/provider';
import {
  buildEvalSystemPrompt,
  EVAL_DEFAULT_SYSTEM_PROMPT,
  generateEvalAnswerDetailed,
  setEvalLanguageModelFactory,
} from '@/lib/rag-eval/answer';
import { buildCalculateTool, createCalcTraceHolder, createEnhancedRAGPrompt, readSecurityConfig } from '@/lib/rag';
import { REFERENCE_NOTICE, wrapDocuments } from '@/lib/rag/context/wrap';
import { SystemPromptManager } from '@/lib/system-prompt-manager';

const REPO_ROOT = path.resolve(__dirname, '..');
const chatRoute = fs.readFileSync(path.join(REPO_ROOT, 'src/app/api/chat/route.ts'), 'utf8');
const answerSource = fs.readFileSync(path.join(REPO_ROOT, 'src/lib/rag-eval/answer.ts'), 'utf8');

const evalRoute = fs.readFileSync(path.join(REPO_ROOT, 'src/app/api/internal/rag/run/route.ts'), 'utf8');

const PRE_POST_EXPRESSION = "preContext + '\\n\\nContext:\\n{{context}}\\n\\n' + postContext";

function compact(source: string): string {
  return source.replace(/\s+/g, '');
}

/** D-04, D-07: the chat route appends the answer-rule block to the citation-decorated enhanced prompt. */
const CHAT_COMPOSITION = compact(
  'answerTurn.composeSystemPrompt(citationSession.decorateSystemPrompt(createEnhancedRAGPrompt(ragSystemPrompt, context, ragMode, answerLanguage)),',
);
/** The eval route's decorateSystemPrompt hook: the same composer, after the same citation decoration. */
const EVAL_COMPOSITION = compact(
  'answerTurn.composeSystemPrompt(citationSession ? citationSession.decorateSystemPrompt(prompt) : prompt, answerRuleOptions)',
);

function composesAnswerRules(chatSource: string, evalSource: string): boolean {
  return compact(chatSource).includes(CHAT_COMPOSITION) && compact(evalSource).includes(EVAL_COMPOSITION);
}

function extractDefaultPrompt(source: string): string {
  const marker = 'const defaultSystemPrompt = `';
  const start = source.indexOf(marker);
  if (start === -1) throw new Error('defaultSystemPrompt literal not found in the chat route');
  const bodyStart = start + marker.length;
  const end = source.indexOf('`;', bodyStart);
  if (end === -1) throw new Error('defaultSystemPrompt literal is not terminated');
  return source.slice(bodyStart, end);
}

describe('eval answer prompt assembly stays tied to the chat route', () => {
  test('the default system prompt text is identical', () => {
    expect(EVAL_DEFAULT_SYSTEM_PROMPT).toBe(extractDefaultPrompt(chatRoute));
  });

  test('the pre/post assembly expression appears in both files', () => {
    expect(chatRoute).toContain(PRE_POST_EXPRESSION);
    expect(answerSource).toContain(PRE_POST_EXPRESSION);
  });

  test('the newline unescaping of the three prompt variables appears in both files', () => {
    const unescape = ".replace(/\\\\n/g, '\\n')";
    for (const [source, prefix] of [
      [chatRoute, 'env'],
      [answerSource, 'promptEnv'],
    ] as const) {
      expect(source).toContain(`(${prefix}.RAG_PRE_CONTEXT || '')${unescape}`);
      expect(source).toContain(`(${prefix}.RAG_POST_CONTEXT || '')${unescape}`);
      expect(source).toContain(`${prefix}.RAG_SYSTEM_PROMPT${unescape}`);
    }
  });

  test('ensureContextPlaceholder runs before the enhanced prompt or injectContext', () => {
    for (const source of [chatRoute, answerSource]) {
      const ensure = source.indexOf('SystemPromptManager.ensureContextPlaceholder(ragSystemPrompt)');
      const enhanced = source.indexOf('createEnhancedRAGPrompt(ragSystemPrompt, context, ragMode, answerLanguage)');
      const inject = source.indexOf('SystemPromptManager.injectContext(ragSystemPrompt, context)');
      expect(ensure).toBeGreaterThan(-1);
      expect(enhanced).toBeGreaterThan(ensure);
      expect(inject).toBeGreaterThan(enhanced);
    }
  });

  test('the context-length branch selects the enhanced prompt in both files', () => {
    expect(chatRoute).toContain('if (context.length > 0) {');
    expect(answerSource).toContain('if (context.length > 0) {');
  });

  test('the generation temperature literal matches', () => {
    expect(chatRoute).toContain('temperature: 0.1,');
    expect(answerSource).toContain('temperature: 0.1,');
  });

  describe('Phase 5.2 composition, cap and chain (D-07, D-29, RESEARCH Pitfall 21)', () => {
    test('both paths call the composer seam after the citation decoration', () => {
      expect(composesAnswerRules(chatRoute, evalRoute)).toBe(true);
    });

    test('the check fails when either composer call is removed', () => {
      const chatWithout = chatRoute.replace(/answerTurn\.composeSystemPrompt\(\s*citationSession\.decorateSystemPrompt/g, '(citationSession.decorateSystemPrompt');
      const evalWithout = evalRoute.replace(/answerTurn\.composeSystemPrompt\(citationSession \?/g, '(citationSession ?');
      expect(chatWithout).not.toBe(chatRoute);
      expect(evalWithout).not.toBe(evalRoute);
      expect(composesAnswerRules(chatWithout, evalRoute)).toBe(false);
      expect(composesAnswerRules(chatRoute, evalWithout)).toBe(false);
    });

    test('both paths take the output limit through the same cap helper', () => {
      expect(compact(chatRoute)).toContain(compact('answerTurn.maxOutputTokens(getMaxTokensForModel(safeModelId))'));
      expect(compact(answerSource)).toContain(compact('effectiveMaxOutputTokens(evalModelOutputLimit(generatorModel)'));
      // Phase 5.2.1 D-88: only a fake registry declares another limit; every other id keeps the eval's id rule
      expect(compact(answerSource)).toContain(compact(': maxOutputTokensForModel(modelId);'));
      expect(evalRoute).toContain('answerTurn.decideOutputCap(');
    });

    test('the eval route runs the whole-text twin of the stream chain', () => {
      expect(evalRoute).toContain('applyAnswerPipelineToText(');
    });
  });

  test('the isGPTModel expression matches the chat route', () => {
    const expression = "includes('gpt-4') || modelId.includes('o1') || modelId.includes('chatgpt')";
    expect(answerSource).toContain(expression);
    expect(chatRoute).toContain("model.includes('gpt-4') || model.includes('o1') || model.includes('chatgpt')");
  });

  describe('with RAG_CONTEXT_TAGGING off and on', () => {
    const previous = process.env.RAG_CONTEXT_TAGGING;
    afterEach(() => {
      if (previous === undefined) delete process.env.RAG_CONTEXT_TAGGING;
      else process.env.RAG_CONTEXT_TAGGING = previous;
    });

    function sharedContext(): string {
      const chunk = 'The quillmark relay calibrates its phase offset against the reference beacon.';
      if (!readSecurityConfig().contextTagging) return `=== RELEVANT INFORMATION FROM DOCUMENTS ===\n${chunk}\n=== END OF RELEVANT INFORMATION ===\n`;
      return wrapDocuments([{ id: 'c1', source: 'quillmark-relay.md', text: chunk }]) as string;
    }

    for (const value of [undefined, 'true'] as const) {
      test(`the eval prompt equals the chat route's assembly (RAG_CONTEXT_TAGGING=${value ?? 'unset'})`, () => {
        if (value === undefined) delete process.env.RAG_CONTEXT_TAGGING;
        else process.env.RAG_CONTEXT_TAGGING = value;
        const context = sharedContext();
        const chatTemplate = SystemPromptManager.ensureContextPlaceholder(extractDefaultPrompt(chatRoute));
        for (const ragMode of ['strict', 'balanced', 'flexible'] as const) {
          const evalPrompt = buildEvalSystemPrompt({ context, ragMode, promptEnv: {} });
          expect(evalPrompt).toBe(createEnhancedRAGPrompt(chatTemplate, context, ragMode));
          expect(evalPrompt.split(REFERENCE_NOTICE).length - 1).toBe(value === 'true' ? 1 : 0);
          expect(evalPrompt.split('<documents>').length - 1).toBe(value === 'true' ? 1 : 0);
        }
      });
    }

    test('tagging lives only in the shared assembly: neither file reads the switch', () => {
      for (const source of [chatRoute, answerSource]) {
        expect(source).not.toContain('RAG_CONTEXT_TAGGING');
        expect(source).not.toContain('contextTagging');
      }
    });
  });
});

describe('Phase 5.2.1 calculation tool loop on the eval answer path (D-65, RESEARCH Pattern F, A12)', () => {
  const REQUEST = {
    operands: [
      { name: 'a', value: '2', unit: 'pell', source: { kind: 'question' } },
      { name: 'b', value: '3', unit: 'pell', source: { kind: 'question' } },
    ],
    steps: [{ id: 'total', op: 'add', args: ['a', 'b'], label: 'total' }],
    result: 'total',
  };

  interface Call {
    tools: string[];
    toolChoice: unknown;
    hasToolResult: boolean;
  }

  function scriptedModel(steps: Array<{ text?: string; toolCall?: boolean }>, calls: Call[]) {
    return new MockLanguageModelV3({
      doGenerate: async (options: LanguageModelV3CallOptions) => {
        const index = calls.length;
        calls.push({
          tools: (options.tools ?? []).map((tool) => tool.name),
          toolChoice: options.toolChoice,
          hasToolResult: options.prompt.some((message) => message.role === 'tool'),
        });
        const step = steps[Math.min(index, steps.length - 1)];
        const content: LanguageModelV3Content[] = [];
        if (step.text) content.push({ type: 'text', text: step.text });
        if (step.toolCall) content.push({ type: 'tool-call', toolCallId: `call-${index}`, toolName: 'calculate', input: JSON.stringify(REQUEST) });
        return {
          content,
          finishReason: { unified: step.toolCall ? ('tool-calls' as const) : ('stop' as const), raw: step.toolCall ? 'tool-calls' : 'stop' },
          usage: {
            inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 3, text: 3, reasoning: 0 },
          },
          warnings: [],
        };
      },
    });
  }

  afterEach(() => setEvalLanguageModelFactory(null));

  const base = { query: 'What is 2 pell plus 3 pell?', context: '', ragMode: 'balanced' as const, generatorModel: 'test/eval-model' };

  test('without the calculation input the call offers no tools and makes one step', async () => {
    const calls: Call[] = [];
    setEvalLanguageModelFactory(() => scriptedModel([{ text: 'Five pell.' }], calls));
    const result = await generateEvalAnswerDetailed(base);
    expect(result.text).toBe('Five pell.');
    expect(calls).toHaveLength(1);
    expect(calls[0].tools).toEqual([]);
    expect(calls[0].toolChoice).toBeUndefined();
    expect(result.toolStepEnds).toEqual([]);
    expect(result.usage).toEqual({ input_tokens: 10, output_tokens: 3 });
  });

  test('in tool mode the calculate tool is offered, the holder records the trace and the tool step end anchors it', async () => {
    const calls: Call[] = [];
    setEvalLanguageModelFactory(() => scriptedModel([{ text: 'Adding. ', toolCall: true }, { text: 'The total is 5 pell.' }], calls));
    const holder = createCalcTraceHolder();
    const tool = buildCalculateTool({ aliases: new Set<string>(), holder });
    const result = await generateEvalAnswerDetailed({ ...base, calc: { mode: 'tool', tool, holder } });
    expect(calls).toHaveLength(2);
    expect(calls[0].tools).toEqual(['calculate']);
    expect(calls[1].hasToolResult).toBe(true);
    expect(result.text).toBe('Adding. The total is 5 pell.');
    expect(result.stepTexts).toEqual(['Adding. ', 'The total is 5 pell.']);
    expect(result.toolStepEnds).toEqual(['Adding. '.length]);
    const traces = holder.traces();
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ origin: 'tool', anchor_offset: 'Adding. '.length, result: { status: 'ok', value: '5' } });
    expect(result.usage).toEqual({ input_tokens: 20, output_tokens: 6 });
  });

  test('the tool loop stops after three steps', async () => {
    const calls: Call[] = [];
    setEvalLanguageModelFactory(() => scriptedModel([{ toolCall: true }], calls));
    const holder = createCalcTraceHolder();
    const tool = buildCalculateTool({ aliases: new Set<string>(), holder });
    await generateEvalAnswerDetailed({ ...base, calc: { mode: 'tool', tool, holder } });
    expect(calls).toHaveLength(3);
    expect(holder.traces()).toHaveLength(3);
  });

  test('trailing_block mode offers no tools (the block is extracted from the whole text afterwards)', async () => {
    const calls: Call[] = [];
    setEvalLanguageModelFactory(() => scriptedModel([{ text: 'The total is 5 pell.' }], calls));
    const result = await generateEvalAnswerDetailed({ ...base, calc: { mode: 'trailing_block', holder: createCalcTraceHolder() } });
    expect(calls).toHaveLength(1);
    expect(calls[0].tools).toEqual([]);
    expect(result.text).toBe('The total is 5 pell.');
  });

  test('the eval loop allows three steps and the chat route offers the same tool builder', () => {
    expect(compact(answerSource)).toContain(compact('stopWhen: stepCountIs(EVAL_CALC_MAX_STEPS)'));
    expect(answerSource).toContain('const EVAL_CALC_MAX_STEPS = 3;');
    expect(compact(chatRoute)).toContain(compact('buildCalculateTool({ aliases: calcOffer.aliases, holder: calcHolder })'));
  });

  test('the eval route offers, extracts and checks the calculation with the chat route\'s pieces', () => {
    expect(compact(evalRoute)).toContain(compact('buildCalculateTool({ aliases: calcOffer.aliases, holder: calcHolder })'));
    for (const source of [chatRoute, evalRoute]) {
      expect(source).toContain('mayOfferCalc(');
      expect(source).toContain('shouldOfferCalcTool(');
      expect(source).toContain('turnCanUseTools(');
      expect(source).toContain('calcBlock: { onTrace: calcHolder.recordBlock, stripMarkers: calcOffer.stripMarkers }');
    }
    expect(evalRoute).toContain('runCalcChecks(');
    expect(evalRoute).toContain('calc_observed');
  });
});
