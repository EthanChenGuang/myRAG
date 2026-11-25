import type { CitationRecord } from '@/lib/rag-eval/contracts.generated';
import type { GenerationConfig } from '../config';
import { claudeReasoningEligibility } from './claude';
import { anthropicIdFor } from './models';

export type CitationStrategyId = CitationRecord['strategy'];

export type CitationRagMode = 'strict' | 'balanced' | 'flexible' | 'bypass';

/** Facts about the turn that decide the direct Claude path; all known before retrieval. */
export interface ClaudeTurnFacts {
  /** An MCP tool is planned for this turn or awaits approval. */
  mcp: boolean;
  multiStep: boolean;
  webSearch: boolean;
  /** The user asked for reasoning on this turn. */
  reasoning: boolean;
}

export interface CitationTurn {
  capabilities: { citations: boolean };
  ragMode: CitationRagMode;
  /** Number of aliased blocks in this request's context. */
  aliasCount: number;
  /** Absent: the direct Claude path is not considered. */
  facts?: ClaudeTurnFacts;
}

export type CitationStrategyConfig = Pick<GenerationConfig, 'citations'> &
  Partial<Pick<GenerationConfig, 'claudeCitations' | 'anthropicApiKey'>>;

export type ClaudeIneligibleReason =
  | 'switch_off'
  | 'no_api_key'
  | 'no_anthropic_id'
  | 'no_capability'
  | 'no_knowledge_context'
  | 'mcp'
  | 'multi_step'
  | 'web_search'
  | 'reasoning_unsupported';

export type ClaudeTurnEligibility =
  | { eligible: true; anthropicId: string }
  | { eligible: false; reason: ClaudeIneligibleReason };

/**
 * webSearch turns stay on the OpenRouter path (D-10). The recorded-shape fixture shows a tool call next
 * to citations, but only the live spike in plan 05-26 may open this, by recording real coexistence.
 */
export const CLAUDE_WEB_SEARCH_ELIGIBLE = false;

/** What the session needs from a strategy; both strategies normalize to CitationRecord. */
export interface CitationStrategy {
  readonly id: CitationStrategyId;
  decorateSystemPrompt(prompt: string): string;
}

export interface ClaudeTurnEligibilityInput {
  modelId: string;
  capabilities: { citations: boolean } | null | undefined;
  ragMode: CitationRagMode;
  aliasCount: number;
  facts: ClaudeTurnFacts;
  config: CitationStrategyConfig;
  modelSource?: Record<string, string | undefined>;
}

/** D-10: the single eligibility check for the direct Claude Citations path. */
export function claudeTurnEligibility(_input: ClaudeTurnEligibilityInput): ClaudeTurnEligibility {
  void claudeReasoningEligibility;
  void anthropicIdFor;
  return { eligible: false, reason: 'switch_off' };
}

/** True when some strategy could use labelled blocks, so the labeler runs only then. */
export function preRetrievalCitations(_input: {
  config: CitationStrategyConfig;
  modelId: string;
  capabilities: { citations: boolean } | null | undefined;
  ragMode?: CitationRagMode;
  facts?: ClaudeTurnFacts;
  modelSource?: Record<string, string | undefined>;
}): boolean {
  return false;
}

/** The only place that decides which citation strategy a turn uses. */
export function selectCitationStrategy(input: {
  modelId: string;
  turn: CitationTurn;
  config: CitationStrategyConfig;
  modelSource?: Record<string, string | undefined>;
}): CitationStrategyId | null {
  const { turn, config } = input;
  if (!config.citations) return null;
  if (!turn.capabilities.citations) return null;
  if (turn.ragMode === 'bypass') return null;
  if (turn.aliasCount <= 0) return null;
  return 'chunk-alias';
}
