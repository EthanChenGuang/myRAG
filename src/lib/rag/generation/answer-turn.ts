import type { StreamTextTransform, ToolSet } from 'ai';
import { z } from 'zod/v3';
import type { AnswerConfig } from './answer-config';
import { buildAnswerChecksInput, type AnswerChecksInput } from './answer-checks';
import { createAnswerCollector, type AnswerCollector } from './answer-collector';
import { composeAnswerRules } from './answer-rules';
import { buildAnswerTransforms } from './answer-transforms';
import { sentinelTransform } from './sentinel';
import { fixedText } from '../lang/texts';
import { readSecurityConfig } from '../security/config';
import { previousTurnLanguage, resolveAnswerLanguage, type AnswerLanguageSource, type TurnMessage } from '../lang/answer-language';
import { getLanguageSettings, languageVariablesUnset } from '../lang/settings';

export type AnswerChannel = 'web' | 'whatsapp' | 'embed' | 'voice' | 'eval';
/** `registry`: fixed texts come from the language registry in the answer language; `legacy`: today's text tables (D-10). */
export type TextsSource = 'registry' | 'legacy';

/** The per-request answer state (D-64); created once per chat request. Later plans add their seams to it. */
export interface AnswerTurn {
  readonly config: AnswerConfig;
  /** D-09; null when no Phase 5.2 switch is on or the languages are not configured. */
  readonly answerLanguage: string | null;
  readonly answerLanguageSource: AnswerLanguageSource | null;
  readonly textsSource: TextsSource;
  readonly channel: AnswerChannel;
  readonly ragMode: string;
  /** D-32; false until plan 05.2-10 sets it from the output-cap rules. */
  readonly capApplies: boolean;
  /** D-04: appends the answer-rule block to the final system prompt; returns the prompt itself when no part applies. */
  composeSystemPrompt(prompt: string, options: ComposeSystemPromptOptions): string;
  /**
   * D-35, D-16, D-11: the answer chain, built once per request. With every Phase 5.2 switch off it returns `citationTransforms`
   * unchanged; the sentinel is installed only with RAG_CONTEXT_RELEVANCE_RULE or RAG_PARTIAL_ANSWER_RULE on.
   */
  transforms(citationTransforms: Array<StreamTextTransform<ToolSet>>, options?: AnswerTransformOptions): Array<StreamTextTransform<ToolSet>>;
  /** D-20, UI-SPEC 8.1: empty with every switch off or before the chain was built. */
  finishMetadata(): Record<string, unknown>;
  /** D-23, D-33: null when no collector ran on this turn. */
  checksInput(retrievalResult?: unknown): AnswerChecksInput | null;
  /** D-16: the model wrote the no-answer sentinel and the server streamed the registry refusal. */
  refusedByModel(): boolean;
  finishReason(): string | null;
  /** The collector of the chain; null until transforms() built one. */
  collector(): AnswerCollector | null;
}

export interface AnswerTransformOptions {
  /** UI-SPEC decision 9: the refusal is notices.no_information_web when the webSearch tool was offered on the turn. */
  webSearchOffered?: boolean;
  /** The citation session's validated aliases, for the sentence records. */
  aliases?: () => ReadonlySet<string>;
}

const BodyChannelSchema = z.enum(['web', 'whatsapp']);

/** T-05.2-093: the optional request-body `channel`; anything other than web or whatsapp is web. Absent stays undefined. */
export function parseBodyChannel(raw: unknown): 'web' | 'whatsapp' | undefined {
  if (raw === undefined || raw === null) return undefined;
  const parsed = BodyChannelSchema.safeParse(raw);
  return parsed.success ? parsed.data : 'web';
}

export interface ComposeSystemPromptOptions {
  mode: string;
  webSearchOffered: boolean;
  /** RAG_CONTEXT_TAGGING; read from the security config when absent, so the chat route never reads the switch. */
  contextTagging?: boolean;
}

export interface AnswerTurnInput {
  config: AnswerConfig;
  question: string;
  /** The request's messages, the current question last; read only when the answer language is computed. */
  history: readonly TurnMessage[];
  /** Overrides the previous-turn language read from `history`. */
  previousTurnLanguage?: string | null;
  uiLanguage: string | null | undefined;
  channel: AnswerChannel;
  ragMode: string;
}

/** D-03: with every Phase 5.2 switch off, or the languages unset (D-02), no language setting is read and no detector runs. */
export function createAnswerTurn(input: AnswerTurnInput): AnswerTurn {
  let answerLanguage: string | null = null;
  let answerLanguageSource: AnswerLanguageSource | null = null;
  if (input.config.anyNonDefault && !languageVariablesUnset()) {
    const settings = getLanguageSettings();
    if (settings.configured && settings.primary) {
      const enabled = settings.languages;
      const resolved = resolveAnswerLanguage({
        question: input.question,
        previousTurnLanguage: input.previousTurnLanguage !== undefined ? input.previousTurnLanguage : previousTurnLanguage(input.history, enabled),
        uiLanguage: input.uiLanguage,
        enabled,
        primary: settings.primary,
      });
      answerLanguage = resolved.language;
      answerLanguageSource = resolved.source;
    }
  }
  const capApplies = false;
  let logged = false;
  let chain: Array<StreamTextTransform<ToolSet>> | null = null;
  let collector: AnswerCollector | null = null;
  const sentinelEnabled = (input.config.contextRelevanceRule || input.config.partialAnswerRule) && answerLanguage !== null;
  return Object.freeze({
    config: input.config,
    answerLanguage,
    answerLanguageSource,
    textsSource: input.config.registryTexts && answerLanguage !== null ? 'registry' : 'legacy',
    channel: input.channel,
    ragMode: input.ragMode,
    capApplies,
    composeSystemPrompt(prompt: string, options: ComposeSystemPromptOptions): string {
      const composed = composeAnswerRules(
        {
          prompt,
          mode: options.mode,
          language: answerLanguage,
          config: input.config,
          channel: input.channel,
          webSearchOffered: options.webSearchOffered,
          capApplies,
          calcOffered: false,
          contextTagging: options.contextTagging ?? readSecurityConfig().contextTagging,
        },
        { log: !logged },
      );
      if (composed !== prompt) logged = true;
      return composed;
    },
    transforms(citationTransforms: Array<StreamTextTransform<ToolSet>>, options: AnswerTransformOptions = {}) {
      if (chain) return chain;
      if (!input.config.anyNonDefault) {
        chain = buildAnswerTransforms({ citationTransforms });
        return chain;
      }
      const active = createAnswerCollector({
        turn: { config: input.config, answerLanguage },
        channel: input.channel,
        ...(options.aliases ? { aliases: options.aliases } : {}),
      });
      collector = active;
      const sentinel =
        sentinelEnabled && answerLanguage !== null
          ? sentinelTransform({
              refusalText: fixedText(options.webSearchOffered ? 'notices.no_information_web' : 'notices.no_information', answerLanguage),
              onRefusal: () => active.markRefused(),
              onStripped: (count) => active.countStripped(count),
            })
          : null;
      chain = buildAnswerTransforms({ citationTransforms, sentinel, noticeCollector: active.transforms() });
      return chain;
    },
    finishMetadata() {
      return collector ? collector.finishMetadata() : {};
    },
    checksInput(retrievalResult?: unknown) {
      return collector ? buildAnswerChecksInput({ collector, retrievalResult }) : null;
    },
    refusedByModel() {
      return collector?.refusedByModel() ?? false;
    },
    finishReason() {
      return collector?.finishReason() ?? null;
    },
    collector() {
      return collector;
    },
  });
}

export interface AnswerFinishFields {
  checks?: AnswerChecksInput;
  answerLanguage: string | null;
  textsSource: TextsSource;
  refusedByModel: boolean;
}

/** The four answer-finish fields of a Phase 5.2 turn; the route spreads them only when a 5.2 switch is on (D-03). */
export function answerFinishFields(turn: AnswerTurn, retrievalResult?: unknown): AnswerFinishFields {
  const checks = turn.checksInput(retrievalResult);
  return {
    ...(checks ? { checks } : {}),
    answerLanguage: turn.answerLanguage,
    textsSource: turn.textsSource,
    refusedByModel: turn.refusedByModel(),
  };
}

const TRACE_KEY = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * D-11, D-16, D-33 on the generation stage: finish_reason and refusal_origin as rules, notices by kind, stripped sentinels and
 * half markers as counts. Nothing while no collector ran (every 5.2 switch off), so the trace is today's.
 */
export function answerTraceFields(turn: AnswerTurn, truncatedMarkers = 0): { rules: string[]; counts?: Record<string, number> } {
  const collector = turn.collector();
  if (!collector) return { rules: [] };
  const rules: string[] = [];
  const reason = collector.finishReason();
  if (reason !== null) rules.push(`finish_reason:${TRACE_KEY.test(reason) ? reason : 'other'}`);
  if (collector.refusedByModel()) rules.push('refusal_origin:model_relevance');
  const counts: Record<string, number> = {};
  for (const notice of collector.notices()) {
    const key = `notice_${notice.kind}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  if (collector.strippedSentinels() > 0) counts.sentinel_stripped = collector.strippedSentinels();
  if (truncatedMarkers > 0) counts.truncated_markers = truncatedMarkers;
  return Object.keys(counts).length > 0 ? { rules, counts } : { rules };
}
