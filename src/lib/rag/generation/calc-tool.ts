import { tool, type Tool } from 'ai';
import { CalcRequestSchema, type CalcRequest, type CalcResult } from '@/lib/rag-eval/contracts.generated';
import type { CalcTraceHolder } from '../calc/trace-holder';

export const CALCULATE_TOOL_NAME = 'calculate';

export interface CalculateToolOptions {
  aliases: ReadonlySet<string>;
  holder: CalcTraceHolder;
}

export function buildCalculateTool(_options: CalculateToolOptions): Tool<CalcRequest, CalcResult> {
  return tool({
    description: '',
    inputSchema: CalcRequestSchema,
    execute: async () => ({ status: 'ok', value: null, unit: null, reject_reason: null }) as CalcResult,
  });
}

export function isServerCalculateTool(_candidate: unknown): boolean {
  return false;
}
