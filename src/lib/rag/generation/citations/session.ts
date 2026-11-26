import type { ModelMessage, StreamTextTransform, ToolSet } from 'ai';
import { z } from 'zod/v3';
import { stripCitationMarkers } from '@/lib/citations/marker-grammar';
import { CitationRecordSchema, type CitationRecord } from '@/lib/rag-eval/contracts.generated';
import { formatURLsForContext, type ExtractedURL } from '@/lib/url-extractor';
import { buildClaudeContextReplacement, docsFromBlocks } from '../../context/wrap';
import { readSecurityConfig } from '../../security/config';
import type { CitationLabeler, ContextBlock, UsedDocument } from '../../types';
import { readAnswerConfig } from '../answer-config';
import type { TextsSource } from '../answer-turn';
import type { GenerationConfig } from '../config';
import { createEnhancedRAGPrompt } from '../prompt';
import { createMarkerParser, type MarkerParser } from './marker-parser';
import { buildAliasMap, createCitationLabeler, type AliasMap } from './blocks';
import { createClaudeProvider, startClaudeCitationStream, type ClaudeCitationStream } from './claude';
import type { FallbackReason } from './fallback';
import { attachedDocumentsText, citationInstructionFor, groundingPerSentenceText } from './instructions';
import { anthropicIdFor } from './models';
import { buildCitationRecords, capQuotes } from './record';
import {
  preRetrievalCitations,
  selectCitationStrategy,
  type CitationRagMode,
  type CitationStrategyConfig,
  type CitationStrategyId,
  type ClaudeTurnFacts,
} from './strategy';
import { aliasParserTransform } from './transforms';

export interface CitationCapabilities {
  citations: boolean;
}

export interface CitationSessionInput {
  capabilities: CitationCapabilities | null | undefined;
  ragMode: CitationRagMode;
  modelId: string;
  language: string;
  /** D-10: `registry` reads the instruction texts from the language registry in `language`; absent means legacy. */
  textsSource?: TextsSource;
  config: CitationStrategyConfig & Partial<Pick<GenerationConfig, 'anthropicBaseUrl'>>;
  /** Absent: the direct Claude path is never chosen. */
  facts?: ClaudeTurnFacts;
  /** RAG_CONTEXT_TAGGING; read from the environment when absent. */
  contextTagging?: boolean;
  /** D-20 RAG_CITATION_PER_SENTENCE (already off when citations are off); read from the environment when absent. */
  perSentence?: boolean;
}

export interface ClaudeStartInput {
  system: string;
  /** Earlier turns, already stripped of markers. */
  history: ModelMessage[];
  question: string;
  reasoning: boolean;
  abortSignal: AbortSignal;
  onError(error: unknown): void;
  fetch?: typeof fetch;
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
  /** Why the direct Claude call was given up for chunk-alias; null when it was not. */
  readonly fallbackReason: FallbackReason | null;
  /** Binds the final context blocks that were sent to the model; null when no context was sent. */
  attach(result: { blocks?: ContextBlock[]; links?: ExtractedURL[]; usedDocuments?: readonly UsedDocument[] } | null): void;
  /** On a Claude turn the OpenRouter prompt is the fallback prompt, so it carries the alias instruction too. */
  decorateSystemPrompt(prompt: string): string;
  /** D-09: {{context}} becomes the attached-documents sentence, the image captions and the links section; with RAG_CONTEXT_TAGGING the notice, reminder and a documents element wrap them (5.1 D-05). */
  claudeSystemPrompt(basePrompt: string): string;
  /** Starts the direct call; only on a claude-citations turn. */
  startClaude(input: ClaudeStartInput): ClaudeCitationStream;
  /** D-10: one switch from the direct call to chunk-alias on the OpenRouter path. */
  fallback(reason: FallbackReason): void;
  /** Removes markers from earlier assistant turns; aliases belong to the request that made them. */
  stripHistory<T extends HistoryMessage>(messages: T[]): T[];
  transforms(): Array<StreamTextTransform<ToolSet>>;
  /** A non-streamed chunk-alias answer: parses the whole text once, as the stream transform would. */
  ingestFullText(text: string): void;
  finishMetadata(): CitationFinishMetadata;
  /** The validated records with full quotes, for the answer record; null when no strategy is active. */
  fullRecords(): { citations: CitationRecord[]; invalidCitations: number } | null;
  answerText(): string;
  /** The aliases of the attached AliasMap (empty when no strategy is active); a marker for any other alias never cites. */
  aliases(): ReadonlySet<string>;
  /** D-33: markers cut in half at a text-part end or at the stream end; dropped, never guessed. */
  truncatedMarkers(): number;
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
  const capable = preRetrievalCitations({
    config: input.config,
    modelId: input.modelId,
    capabilities: input.capabilities,
    ragMode: input.ragMode,
    ...(input.facts ? { facts: input.facts } : {}),
  });
  const labeler = capable ? createCitationLabeler() : undefined;
  const perSentence = input.perSentence ?? readAnswerConfig().citationPerSentence;

  let strategy: CitationStrategyId | null = null;
  let fallbackReason: FallbackReason | null = null;
  let claude: ClaudeCitationStream | null = null;
  let sideBlocks: ContextBlock[] = [];
  let links: ExtractedURL[] = [];
  let aliasMap: AliasMap | null = null;
  let parser: MarkerParser | null = null;
  let failed = false;
  let finished: { citations: CitationRecord[]; invalidCitations: number } | null = null;
  let full: CitationRecord[] = [];
  let answer = '';

  const claudeBasePrompt = (basePrompt: string): string => {
    const tagging = input.contextTagging ?? readSecurityConfig().contextTagging;
    if (tagging) {
      const context = buildClaudeContextReplacement({
        attachedSentence: attachedDocumentsText(input.language, input.textsSource),
        docs: docsFromBlocks(sideBlocks, { links }),
      });
      return createEnhancedRAGPrompt(basePrompt, context, input.ragMode);
    }
    const context = [attachedDocumentsText(input.language, input.textsSource), ...sideBlocks.map((block) => block.text), formatURLsForContext(links)]
      .filter((part) => part.trim().length > 0)
      .join('\n\n');
    return createEnhancedRAGPrompt(basePrompt, context, input.ragMode);
  };

  const fail = (reason: string) => {
    if (failed) return;
    failed = true;
    logFailure(reason, { blocks: aliasMap?.ordered.length ?? 0, answerChars: answer.length });
  };

  const finalize = () => {
    if (finished || !parser || !aliasMap || !strategy) return finished;
    if (strategy === 'claude-citations') {
      if (!claude) return null;
      const result = claude.citations();
      try {
        finished = { citations: CitationListSchema.parse(capQuotes(result.citations)), invalidCitations: result.invalidCitations };
        full = result.citations;
      } catch {
        fail('record_error');
        finished = { citations: [], invalidCitations: 0 };
      }
      return finished;
    }
    if (failed) {
      finished = { citations: [], invalidCitations: 0 };
      return finished;
    }
    try {
      const parsed = parser.finish();
      const records = CitationListSchema.parse(buildCitationRecords(parsed.valid, aliasMap, strategy));
      finished = { citations: CitationListSchema.parse(capQuotes(records)), invalidCitations: parsed.invalidCitations };
      full = records;
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
    get fallbackReason() {
      return fallbackReason;
    },
    attach(result) {
      if (!labeler) return;
      try {
        const map = buildAliasMap(result?.blocks, result?.usedDocuments);
        strategy = selectCitationStrategy({
          modelId: input.modelId,
          turn: {
            capabilities: { citations: true },
            ragMode: input.ragMode,
            aliasCount: map.ordered.length,
            ...(input.facts ? { facts: input.facts } : {}),
          },
          config: input.config,
        });
        if (strategy) {
          aliasMap = map;
          parser = createMarkerParser({ aliases: map.aliases });
          sideBlocks = (result?.blocks ?? []).filter((block) => block.isImage);
          links = result?.links ?? [];
        }
      } catch {
        strategy = null;
        logFailure('alias_map_error', { blocks: result?.blocks?.length ?? 0 });
      }
    },
    decorateSystemPrompt(prompt) {
      if (strategy !== 'chunk-alias' && strategy !== 'claude-citations') return prompt;
      return `${prompt}\n\n${citationInstructionFor(input.language, input.textsSource, perSentence)}`;
    },
    claudeSystemPrompt(basePrompt) {
      const prompt = claudeBasePrompt(basePrompt);
      return perSentence ? `${prompt}\n\n${groundingPerSentenceText(input.language)}` : prompt;
    },
    startClaude(start) {
      if (strategy !== 'claude-citations' || !aliasMap || claude) {
        throw new Error('the direct Claude call needs an unstarted claude-citations turn');
      }
      const anthropicId = anthropicIdFor(input.modelId);
      const apiKey = input.config.anthropicApiKey;
      if (!anthropicId || !apiKey) throw new Error('the direct Claude call needs a mapped model and a key');
      const provider = createClaudeProvider({
        apiKey,
        baseUrl: input.config.anthropicBaseUrl ?? null,
        ...(start.fetch ? { fetch: start.fetch } : {}),
      });
      claude = startClaudeCitationStream({
        provider,
        aliasMap,
        system: start.system,
        history: start.history,
        question: start.question,
        anthropicId,
        reasoning: start.reasoning,
        abortSignal: start.abortSignal,
        onError: start.onError,
      });
      return claude;
    },
    fallback(reason) {
      if (strategy !== 'claude-citations' || !aliasMap) return;
      fallbackReason = reason;
      strategy = 'chunk-alias';
      claude = null;
      failed = false;
      finished = null;
      full = [];
      answer = '';
      parser = createMarkerParser({ aliases: aliasMap.aliases });
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
    ingestFullText(text) {
      if (strategy !== 'chunk-alias' || !parser || finished) return;
      answer += text;
      if (!failed) {
        try {
          parser.feed('full', text);
          parser.end('full');
        } catch {
          fail('parser_error');
        }
      }
      finalize();
    },
    finishMetadata() {
      if (!strategy) return {};
      const result = finalize() ?? { citations: [], invalidCitations: 0 };
      return { citations: result.citations, citationStrategy: strategy, invalidCitations: result.invalidCitations };
    },
    fullRecords() {
      if (!strategy) return null;
      const result = finalize() ?? { citations: [], invalidCitations: 0 };
      return { citations: result.citations.length === 0 ? [] : full, invalidCitations: result.invalidCitations };
    },
    answerText() {
      return answer;
    },
    aliases() {
      return new Set<string>();
    },
    truncatedMarkers() {
      return 0;
    },
  };
}
