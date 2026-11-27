import { tool, type Tool } from 'ai';
import { CalcRequestSchema, type CalcRequest, type CalcResult } from '@/lib/rag-eval/contracts.generated';
import { evaluateCalc } from '../calc/evaluate';
import type { CalcTraceHolder } from '../calc/trace-holder';

export const CALCULATE_TOOL_NAME = 'calculate';

const DESCRIPTION =
  'Evaluate a structured calculation exactly: declare each operand with its value, unit and source (the question, or a ' +
  'context block by its alias), then list the steps, each naming its operation and the operands or earlier steps it uses, ' +
  'and name the step that is the result. Take every value and rule from the question or a cited passage. Returns the ' +
  'value of every step and the result, or a rejection reason.';

export interface CalculateToolOptions {
  /** The context-block aliases of this request; a chunk operand must name one of them. */
  aliases: ReadonlySet<string>;
  holder: CalcTraceHolder;
}

const BUILT = new WeakSet<object>();

/** D-65, D-66, D-70: the one calculate tool for chat, embed, eval and voice; it holds no domain knowledge. */
export function buildCalculateTool(options: CalculateToolOptions): Tool<CalcRequest, CalcResult> {
  const aliases = new Set(options.aliases);
  const built = tool({
    description: DESCRIPTION,
    inputSchema: CalcRequestSchema,
    execute: async (input: CalcRequest): Promise<CalcResult> => {
      const result = evaluateCalc(input, { aliases });
      try {
        options.holder.record({ origin: 'tool', request: input, result, anchor_offset: null });
      } catch {
        // the holder never throws; a failure here must not reach the stream
      }
      console.log('[Calc]', { origin: 'tool', status: result.status, reason: result.reject_reason });
      return result;
    },
  });
  BUILT.add(built);
  return built;
}

/** Identity check: an MCP or other tool that only shares the name is never treated as server-executed (T-05.2.1-17). */
export function isServerCalculateTool(candidate: unknown): boolean {
  return typeof candidate === 'object' && candidate !== null && BUILT.has(candidate);
}
