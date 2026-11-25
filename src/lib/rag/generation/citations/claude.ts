import { createAnthropic, type AnthropicProvider } from '@ai-sdk/anthropic';
import { streamText, type ModelMessage, type StreamTextResult, type ToolSet } from 'ai';
import type { CitationRecord } from '@/lib/rag-eval/contracts.generated';
import type { AliasMap } from './blocks';

export function createClaudeProvider(options: { apiKey: string; baseUrl?: string | null; fetch?: typeof fetch }): AnthropicProvider {
  return createAnthropic({ apiKey: options.apiKey, baseURL: options.baseUrl ?? undefined, fetch: options.fetch });
}

export type ClaudeReasoningEligibility = { eligible: true } | { eligible: false; reason: 'reasoning_unsupported' };

export function claudeReasoningEligibility(_anthropicId: string): ClaudeReasoningEligibility {
  return { eligible: true };
}

export interface ClaudeCitationRequestInput {
  provider: AnthropicProvider;
  aliasMap: AliasMap;
  system: string;
  history: ModelMessage[];
  question: string;
  anthropicId: string;
  reasoning?: boolean;
  abortSignal?: AbortSignal;
}

export function buildClaudeCitationRequest(input: ClaudeCitationRequestInput) {
  return {
    model: input.provider(input.anthropicId),
    system: input.system,
    messages: [...input.history, { role: 'user' as const, content: input.question }] as ModelMessage[],
    temperature: 0.1,
    maxRetries: 2,
  };
}

export interface ClaudeCitationStream {
  result: StreamTextResult<ToolSet, never>;
  citations(): { citations: CitationRecord[]; invalidCitations: number };
}

export function startClaudeCitationStream(input: ClaudeCitationRequestInput & { tools?: ToolSet }): ClaudeCitationStream {
  const result = streamText(buildClaudeCitationRequest(input)) as unknown as StreamTextResult<ToolSet, never>;
  return { result, citations: () => ({ citations: [], invalidCitations: 0 }) };
}
