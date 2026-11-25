import type { StreamTextTransform, ToolSet } from 'ai';
import { z } from 'zod/v3';
import { stripCitationMarkers } from '@/lib/citations/marker-grammar';
import { CitationRecordSchema, type CitationRecord } from '@/lib/rag-eval/contracts.generated';
import type { CitationLabeler, ContextBlock } from '../../types';
import type { GenerationConfig } from '../config';
import { createMarkerParser, type MarkerParser } from './marker-parser';
import { buildAliasMap, createCitationLabeler, type AliasMap } from './blocks';
import { citationInstruction } from './instructions';
import { buildCitationRecords, capQuotes } from './record';
import { selectCitationStrategy, type CitationRagMode, type CitationStrategyId } from './strategy';
import { aliasParserTransform } from './transforms';

export interface CitationCapabilities {
  citations: boolean;
}

export interface CitationSessionInput {
  capabilities: CitationCapabilities | null | undefined;
  ragMode: CitationRagMode;
  modelId: string;
  language: string;
  config: Pick<GenerationConfig, 'citations'>;
}

export interface CitationFinishMetadata {
  citations?: CitationRecord[];
  citationStrategy?: CitationStrategyId;
  invalidCitations?: number;
}

export interface HistoryMessage {
  role: string;
  content: unknown;
}

export interface CitationSession {
  /** Passed to runRetrieval; undefined when citations cannot apply to this turn. */
  readonly labeler: CitationLabeler | undefined;
  readonly strategy: CitationStrategyId | null;
  /** Binds the final context blocks that were sent to the model; null when no context was sent. */
  attach(result: { blocks?: ContextBlock[] } | null): void;
  decorateSystemPrompt(prompt: string): string;
  /** Removes markers from earlier assistant turns; aliases belong to the request that made them. */
  stripHistory<T extends HistoryMessage>(messages: T[]): T[];
  transforms(): Array<StreamTextTransform<ToolSet>>;
  finishMetadata(): CitationFinishMetadata;
  answerText(): string;
}

const CitationListSchema = z.array(CitationRecordSchema);

function stripContent(content: unknown): unknown {
  if (typeof content === 'string') return stripCitationMarkers(content);
  if (!Array.isArray(content)) return content;
  return content.map((part) =>
    part && typeof part === 'object' && (part as { type?: unknown }).type === 'text' && typeof (part as { text?: unknown }).text === 'string'
      ? { ...part, text: stripCitationMarkers((part as { text: string }).text) }
      : part,
  );
}

function logFailure(reason: string, counts: Record<string, number>): void {
  console.warn('[Citations] Citation validation skipped:', { reason, ...counts });
}

export function createCitationSession(input: CitationSessionInput): CitationSession {
  const capable =
    input.config.citations && input.capabilities?.citations === true && input.ragMode !== 'bypass';
  const labeler = capable ? createCitationLabeler() : undefined;

  let strategy: CitationStrategyId | null = null;
  let aliasMap: AliasMap | null = null;
  let parser: MarkerParser | null = null;
  let failed = false;
  let finished: { citations: CitationRecord[]; invalidCitations: number } | null = null;
  let answer = '';

  const fail = (reason: string) => {
    if (failed) return;
    failed = true;
    logFailure(reason, { blocks: aliasMap?.ordered.length ?? 0, answerChars: answer.length });
  };

  const finalize = () => {
    if (finished || !parser || !aliasMap || !strategy) return finished;
    if (failed) {
      finished = { citations: [], invalidCitations: 0 };
      return finished;
    }
    try {
      const parsed = parser.finish();
      const records = capQuotes(buildCitationRecords(parsed.valid, aliasMap, strategy));
      finished = { citations: CitationListSchema.parse(records), invalidCitations: parsed.invalidCitations };
    } catch {
      fail('record_error');
      finished = { citations: [], invalidCitations: 0 };
    }
    return finished;
  };

  return {
    labeler,
    get strategy() {
      return strategy;
    },
    attach(result) {
      if (!labeler) return;
      try {
        const map = buildAliasMap(result?.blocks);
        strategy = selectCitationStrategy({
          modelId: input.modelId,
          turn: { capabilities: { citations: true }, ragMode: input.ragMode, aliasCount: map.ordered.length },
          config: input.config,
        });
        if (strategy) {
          aliasMap = map;
          parser = createMarkerParser({ aliases: map.aliases });
        }
      } catch {
        strategy = null;
        logFailure('alias_map_error', { blocks: result?.blocks?.length ?? 0 });
      }
    },
    decorateSystemPrompt(prompt) {
      if (strategy !== 'chunk-alias') return prompt;
      return `${prompt}\n\n${citationInstruction(input.language)}`;
    },
    stripHistory(messages) {
      if (!strategy) return messages;
      return messages.map((message) =>
        message.role === 'assistant' ? { ...message, content: stripContent(message.content) } : message,
      );
    },
    transforms() {
      if (strategy !== 'chunk-alias' || !parser) return [];
      const active = parser;
      return [
        aliasParserTransform({
          feed(textId, delta) {
            answer += delta;
            if (!failed) active.feed(textId, delta);
          },
          end(textId) {
            if (!failed) active.end(textId);
          },
          finish() {
            finalize();
          },
          fail,
        }),
      ];
    },
    finishMetadata() {
      if (!strategy) return {};
      const result = finalize() ?? { citations: [], invalidCitations: 0 };
      return { citations: result.citations, citationStrategy: strategy, invalidCitations: result.invalidCitations };
    },
    answerText() {
      return answer;
    },
  };
}
