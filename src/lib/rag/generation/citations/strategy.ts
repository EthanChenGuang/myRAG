import type { CitationRecord } from '@/lib/rag-eval/contracts.generated';
import type { GenerationConfig } from '../config';

export type CitationStrategyId = CitationRecord['strategy'];

export type CitationRagMode = 'strict' | 'balanced' | 'flexible' | 'bypass';

export interface CitationTurn {
  capabilities: { citations: boolean };
  ragMode: CitationRagMode;
  /** Number of aliased blocks in this request's context. */
  aliasCount: number;
}

/** What the session needs from a strategy; both strategies normalize to CitationRecord. */
export interface CitationStrategy {
  readonly id: CitationStrategyId;
  decorateSystemPrompt(prompt: string): string;
}

/** The only place that decides which citation strategy a turn uses. */
export function selectCitationStrategy(input: {
  modelId: string;
  turn: CitationTurn;
  config: Pick<GenerationConfig, 'citations'>;
}): CitationStrategyId | null {
  const { turn, config } = input;
  if (!config.citations) return null;
  if (!turn.capabilities.citations) return null;
  if (turn.ragMode === 'bypass') return null;
  if (turn.aliasCount <= 0) return null;
  return 'chunk-alias';
}
