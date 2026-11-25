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
  /** The question carries image parts; the direct request sends the question as text only. */
  attachments?: boolean;
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
  | 'attachments'
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
export function claudeTurnEligibility(input: ClaudeTurnEligibilityInput): ClaudeTurnEligibility {
  const { config, facts } = input;
  if (config.claudeCitations !== true) return { eligible: false, reason: 'switch_off' };
  if (!config.anthropicApiKey) return { eligible: false, reason: 'no_api_key' };
  const anthropicId = anthropicIdFor(input.modelId, input.modelSource);
  if (!anthropicId) return { eligible: false, reason: 'no_anthropic_id' };
  if (input.capabilities?.citations !== true) return { eligible: false, reason: 'no_capability' };
  if (input.ragMode === 'bypass' || input.aliasCount <= 0) return { eligible: false, reason: 'no_knowledge_context' };
  if (facts.mcp) return { eligible: false, reason: 'mcp' };
  if (facts.multiStep) return { eligible: false, reason: 'multi_step' };
  if (facts.webSearch && !CLAUDE_WEB_SEARCH_ELIGIBLE) return { eligible: false, reason: 'web_search' };
  if (facts.attachments) return { eligible: false, reason: 'attachments' };
  if (facts.reasoning && !claudeReasoningEligibility(anthropicId).eligible) {
    return { eligible: false, reason: 'reasoning_unsupported' };
  }
  return { eligible: true, anthropicId };
}

const NO_FACTS: ClaudeTurnFacts = { mcp: false, multiStep: false, webSearch: false, reasoning: false };

/** True when some strategy could use labelled blocks, so the labeler runs only then. */
export function preRetrievalCitations(input: {
  config: CitationStrategyConfig;
  modelId: string;
  capabilities: { citations: boolean } | null | undefined;
  ragMode?: CitationRagMode;
  facts?: ClaudeTurnFacts;
  modelSource?: Record<string, string | undefined>;
}): boolean {
  if (input.capabilities?.citations !== true || input.ragMode === 'bypass') return false;
  if (input.config.citations) return true;
  return claudeTurnEligibility({
    modelId: input.modelId,
    capabilities: input.capabilities,
    ragMode: input.ragMode ?? 'strict',
    aliasCount: 1,
    facts: input.facts ?? NO_FACTS,
    config: input.config,
    modelSource: input.modelSource,
  }).eligible;
}

/** The only place that decides which citation strategy a turn uses. */
export function selectCitationStrategy(input: {
  modelId: string;
  turn: CitationTurn;
  config: CitationStrategyConfig;
  modelSource?: Record<string, string | undefined>;
}): CitationStrategyId | null {
  const { turn, config } = input;
  if (!turn.capabilities.citations) return null;
  if (turn.ragMode === 'bypass') return null;
  if (turn.aliasCount <= 0) return null;
  if (
    turn.facts &&
    claudeTurnEligibility({
      modelId: input.modelId,
      capabilities: turn.capabilities,
      ragMode: turn.ragMode,
      aliasCount: turn.aliasCount,
      facts: turn.facts,
      config,
      modelSource: input.modelSource,
    }).eligible
  ) {
    return 'claude-citations';
  }
  return config.citations ? 'chunk-alias' : null;
}
