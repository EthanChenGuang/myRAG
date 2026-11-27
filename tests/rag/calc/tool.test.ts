import { generateText, stepCountIs, tool, type LanguageModel } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3CallOptions } from '@ai-sdk/provider';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v3';
import { CalcResultSchema, CalcTraceSchema, type CalcResult } from '@/lib/rag-eval/contracts.generated';
import { createCalcTraceHolder } from '@/lib/rag/calc/trace-holder';
import { buildCalculateTool, CALCULATE_TOOL_NAME, isServerCalculateTool } from '@/lib/rag/generation/calc-tool';

const BLOCKS: Record<string, string> = {
  S1: 'The synthetic register lists a base amount of 120 units for each item.',
  S2: 'A separate synthetic note adds 30 units to every item.',
};
const ALIASES = new Set(Object.keys(BLOCKS));

const REQUEST = {
  operands: [
    { name: 'base', value: '120', unit: 'units', source: { kind: 'chunk', alias: 'S1' } },
    { name: 'extra', value: '30', unit: 'units', source: { kind: 'chunk', alias: 'S2' } },
  ],
  steps: [{ id: 'total', op: 'add', args: ['base', 'extra'] }],
  result: 'total',
};

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function scripted(request: unknown, prompts: LanguageModelV3CallOptions['prompt'][]): LanguageModel {
  let call = 0;
  return new MockLanguageModelV3({
    doGenerate: async (options) => {
      prompts.push(options.prompt);
      call += 1;
      if (call === 1) {
        return {
          content: [{ type: 'tool-call' as const, toolCallId: 'call-1', toolName: CALCULATE_TOOL_NAME, input: JSON.stringify(request) }],
          finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
          usage: USAGE,
          warnings: [],
        };
      }
      return { content: [{ type: 'text' as const, text: 'The total is 150 units.' }], finishReason: { unified: 'stop' as const, raw: 'stop' }, usage: USAGE, warnings: [] };
    },
  }) as unknown as LanguageModel;
}

function toolResultsIn(prompt: LanguageModelV3CallOptions['prompt']): unknown[] {
  const out: unknown[] = [];
  for (const message of prompt) {
    if (message.role !== 'tool') continue;
    for (const part of message.content) if (part.type === 'tool-result') out.push(part.output);
  }
  return out;
}

describe('buildCalculateTool (D-65, D-66)', () => {
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => log.mockRestore());

  it('runs inside a generateText tool loop and the next step sees the CalcResult', async () => {
    const holder = createCalcTraceHolder();
    const prompts: LanguageModelV3CallOptions['prompt'][] = [];
    const result = await generateText({
      model: scripted(REQUEST, prompts),
      prompt: 'What is the total per item?',
      tools: { [CALCULATE_TOOL_NAME]: buildCalculateTool({ aliases: ALIASES, holder }) },
      stopWhen: stepCountIs(3),
    });
    expect(result.text).toBe('The total is 150 units.');
    expect(prompts).toHaveLength(2);
    const outputs = toolResultsIn(prompts[1]!);
    expect(outputs).toHaveLength(1);
    expect(JSON.stringify(outputs[0])).toContain('"value":"150"');

    const traces = holder.traces();
    expect(traces).toHaveLength(1);
    expect(traces[0]!.origin).toBe('tool');
    expect(traces[0]!.anchor_offset).toBeNull();
    expect(traces[0]!.request).toEqual(REQUEST);
    expect(traces[0]!.result?.status).toBe('ok');
    expect(traces[0]!.result?.value).toBe('150');
    expect(CalcTraceSchema.safeParse(traces[0]).success).toBe(true);
  });

  it('an alias outside this request is rejected with unknown_source and nothing throws into the loop', async () => {
    const holder = createCalcTraceHolder();
    const bad = { ...REQUEST, operands: [REQUEST.operands[0], { ...REQUEST.operands[1], source: { kind: 'chunk', alias: 'S9' } }] };
    const prompts: LanguageModelV3CallOptions['prompt'][] = [];
    const result = await generateText({
      model: scripted(bad, prompts),
      prompt: 'question',
      tools: { [CALCULATE_TOOL_NAME]: buildCalculateTool({ aliases: ALIASES, holder }) },
      stopWhen: stepCountIs(3),
    });
    expect(result.text).toBe('The total is 150 units.');
    const [trace] = holder.traces();
    expect(trace?.result?.status).toBe('rejected');
    expect(trace?.result?.reject_reason).toBe('unknown_source');
  });

  it('execute returns a schema-valid CalcResult without any block text', async () => {
    const holder = createCalcTraceHolder();
    const built = buildCalculateTool({ aliases: ALIASES, holder });
    const out = (await built.execute!(REQUEST as never, { toolCallId: 't', messages: [] })) as CalcResult;
    expect(CalcResultSchema.safeParse(out).success).toBe(true);
    expect(out.value).toBe('150');
    const serialized = JSON.stringify(out);
    for (const text of Object.values(BLOCKS)) {
      expect(serialized).not.toContain(text);
      for (const word of text.split(/\s+/).filter((w) => w.length > 6)) expect(serialized).not.toContain(word);
    }
    expect(Object.keys(out).sort()).toEqual(['reject_reason', 'status', 'steps', 'unit', 'value']);
  });

  it('logs at most one [Calc] line with status and reason, never operands', async () => {
    const holder = createCalcTraceHolder();
    await buildCalculateTool({ aliases: ALIASES, holder }).execute!(REQUEST as never, { toolCallId: 't', messages: [] });
    const lines = log.mock.calls.filter((call: unknown[]) => call[0] === '[Calc]');
    expect(lines).toHaveLength(1);
    expect(lines[0]![1]).toEqual({ origin: 'tool', status: 'ok', reason: null });
    expect(JSON.stringify(log.mock.calls)).not.toContain('120');
  });

  it('has a neutral description and the generated CalcRequest schema', () => {
    const built = buildCalculateTool({ aliases: ALIASES, holder: createCalcTraceHolder() });
    expect(built.description).toMatch(/^Evaluate a structured calculation exactly/);
    expect(built.description).not.toMatch(/\d/);
    expect(CALCULATE_TOOL_NAME).toBe('calculate');
  });

  it('isServerCalculateTool recognises only tools this module built', () => {
    const built = buildCalculateTool({ aliases: ALIASES, holder: createCalcTraceHolder() });
    const impostor = tool({ description: 'calculate', inputSchema: z.object({}), execute: async () => ({}) });
    expect(isServerCalculateTool(built)).toBe(true);
    expect(isServerCalculateTool(impostor)).toBe(false);
    expect(isServerCalculateTool({ ...built })).toBe(false);
    expect(isServerCalculateTool(undefined)).toBe(false);
    expect(isServerCalculateTool('calculate')).toBe(false);
  });
});

describe('createCalcTraceHolder', () => {
  const okResult = { status: 'ok' as const, value: '1', unit: null, reject_reason: null, steps: [] };

  it('records tool traces and anchors them at the next markToolCall only', () => {
    const holder = createCalcTraceHolder();
    holder.record({ origin: 'tool', request: REQUEST as never, result: okResult, anchor_offset: null });
    holder.markToolCall(42);
    holder.record({ origin: 'tool', request: REQUEST as never, result: okResult, anchor_offset: null });
    holder.markToolCall(90);
    expect(holder.traces().map((t) => t.anchor_offset)).toEqual([42, 90]);
  });

  it('ignores an invalid offset', () => {
    const holder = createCalcTraceHolder();
    holder.record({ origin: 'tool', request: REQUEST as never, result: okResult, anchor_offset: null });
    holder.markToolCall(-1);
    holder.markToolCall(1.5);
    expect(holder.traces().map((t) => t.anchor_offset)).toEqual([null]);
  });

  it('recordBlock keeps parsed blocks as trailing_block traces and invalid markers apart, also when passed unbound', () => {
    const holder = createCalcTraceHolder();
    const { recordBlock } = holder;
    recordBlock({ origin: 'trailing_block', request: REQUEST as never, anchor_offset: 7 });
    recordBlock({ invalid: 'json', anchor_offset: 12 });
    const traces = holder.traces();
    expect(traces).toHaveLength(1);
    expect(traces[0]).toEqual({ origin: 'trailing_block', request: REQUEST, anchor_offset: 7, result: null });
    expect(holder.invalid()).toEqual([{ invalid: 'json', anchor_offset: 12 }]);
  });

  it('returns copies, so a caller cannot change what the holder recorded', () => {
    const holder = createCalcTraceHolder();
    holder.recordBlock({ invalid: 'json', anchor_offset: null });
    holder.invalid().push({ invalid: 'other', anchor_offset: null });
    holder.traces().push({ origin: 'tool', request: REQUEST as never, result: null, anchor_offset: null });
    expect(holder.invalid()).toHaveLength(1);
    expect(holder.traces()).toHaveLength(0);
  });
});
