import { describe, expect, it } from 'vitest';
import { countContextTokens } from '@/lib/rag/context/budget';
import {
  assertQuestionLast,
  finalizePromptBudget,
  groupHistoryTurns,
  planPromptBudget,
  PromptOrderError,
  type BudgetMessage,
  type PromptBudgetInput,
} from '@/lib/rag/context/prompt-budget';
import { parsePromptBudgetConfig, parseTokenizerCalibration } from '@/lib/rag/context/prompt-budget-config';
import { fixedText } from '@/lib/rag/lang/texts';
import { PromptBudgetTraceSchema } from '@/lib/rag-eval/contracts.generated';
import rawBudget from '../../../config/rag/prompt-budget.json';
import rawCalibration from '../../../eval/config/tokenizer-calibration.json';

const CONFIG = parsePromptBudgetConfig(rawBudget);
const UNIT_CALIBRATION = parseTokenizerCalibration({
  ...rawCalibration,
  families: [{ family: 'fixture', factor: 1, quantile: 1, samples: 1, source: 'measured', run_ids: ['unit'] }],
});
const byLength = (text: string) => text.length;
const chars = (n: number, c = 'x') => c.repeat(n);

function turn(userChars: number, assistantChars: number): BudgetMessage[] {
  return [
    { role: 'user', content: chars(userChars, 'u') },
    { role: 'assistant', content: chars(assistantChars, 'a') },
  ];
}

function input(overrides: Partial<PromptBudgetInput> = {}): PromptBudgetInput {
  return {
    window: 8000,
    family: 'fixture',
    parts: { system: chars(500), rules: chars(500), tools: chars(500), question: chars(500, 'q') },
    history: [...turn(500, 500), ...turn(500, 500), ...turn(500, 500)],
    answerReserve: 1000,
    documentTarget: 3000,
    config: CONFIG,
    calibration: UNIT_CALIBRATION,
    count: byLength,
    ...overrides,
  };
}

describe('groupHistoryTurns', () => {
  it('groups whole turns, keeping a tool call and its result with their user message', () => {
    const history: BudgetMessage[] = [
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'useDocument', input: {} }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'useDocument', output: { type: 'text', value: 'r' } }] },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second question' },
      { role: 'assistant', content: 'second answer' },
    ];
    const turns = groupHistoryTurns(history);
    expect(turns.map((t) => t.length)).toEqual([4, 2]);
    expect(turns[0][2].role).toBe('tool');
  });

  it('messages before the first user message form their own turn', () => {
    const turns = groupHistoryTurns([{ role: 'assistant', content: 'greeting' }, ...turn(1, 1)]);
    expect(turns.map((t) => t.length)).toEqual([1, 2]);
    expect(groupHistoryTurns([])).toEqual([]);
  });
});

describe('planPromptBudget', () => {
  it('drops the two oldest turns to give documents their target', () => {
    const plan = planPromptBudget(input());
    expect(plan.status).toBe('ok');
    expect(plan.documentBudget).toBe(3000);
    expect(plan.trace.dropped_history_turns).toBe(2);
    expect(plan.keptHistory).toEqual(input().history.slice(4));
    expect(plan.trace.parts).toEqual({ system: 500, rules: 500, tools: 500, history: 1000, question: 500, documents: 3000, reserve: 1000 });
    expect(plan.trace.window).toBe(8000);
    expect(plan.trace.window_source).toBe('model');
    expect(plan.trace.context_length_unknown).toBe(false);
    expect(plan.trace.near_limit).toBe(false);
    expect(plan.standaloneNote).toBeNull();
    expect(plan.trace.standalone_kept).toBe(false);
    expect(PromptBudgetTraceSchema.safeParse(plan.trace).success).toBe(true);
  });

  it('drops all history before reducing the documents, even when the target cannot be met', () => {
    const plan = planPromptBudget(input({ documentTarget: 6000 }));
    expect(plan.status).toBe('ok');
    expect(plan.trace.dropped_history_turns).toBe(3);
    expect(plan.keptHistory).toEqual([]);
    expect(plan.documentBudget).toBe(4344);
    expect(plan.trace.near_limit).toBe(true);
  });

  it('keeps all history when the documents already fit', () => {
    const plan = planPromptBudget(input({ documentTarget: 1000 }));
    expect(plan.trace.dropped_history_turns).toBe(0);
    expect(plan.keptHistory).toHaveLength(6);
    expect(plan.documentBudget).toBe(1000);
  });

  it('drops a tool call and its tool result together with their turn', () => {
    const toolTurn: BudgetMessage[] = [
      { role: 'user', content: chars(400, 'u') },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'webSearch', input: { q: 'x' } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'webSearch', output: { type: 'text', value: 'r' } }] },
      { role: 'assistant', content: chars(400, 'a') },
    ];
    const plan = planPromptBudget(input({ history: [...toolTurn, ...turn(500, 500)], documentTarget: 3344 }));
    expect(plan.trace.dropped_history_turns).toBe(1);
    expect(plan.keptHistory.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(plan.keptHistory.some((m) => m.role === 'tool')).toBe(false);
  });

  it('uses the default window with the unknown flag when the window is not known', () => {
    const plan = planPromptBudget(input({ window: null }));
    expect(plan.trace.window).toBe(16384);
    expect(plan.trace.window_source).toBe('default');
    expect(plan.trace.context_length_unknown).toBe(true);
    expect(plan.trace.dropped_history_turns).toBe(0);
  });

  it('is exceeded when the fixed parts, the question and the reserve do not fit, without computing history or documents', () => {
    const plan = planPromptBudget(
      input({ parts: { system: chars(6000), rules: '', tools: '', question: chars(1500, 'q') } }),
    );
    expect(plan.status).toBe('exceeded');
    expect(plan.trace.status).toBe('exceeded');
    expect(plan.documentBudget).toBe(0);
    expect(plan.keptHistory).toEqual([]);
    expect(plan.trace.parts.history).toBe(0);
    expect(plan.trace.parts.documents).toBe(0);
    expect(plan.trace.dropped_history_turns).toBe(0);
    expect(plan.trace.near_limit).toBe(true);
  });

  it('never trims the question', () => {
    const question = chars(3000, 'q');
    const plan = planPromptBudget(input({ parts: { system: chars(500), rules: '', tools: '', question }, documentTarget: 6000 }));
    expect(plan.trace.parts.question).toBe(3000);
    expect(plan.status).toBe('ok');
  });

  it('reports near_limit once the planned total reaches the ratio of the window', () => {
    expect(planPromptBudget(input({ history: [], documentTarget: 4200 })).trace.near_limit).toBe(true);
    expect(planPromptBudget(input({ history: [], documentTarget: 4199 })).trace.near_limit).toBe(false);
  });

  it('keeps the condensed standalone query as one labelled note when turns are dropped', () => {
    const standalone = chars(50, 's');
    const note = `${fixedText('labels.condensed_question', 'en')}: ${standalone}`;
    const plan = planPromptBudget(input({ standaloneQuery: standalone, answerLanguage: 'en' }));
    expect(plan.standaloneNote).toBe(note);
    expect(plan.trace.standalone_kept).toBe(true);
    expect(plan.trace.dropped_history_turns).toBe(2);
    expect(plan.trace.parts.history).toBe(1000 + note.length);
    expect(plan.documentBudget).toBe(3000);
  });

  it('adds no note when no turn is dropped', () => {
    const plan = planPromptBudget(input({ standaloneQuery: 'standalone', documentTarget: 1000 }));
    expect(plan.standaloneNote).toBeNull();
    expect(plan.trace.standalone_kept).toBe(false);
  });

  it('drops the note last, after every turn, when the documents still lack their target', () => {
    const plan = planPromptBudget(input({ standaloneQuery: chars(50, 's'), documentTarget: 6000 }));
    expect(plan.keptHistory).toEqual([]);
    expect(plan.standaloneNote).toBeNull();
    expect(plan.trace.standalone_kept).toBe(false);
    expect(plan.documentBudget).toBe(4344);
  });

  it('adds the MCP tool reserve to the tools part when MCP is on for the request', () => {
    const plan = planPromptBudget(input({ mcpToolReserve: true, documentTarget: 1000 }));
    expect(plan.trace.parts.tools).toBe(500 + CONFIG.mcp_tool_reserve);
  });

  it('counts tool schemas on their JSON serialization', () => {
    const tools = { useDocument: { description: 'd', inputSchema: { type: 'object' } } };
    const plan = planPromptBudget(input({ parts: { system: '', rules: '', tools, question: 'q' }, history: [] }));
    expect(plan.trace.parts.tools).toBe(JSON.stringify(tools).length);
  });

  it('estimates with the cl100k counter times the family factor and records the estimator', () => {
    const calibration = parseTokenizerCalibration({
      ...rawCalibration,
      families: [{ family: 'fixture', factor: 1.5, quantile: 0.95, samples: 2, source: 'measured', run_ids: ['r'] }],
    });
    const system = 'Answer from the documents below and cite them.';
    const plan = planPromptBudget({
      ...input({ calibration, history: [], documentTarget: 1000 }),
      count: undefined,
      parts: { system, rules: '', tools: '', question: 'What is the total?' },
    });
    expect(plan.trace.parts.system).toBe(Math.ceil(countContextTokens(system) * 1.5));
    expect(plan.trace.estimator).toEqual({ encoding: 'cl100k_base', family: 'fixture', factor: 1.5, factor_source: 'measured' });
    expect(plan.trace.estimated_raw_total).toBe(countContextTokens(system) + countContextTokens('What is the total?'));

    const fallback = planPromptBudget({ ...input({ family: 'unrecorded', history: [] }), count: undefined });
    expect(fallback.trace.estimator).toMatchObject({ family: 'unrecorded', factor: 1.25, factor_source: 'default' });
  });

  it('records the overflow mode, truncate by default', () => {
    expect(planPromptBudget(input()).trace.overflow_mode).toBe('truncate');
    expect(planPromptBudget(input({ overflowMode: 'refine' })).trace.overflow_mode).toBe('refine');
  });
});

describe('finalizePromptBudget', () => {
  it('confirms a built request within the window and records the dropped documents', () => {
    const plan = planPromptBudget(input());
    const result = finalizePromptBudget(plan, { builtParts: { documents: chars(3000, 'd') }, droppedDocuments: 2 });
    expect(result.status).toBe('ok');
    expect(result.action).toBe('confirmed');
    expect(result.keptHistory).toEqual(plan.keptHistory);
    expect(result.trace.dropped_documents).toBe(2);
    expect(result.trace.parts.documents).toBe(3000);
  });

  it('drops one more turn when the MCP schemas turn out larger than planned', () => {
    const plan = planPromptBudget(input());
    const result = finalizePromptBudget(plan, {
      builtParts: { tools: chars(500 + 1500), documents: chars(2000, 'd') },
      droppedDocuments: 0,
    });
    expect(result.status).toBe('ok');
    expect(result.action).toBe('dropped_history');
    expect(result.keptHistory).toEqual([]);
    expect(result.trace.dropped_history_turns).toBe(3);
    expect(result.trace.parts.tools).toBe(2000);
  });

  it('is exceeded when no turn is left to drop and the request is still over the window', () => {
    const plan = planPromptBudget(input());
    const result = finalizePromptBudget(plan, {
      builtParts: { tools: chars(500 + 3000), documents: chars(2000, 'd') },
      droppedDocuments: 0,
    });
    expect(result.status).toBe('exceeded');
    expect(result.action).toBe('exceeded');
    expect(result.trace.status).toBe('exceeded');
  });

  it('keeps an exceeded plan exceeded', () => {
    const plan = planPromptBudget(input({ parts: { system: chars(9000), rules: '', tools: '', question: 'q' } }));
    expect(finalizePromptBudget(plan, { builtParts: {}, droppedDocuments: 0 }).status).toBe('exceeded');
  });
});

describe('assertQuestionLast', () => {
  const question = 'What is the remainder?';

  it('passes when the question is the last message', () => {
    expect(() =>
      assertQuestionLast(
        [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'earlier' },
          { role: 'assistant', content: 'reply' },
          { role: 'user', content: question },
        ],
        question,
      ),
    ).not.toThrow();
  });

  it("passes when only this turn's tool call and tool result follow the question", () => {
    expect(() =>
      assertQuestionLast(
        [
          { role: 'user', content: [{ type: 'text', text: question }] },
          { role: 'assistant', content: [{ type: 'text', text: 'checking' }, { type: 'tool-call', toolCallId: 'c', toolName: 'calculate', input: {} }] },
          { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c', toolName: 'calculate', output: { type: 'text', value: '1' } }] },
        ],
        question,
      ),
    ).not.toThrow();
  });

  it('throws when another user message follows the question', () => {
    expect(() =>
      assertQuestionLast([{ role: 'user', content: question }, { role: 'user', content: 'other' }], question),
    ).toThrow(PromptOrderError);
  });

  it('throws when an assistant text without a tool call follows the question', () => {
    expect(() =>
      assertQuestionLast([{ role: 'user', content: question }, { role: 'assistant', content: 'answer' }], question),
    ).toThrow(PromptOrderError);
  });

  it('throws when the question is missing', () => {
    expect(() => assertQuestionLast([{ role: 'user', content: 'something else' }], question)).toThrow(PromptOrderError);
    expect(() => assertQuestionLast([], question)).toThrow(PromptOrderError);
    expect(() => assertQuestionLast([{ role: 'user', content: question }], '  ')).toThrow(PromptOrderError);
  });

  it('the error carries a code and no message text', () => {
    try {
      assertQuestionLast([{ role: 'user', content: question }, { role: 'user', content: 'secret other text' }], question);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PromptOrderError);
      expect((error as PromptOrderError).code).toBe('question_not_last');
      expect((error as Error).message).not.toContain('secret');
    }
  });
});
