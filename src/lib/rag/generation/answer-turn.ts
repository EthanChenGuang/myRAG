import type { StreamTextTransform, ToolSet } from 'ai';
import { z } from 'zod/v3';
import type { AnswerConfig } from './answer-config';
import { buildAnswerChecksInput, type AnswerChecksInput } from './answer-checks';
import { createAnswerCollector, type AnswerCollector } from './answer-collector';
import { composeAnswerRules } from './answer-rules';
import { buildAnswerTransforms, guardSlot } from './answer-transforms';
import { emitNotice } from './notices';
import { decideOutputCap as decideCap, effectiveMaxOutputTokens, type OutputCapDecision } from './output-cap';
import { sentinelTransform } from './sentinel';
import { fixedText } from '../lang/texts';
import { readSecurityConfig } from '../security/config';
import { previousTurnLanguage, resolveAnswerLanguage, type AnswerLanguageSource, type TurnMessage } from '../lang/answer-language';
import { getLanguageSettings, languageVariablesUnset } from '../lang/settings';
import { env } from '@/lib/env';
import { allowedImageHosts } from '@/lib/safe-image-hosts';
import { parseLinkAllowlist } from '../security/link-allowlist';
import type { OutputLinkPolicy, WebResultUrl } from '../security/link-targets';
import { createOutputGuard, type OutputGuardLinkSummary, type OutputGuardPolicy } from '../security/output-guard';
import { attributeSourceChunks, recordOutputGuardEvents, type OutputGuardEventContext, type SecurityBlock } from '../security/security-events';
import type { TraceCollector } from '../trace/collector';

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
  /** D-32: the concise instruction is composed; false until decideOutputCap ran or when the cap does not apply. */
  readonly capApplies: boolean;
  /** D-30: decides the output cap once per turn, before the composer runs; later calls return the first decision. */
  decideOutputCap(context: OutputCapTurnContext): OutputCapDecision;
  /** D-29: the limit for the model call, min(limit, cap) when the cap applies, else the limit unchanged. */
  maxOutputTokens(limit: number): number;
  /** The decision of this turn; null before decideOutputCap ran. */
  outputCapDecision(): OutputCapDecision | null;
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
  /**
   * D-37, D-39: the output-guard policy of this turn, built once from the guard sources given to transforms(); null while
   * RAG_OUTPUT_GUARD is off. Web result and server URLs and the flagged-context check are read at each decision.
   */
  guardPolicy(): OutputGuardPolicy | null;
  /** A separate guard transform for a stream outside the chain (the direct Claude call); null while the guard is off. */
  guardTransform(sources?: OutputGuardTurnSources): StreamTextTransform<ToolSet> | null;
  /** The summary of the last guarded stream of this turn; null before one finished or while the guard is off. */
  outputGuardSummary(): OutputGuardLinkSummary | null;
}

/** What the guard needs of a context block sent to the model this turn (D-37 document names, D-41 attribution). */
export interface GuardContextBlock {
  documentId: string;
  documentName: string;
  chunkIds: readonly string[];
  text: string;
  isImage?: boolean;
  uploaderId?: string | null;
}

/** Getters the route passes once; each is read when the guard needs it, never logged. */
export interface OutputGuardTurnSources {
  blocks?: () => readonly GuardContextBlock[];
  /** URLs the server issued in this turn: document links of the sources list and source image URLs. */
  serverUrls?: () => readonly string[];
  /** webSearch result items captured by the route; the guard also reads webSearch tool results from the stream. */
  webResults?: () => readonly unknown[];
  /** Tools whose result the Phase 5.1 tool-result guard flagged in this turn. */
  flaggedTools?: () => ReadonlySet<string>;
  /** A context item of the turn was flagged by injection_check. */
  contextFlagged?: () => boolean;
  /** From the resolved scope, never from the request body. */
  tenantKey?: () => string | null;
  trace?: () => TraceCollector | null;
}

export interface AnswerTransformOptions {
  /** UI-SPEC decision 9: the refusal is notices.no_information_web when the webSearch tool was offered on the turn. */
  webSearchOffered?: boolean;
  /** The citation session's validated aliases, for the sentence records. */
  aliases?: () => ReadonlySet<string>;
  /** D-37: the turn's allow evidence for the output guard; read only while RAG_OUTPUT_GUARD is not off. */
  guard?: OutputGuardTurnSources;
}

const BodyChannelSchema = z.enum(['web', 'whatsapp']);

/** T-05.2-093: the optional request-body `channel`; anything other than web or whatsapp is web. Absent stays undefined. */
export function parseBodyChannel(raw: unknown): 'web' | 'whatsapp' | undefined {
  if (raw === undefined || raw === null) return undefined;
  const parsed = BodyChannelSchema.safeParse(raw);
  return parsed.success ? parsed.data : 'web';
}

export interface OutputCapTurnContext {
  /** Defaults to the turn's RAG mode. */
  mode?: string;
  knowledgeContext: boolean;
  userMaxTokens: boolean;
  reasoning: boolean;
  approvalContinuation: boolean;
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
  let capDecision: OutputCapDecision | null = null;
  let logged = false;
  let chain: Array<StreamTextTransform<ToolSet>> | null = null;
  let collector: AnswerCollector | null = null;
  const sentinelEnabled = (input.config.contextRelevanceRule || input.config.partialAnswerRule) && answerLanguage !== null;
  const guard = createTurnGuard({
    mode: input.config.outputGuard,
    question: input.question,
    answerLanguage,
    channel: input.channel,
    collector: () => collector,
  });
  return Object.freeze({
    config: input.config,
    answerLanguage,
    answerLanguageSource,
    textsSource: input.config.registryTexts && answerLanguage !== null ? 'registry' : 'legacy',
    channel: input.channel,
    ragMode: input.ragMode,
    get capApplies() {
      return capDecision?.concise ?? false;
    },
    decideOutputCap(context: OutputCapTurnContext): OutputCapDecision {
      capDecision ??= decideCap({
        config: input.config,
        mode: context.mode ?? input.ragMode,
        knowledgeContext: context.knowledgeContext,
        userMaxTokens: context.userMaxTokens,
        reasoning: context.reasoning,
        approvalContinuation: context.approvalContinuation,
        channel: input.channel,
      });
      return capDecision;
    },
    maxOutputTokens(limit: number): number {
      return capDecision?.applied ? effectiveMaxOutputTokens(limit, capDecision.cap) : limit;
    },
    outputCapDecision() {
      return capDecision;
    },
    composeSystemPrompt(prompt: string, options: ComposeSystemPromptOptions): string {
      const composed = composeAnswerRules(
        {
          prompt,
          mode: options.mode,
          language: answerLanguage,
          config: input.config,
          channel: input.channel,
          webSearchOffered: options.webSearchOffered,
          capApplies: capDecision?.concise ?? false,
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
      if (options.guard) guard.setSources(options.guard);
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
      chain = buildAnswerTransforms({ citationTransforms, sentinel, guard: guard.transform(), noticeCollector: active.transforms() });
      return chain;
    },
    finishMetadata() {
      return collector ? collector.finishMetadata() : {};
    },
    checksInput(retrievalResult?: unknown) {
      return collector ? buildAnswerChecksInput({ collector, retrievalResult, outputGuard: guard.checks(), question: input.question }) : null;
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
    guardPolicy() {
      return guard.policy();
    },
    guardTransform(sources?: OutputGuardTurnSources) {
      if (sources) guard.setSources(sources);
      return guard.transform();
    },
    outputGuardSummary() {
      return guard.summary();
    },
  });
}

const OUTPUT_GUARD_DETECTOR = 'output_guard';

const EVENT_CHANNEL: Record<AnswerChannel, OutputGuardEventContext['channel']> = {
  web: 'chat',
  whatsapp: 'whatsapp',
  embed: 'embed',
  voice: 'voice',
  eval: 'chat',
};

interface TurnGuardInput {
  mode: AnswerConfig['outputGuard'];
  question: string;
  answerLanguage: string | null;
  channel: AnswerChannel;
  collector: () => AnswerCollector | null;
}

/** webSearch result URLs from a tool output in any of the shapes the route accepts (array, results, items, wrapped value). */
function webResultUrlsOf(output: unknown): string[] {
  const value = output && typeof output === 'object' && 'value' in output ? (output as { value: unknown }).value : output;
  const record = value && typeof value === 'object' ? (value as { results?: unknown; items?: unknown }) : null;
  const items = Array.isArray(value) ? value : Array.isArray(record?.results) ? record.results : Array.isArray(record?.items) ? record.items : [];
  const urls: string[] = [];
  for (const item of items) {
    const url = item && typeof item === 'object' ? (item as { url?: unknown }).url : undefined;
    if (typeof url === 'string' && url !== '') urls.push(url);
  }
  return urls;
}

function hasFindings(summary: OutputGuardLinkSummary): boolean {
  return summary.links_removed > 0 || summary.credential_blocked > 0 || summary.credential_warned > 0;
}

/** D-35 to D-41 for one turn: the policy, the transform, and the span, log, events and checks of each guarded stream. */
function createTurnGuard(input: TurnGuardInput) {
  let sources: OutputGuardTurnSources = {};
  let policy: OutputGuardPolicy | null = null;
  let last: { summary: OutputGuardLinkSummary; sourceChunkIds: string[] } | null = null;
  const streamWebUrls: string[] = [];
  const noticeLanguage =
    input.answerLanguage ?? (input.mode === 'off' || languageVariablesUnset() ? null : getLanguageSettings().primary);

  const flaggedTools = (): ReadonlySet<string> => {
    try {
      return sources.flaggedTools?.() ?? new Set<string>();
    } catch {
      return new Set<string>();
    }
  };

  const blocks = (): GuardContextBlock[] => {
    try {
      return (sources.blocks?.() ?? []).filter((block) => !block.isImage);
    } catch {
      return [];
    }
  };

  const buildPolicy = (): OutputGuardPolicy | null => {
    if (input.mode === 'off') return null;
    if (policy) return policy;
    const live = (name: 'RAG_OUTPUT_LINK_ALLOWLIST' | 'NEXT_PUBLIC_SITE_URL' | 'NEXT_PUBLIC_SUPABASE_URL') => process.env[name] ?? env[name];
    const imageHosts = allowedImageHosts({
      supabaseUrl: live('NEXT_PUBLIC_SUPABASE_URL'),
      headerLogoUrl: process.env.NEXT_PUBLIC_HEADER_LOGO_URL,
      aiLogoUrl: process.env.NEXT_PUBLIC_AI_RESPONSE_LOGO_URL,
    });
    const links: OutputLinkPolicy = {
      allowlist: parseLinkAllowlist(live('RAG_OUTPUT_LINK_ALLOWLIST'), live('NEXT_PUBLIC_SITE_URL')),
      get webResultUrls(): readonly WebResultUrl[] {
        const flagged = flaggedTools().has('webSearch');
        let routeUrls: string[] = [];
        try {
          routeUrls = webResultUrlsOf(sources.webResults?.() ?? []);
        } catch {
          routeUrls = [];
        }
        return [...new Set([...streamWebUrls, ...routeUrls])].map((url) => ({ url, flagged }));
      },
      get serverUrls(): readonly string[] {
        try {
          return (sources.serverUrls?.() ?? []).filter((url) => typeof url === 'string' && url !== '');
        } catch {
          return [];
        }
      },
      imageHosts,
      userMessage: input.question,
      documentNames: [...new Set(blocks().map((block) => block.documentName).filter((name) => typeof name === 'string' && name !== ''))],
    };
    policy = {
      mode: input.mode,
      links,
      placeholder: fixedText('notices.link_removed', input.answerLanguage ?? ''),
      language: input.answerLanguage ?? '',
      get flaggedContext() {
        let context = false;
        try {
          context = sources.contextFlagged?.() === true;
        } catch {
          context = false;
        }
        return context || flaggedTools().size > 0;
      },
      onNotice: (notice) => {
        const collector = input.collector();
        if (!collector || !noticeLanguage) return;
        collector.addNotice(emitNotice(notice.kind, { language: noticeLanguage }));
      },
    };
    return policy;
  };

  const onSummary = (summary: OutputGuardLinkSummary) => {
    const sent: SecurityBlock[] = blocks().map((block) => ({
      documentId: block.documentId,
      chunkIds: block.chunkIds,
      text: block.text,
      uploaderId: block.uploaderId ?? null,
    }));
    const attributed = [...attributeSourceChunks(sent, summary.removedTargets), ...attributeSourceChunks(sent, summary.matchedPhrases)];
    const sourceChunkIds = [...new Set(attributed.map((source) => source.chunkId).filter((id): id is string => typeof id === 'string'))].sort();
    const documentIds = [...new Set(attributed.map((source) => source.documentId))].sort();
    last = { summary, sourceChunkIds };
    let trace: TraceCollector | null = null;
    let tenantKey: string | null = null;
    try {
      trace = sources.trace?.() ?? null;
      tenantKey = sources.tenantKey?.() ?? null;
    } catch {
      trace = null;
    }
    const source = sourceChunkIds.length > 0 ? 'context' : 'model';
    if (trace) {
      const at = trace.now();
      trace.record({
        name: 'output_guard',
        status: 'ok',
        startedAt: at,
        endedAt: at,
        counts: {
          links_checked: summary.links_checked,
          links_removed: summary.links_removed,
          credential_blocked: summary.credential_blocked,
          credential_warned: summary.credential_warned,
        },
        rules: [...summary.rule_ids],
        versions: [`output_guard_rules@${summary.rules_version}`],
        detail: summary.mode,
        attributes: {
          security_detectors: OUTPUT_GUARD_DETECTOR,
          security_source: source,
          security_chunks: sourceChunkIds.join(','),
          security_documents: documentIds.join(','),
        },
      });
    }
    if (!hasFindings(summary)) return;
    console.warn('[RAG Security] Output guard findings', {
      traceId: trace?.traceId ?? null,
      channel: input.channel,
      mode: summary.mode,
      linksChecked: summary.links_checked,
      linksRemoved: summary.links_removed,
      credentialBlocked: summary.credential_blocked,
      credentialWarned: summary.credential_warned,
      ruleIds: summary.rule_ids,
      rulesVersion: summary.rules_version,
      source,
      chunks: sourceChunkIds,
      documents: documentIds,
    });
    if (!tenantKey) return;
    try {
      recordOutputGuardEvents(summary, {
        tenantKey,
        traceId: trace?.traceId ?? null,
        blocks: sent,
        channel: EVENT_CHANNEL[input.channel],
        removedTargets: summary.removedTargets,
        matchedPhrases: summary.matchedPhrases,
      });
    } catch {
      console.warn('[RAG Security] output guard events not recorded', { traceId: trace?.traceId ?? null, channel: input.channel });
    }
  };

  return {
    setSources(next: OutputGuardTurnSources) {
      sources = next;
    },
    policy: buildPolicy,
    transform(): StreamTextTransform<ToolSet> | null {
      return guardSlot(input.mode, {
        createGuard: () => createOutputGuard(buildPolicy() as OutputGuardPolicy),
        onSummary,
        observe: (part) => {
          if (part.type === 'tool-result' && part.toolName === 'webSearch') {
            for (const url of webResultUrlsOf((part as { output?: unknown }).output)) if (!streamWebUrls.includes(url)) streamWebUrls.push(url);
          }
        },
      });
    },
    summary: () => last?.summary ?? null,
    checks: () => (last ? { summary: last.summary, sourceChunkIds: last.sourceChunkIds } : null),
  };
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
  const cap = outputCapTraceFields(turn);
  if (!collector) return cap.rules.length > 0 ? cap : { rules: [] };
  const rules: string[] = [...cap.rules];
  const reason = collector.finishReason();
  if (reason !== null) rules.push(`finish_reason:${TRACE_KEY.test(reason) ? reason : 'other'}`);
  if (collector.refusedByModel()) rules.push('refusal_origin:model_relevance');
  const counts: Record<string, number> = { ...cap.counts };
  for (const notice of collector.notices()) {
    const key = `notice_${notice.kind}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  if (collector.strippedSentinels() > 0) counts.sentinel_stripped = collector.strippedSentinels();
  if (truncatedMarkers > 0) counts.truncated_markers = truncatedMarkers;
  return Object.keys(counts).length > 0 ? { rules, counts } : { rules };
}

/** The cap decision on the generation span (applied, cap, reason); nothing while every Phase 5.2 switch is off or undecided. */
function outputCapTraceFields(turn: AnswerTurn): { rules: string[]; counts?: Record<string, number> } {
  const decision = turn.outputCapDecision();
  if (!turn.config.anyNonDefault || !decision) return { rules: [] };
  const rules = [`output_cap:${decision.applied ? 'applied' : 'not_applied'}`, `output_cap_reason:${decision.reason}`];
  return decision.cap !== null ? { rules, counts: { output_cap: decision.cap } } : { rules };
}
