import type { SupabaseClient } from '@supabase/supabase-js';
import type { ReviewReason } from '@/lib/answers/store';
import { findCitationMarkers, stripCitationMarkers } from '@/lib/citations/marker-grammar';
import { isMultiTenant } from '@/lib/deployment-mode';
import { env } from '@/lib/env';
import {
  AnswerChecksSchema,
  ClaimCheckRequestSchema,
  ClaimCheckResultSchema,
  type AnswerChecks,
  type AnswerSentence,
  type ClaimCheckRequest,
  type ClaimCheckResult,
} from '@/lib/rag-eval/contracts.generated';
import { countTokens as cl100kCountTokens } from '../ingest/text/tokens';
import { detectLanguage } from '../lang/detect';
import { scopeKey } from '../tenant/scope';
import { isLangfuseUsable, readLangfuseConfig, type LangfuseConfig } from '../trace/config';
import type { CollectedTrace, ExportTraceOptions } from '../trace/langfuse';
import { exportReviewCandidate, type ReviewCandidateInput, type ReviewExportOptions, type ReviewExportStatus } from '../trace/review-export';
import { isSampled } from '../trace/sample';
import { postLangfuseScores, type LangfuseScoreInput, type PostScoresOptions, type PostScoresResult } from '../trace/scores';
import type { AnswerFinishInput, AnswerPendingContext } from './answer-finish';
import { readAnswerConfig } from './answer-config';
import { readGenerationConfig } from './config';
import { allowVectaraFor, answerGroundednessLanguage, labelGroundedness, type AnswerGroundedness } from './groundedness';
import { judgeAnswerLabel, judgeClaims, loadJudgeThresholds, type JudgeThresholdCells, type ClaimInput, type ClaimPremise, type JudgeClaimsInput, type JudgeClaimsResult, type JudgeUsage } from './judge';
import { answerTextHash } from './sentences-record';

export interface ClaimStepConfig {
  claimCheck: boolean;
  llmJudge: boolean;
  judgeModel: string;
  vectaraOptIn: boolean;
  vectaraMultiTenantAck: boolean;
  maxPremiseTokens: number;
  groundednessTimeoutMs: number;
}

export interface ClaimClientOptions {
  /** Defaults to RAG_SIDECAR_URL. */
  url?: string;
  /** Defaults to RAG_SIDECAR_SECRET. */
  secret?: string;
  /** Defaults to RAG_GROUNDEDNESS_TIMEOUT_MS. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface ClaimStepDeps {
  readConfig: () => ClaimStepConfig;
  multiTenant: () => boolean;
  request: (request: ClaimCheckRequest, options?: ClaimClientOptions) => Promise<ClaimCheckResult>;
  judge: (input: JudgeClaimsInput) => Promise<JudgeClaimsResult>;
  updateChecks: (admin: SupabaseClient, input: { id: string; checks: AnswerChecks }) => Promise<boolean>;
  updateGroundedness: (admin: SupabaseClient, input: { id: string; groundedness: AnswerGroundedness }) => Promise<boolean>;
  appendReviewReason: (admin: SupabaseClient, input: { id: string; reason: ReviewReason }) => Promise<boolean>;
  exportReview: (input: ReviewCandidateInput, options: ReviewExportOptions) => Promise<ReviewExportStatus>;
  langfuse: () => LangfuseConfig;
  exportTrace: (trace: CollectedTrace, options: ExportTraceOptions) => Promise<void>;
  postScores: (scores: readonly LangfuseScoreInput[], options: PostScoresOptions) => Promise<PostScoresResult>;
  now: () => Date;
  /** D-27: the judge cells; the committed file by default. */
  judgeCells: () => JudgeThresholdCells;
  updateTimeoutMs: number;
  langfuseTimeoutMs: number;
}

export interface BuildClaimInputsInput {
  /** The text part the sentence offsets point into. */
  text: string;
  sentences: readonly AnswerSentence[];
  /** The alias blocks in the order they were sent. */
  blocks: ReadonlyArray<{ alias: string; text: string }>;
  /** webSearch result texts, only when that tool ran; used like the other blocks for an uncited sentence. */
  webSearchTexts?: readonly string[];
  /** The aliases a marker may name; defaults to the block aliases. */
  aliases?: ReadonlySet<string>;
  /** RAG_GROUNDEDNESS_MAX_PREMISE_TOKENS, per claim. */
  capPerClaim: number;
  maxClaims?: number;
  countTokens?: (text: string) => number;
}

export type SkippedReason = 'too_many' | 'empty_claim' | 'no_premise';

export interface ClaimInputs {
  /** Each referenced premise once, in the order sent. */
  premises: ClaimPremise[];
  claims: ClaimInput[];
  /** Factual sentences that are not sent, with the reason. */
  skipped: Array<{ index: number; reason: SkippedReason }>;
}

export interface ClaimStepOptions {
  /** Epoch milliseconds of the shared groundedness deadline (D-22). */
  deadlineAt?: number;
}

export interface ClaimStepOutcome {
  /** Set when the step stored a new answer-level groundedness (judge languages, D-27). */
  groundedness?: AnswerGroundedness;
}

/** D-22: the per-answer sentence cap. */
export const MAX_CLAIMS = 40;
const MAX_PREMISES = 64;
const MAX_PREMISE_CHARS = 60000;
const MAX_HYPOTHESIS_CHARS = 4000;
const REF = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SECRET_HEADER = 'x-sidecar-secret';
const CLAIMS_PATH = '/v1/groundedness/claims';
const UPDATE_TIMEOUT_MS = 5000;
const LANGFUSE_TIMEOUT_MS = 3000;
const OTEL_TRACE_ID = /^[0-9a-f]{32}$/;

type Support = AnswerSentence['support'];
type Scorer = NonNullable<AnswerSentence['scorer']>;
interface SentenceVerdict {
  support: Support;
  scorer: Scorer | null;
  reason: string | null;
}

interface PremiseCandidate {
  ref: string;
  text: string;
}

function premiseCandidates(blocks: BuildClaimInputsInput['blocks'], webSearchTexts: readonly string[]) {
  const byAlias = new Map<string, PremiseCandidate>();
  const ordered: PremiseCandidate[] = [];
  const used = new Set<string>();
  const add = (preferred: string, fallback: string, text: string): PremiseCandidate | null => {
    const trimmed = text.trim() === '' ? '' : text.slice(0, MAX_PREMISE_CHARS);
    if (!trimmed) return null;
    let ref = REF.test(preferred) && !used.has(preferred) ? preferred : fallback;
    let n = 1;
    while (used.has(ref)) ref = `${fallback}-${n++}`;
    used.add(ref);
    const candidate = { ref, text: trimmed };
    ordered.push(candidate);
    return candidate;
  };
  blocks.forEach((block, i) => {
    const candidate = add(block.alias, `b${i + 1}`, block.text);
    if (candidate && block.alias && !byAlias.has(block.alias)) byAlias.set(block.alias, candidate);
  });
  webSearchTexts.forEach((text, i) => {
    add('', `w${i + 1}`, text);
  });
  return { byAlias, ordered };
}

/**
 * D-22, D-94: the factual sentences as claims (at most 40), each with its own premise refs: the blocks its markers cite, or for an
 * uncited sentence the blocks in the order sent, within the per-claim token cap. Premises are listed once; markers are stripped.
 */
export function buildClaimInputs(input: BuildClaimInputsInput): ClaimInputs {
  const count = input.countTokens ?? cl100kCountTokens;
  const maxClaims = input.maxClaims ?? MAX_CLAIMS;
  const { byAlias, ordered } = premiseCandidates(input.blocks, input.webSearchTexts ?? []);
  const aliases = input.aliases ?? new Set(byAlias.keys());
  const markers = findCitationMarkers(input.text);
  const tokens = new Map<string, number>();
  const tokensOf = (candidate: PremiseCandidate) => {
    let value = tokens.get(candidate.ref);
    if (value === undefined) {
      value = count(candidate.text);
      tokens.set(candidate.ref, value);
    }
    return value;
  };

  const claims: ClaimInput[] = [];
  const skipped: ClaimInputs['skipped'] = [];
  const referenced = new Set<string>();
  const factual = [...input.sentences].filter((sentence) => sentence.factual).sort((a, b) => a.index - b.index);
  for (const sentence of factual) {
    if (claims.length >= maxClaims) {
      skipped.push({ index: sentence.index, reason: 'too_many' });
      continue;
    }
    const hypothesis = stripCitationMarkers(input.text.slice(sentence.start, sentence.end)).trim().slice(0, MAX_HYPOTHESIS_CHARS).trim();
    if (!hypothesis) {
      skipped.push({ index: sentence.index, reason: 'empty_claim' });
      continue;
    }
    const cited: PremiseCandidate[] = [];
    for (const marker of markers) {
      if (marker.start < sentence.start || marker.start >= sentence.end) continue;
      for (const alias of marker.aliases) {
        const candidate = aliases.has(alias) ? byAlias.get(alias) : undefined;
        if (candidate && !cited.includes(candidate)) cited.push(candidate);
      }
    }
    const pool = cited.length > 0 ? cited : ordered;
    const refs: string[] = [];
    let used = 0;
    for (const candidate of pool) {
      if (refs.length >= MAX_PREMISES) break;
      const size = tokensOf(candidate);
      if (refs.length > 0 && used + size > input.capPerClaim) continue;
      refs.push(candidate.ref);
      used += size;
    }
    if (refs.length === 0) {
      skipped.push({ index: sentence.index, reason: 'no_premise' });
      continue;
    }
    refs.forEach((ref) => referenced.add(ref));
    claims.push({ index: sentence.index, hypothesis, premise_refs: refs });
  }

  let premises = ordered.filter((candidate) => referenced.has(candidate.ref)).map(({ ref, text }) => ({ ref, text }));
  if (premises.length > MAX_PREMISES) {
    premises = premises.slice(0, MAX_PREMISES);
    const kept = new Set(premises.map((premise) => premise.ref));
    for (let i = claims.length - 1; i >= 0; i -= 1) {
      const refs = claims[i]!.premise_refs.filter((ref) => kept.has(ref));
      if (refs.length === 0) {
        skipped.push({ index: claims[i]!.index, reason: 'no_premise' });
        claims.splice(i, 1);
      } else claims[i] = { ...claims[i]!, premise_refs: refs };
    }
  }
  return { premises, claims, skipped };
}

type ClaimFailure = 'timeout' | 'error';

function failedResult(request: ClaimCheckRequest, reason: ClaimFailure, latencyMs: number): ClaimCheckResult {
  return {
    claims: request.claims.map((claim) => ({ index: claim.index, status: 'not_checked', scorer: 'none', score: null, reason })),
    latency_ms: latencyMs,
  };
}

function resolveTimeout(timeoutMs: number | undefined): number {
  if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0) return timeoutMs;
  return readGenerationConfig().groundednessTimeoutMs;
}

/**
 * POSTs one answer's claims to the sidecar's /v1/groundedness/claims (D-22) and never throws: a missing sidecar, a timeout, an HTTP
 * error, a transport failure or an invalid body give every claim not_checked with timeout or error. Logs carry no text.
 */
export async function requestClaimCheck(request: ClaimCheckRequest, options: ClaimClientOptions = {}): Promise<ClaimCheckResult> {
  const started = Date.now();
  const elapsed = () => Math.max(0, Date.now() - started);
  const baseUrl = (options.url ?? env.RAG_SIDECAR_URL ?? '').trim().replace(/\/+$/, '');
  const secret = (options.secret ?? env.RAG_SIDECAR_SECRET ?? '').trim();
  if (!baseUrl || !secret) return failedResult(request, 'error', 0);
  const body = ClaimCheckRequestSchema.safeParse(request);
  if (!body.success) {
    console.warn('[Groundedness] Invalid claims request, not sent', { issues: body.error.issues.length });
    return failedResult(request, 'error', elapsed());
  }

  const timeoutMs = resolveTimeout(options.timeoutMs);
  const fetchImpl = options.fetch ?? fetch;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl}${CLAIMS_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SECRET_HEADER]: secret },
      body: JSON.stringify(body.data),
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      console.warn('[Groundedness] Claims request failed', { httpStatus: response.status, latencyMs: elapsed() });
      return failedResult(request, 'error', elapsed());
    }
    const parsed = ClaimCheckResultSchema.safeParse(await response.json());
    if (!parsed.success) {
      console.warn('[Groundedness] Sidecar returned an invalid claims result', { issues: parsed.error.issues.length });
      return failedResult(request, 'error', elapsed());
    }
    return parsed.data;
  } catch (error) {
    if (timedOut) {
      console.warn('[Groundedness] Claims request timed out', { timeoutMs });
      return failedResult(request, 'timeout', elapsed());
    }
    console.warn('[Groundedness] Claims request failed', { error: error instanceof Error ? error.name : typeof error, latencyMs: elapsed() });
    return failedResult(request, 'error', elapsed());
  } finally {
    clearTimeout(timer);
  }
}

/** Languages the sidecar can score (Phase 5 D-11): en always, zh-Hans only through Vectara. */
export function hasHhemRoute(language: string, allowVectara: boolean): boolean {
  if (language === 'en') return true;
  return language === 'zh-Hans' && allowVectara;
}

const defaultClaimDeps: ClaimStepDeps = {
  readConfig: () => {
    const generation = readGenerationConfig();
    const answer = readAnswerConfig();
    return {
      claimCheck: answer.claimCheck,
      llmJudge: answer.llmJudge,
      judgeModel: answer.judgeModel,
      vectaraOptIn: generation.vectaraOptIn,
      vectaraMultiTenantAck: generation.vectaraMultiTenantAck,
      maxPremiseTokens: generation.maxPremiseTokens,
      groundednessTimeoutMs: generation.groundednessTimeoutMs,
    };
  },
  multiTenant: () => isMultiTenant(),
  request: requestClaimCheck,
  judge: judgeClaims,
  updateChecks: async (admin, input) => (await import('@/lib/answers/store')).updateAnswerChecks(admin, input),
  updateGroundedness: async (admin, input) => (await import('@/lib/answers/store')).updateAnswerGroundedness(admin, input),
  appendReviewReason: async (admin, input) => (await import('@/lib/answers/store')).appendReviewReason(admin, input),
  exportReview: exportReviewCandidate,
  langfuse: () => readLangfuseConfig(),
  exportTrace: async (trace, options) => (await import('../trace/langfuse')).exportTrace(trace, options),
  postScores: postLangfuseScores,
  now: () => new Date(),
  judgeCells: () => loadJudgeThresholds().cells,
  updateTimeoutMs: UPDATE_TIMEOUT_MS,
  langfuseTimeoutMs: LANGFUSE_TIMEOUT_MS,
};

async function withTimeout<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out (timeout)`)), timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function errorCode(error: unknown): string {
  if (error instanceof Error) {
    const match = /\(([A-Za-z0-9_]{1,32})\)$/.exec(error.message);
    if (match) return match[1]!;
    return error.name || 'error';
  }
  return 'unknown';
}

/** The D-14 conditions the record already passed, checked again so the step never runs outside them. */
function eligible(input: AnswerFinishInput): boolean {
  if (input.aborted || !input.groundednessEligible || input.toolOutputUsed || input.refusedByModel === true) return false;
  if (typeof input.chatId === 'string' && input.chatId.startsWith('ghost-')) return false;
  return Array.isArray(input.checks?.sentences);
}

function notChecked(reason: string): SentenceVerdict {
  return { support: 'not_checked', scorer: null, reason };
}

export interface ClaimSummary {
  total: number;
  unsupported: number;
  notChecked: number;
  reasons: Record<string, number>;
  scorer: Scorer | null;
}

function summarize(factual: readonly AnswerSentence[], verdicts: ReadonlyMap<number, SentenceVerdict>): ClaimSummary {
  const reasons: Record<string, number> = {};
  let unsupported = 0;
  let notCheckedCount = 0;
  const scorers = new Set<Scorer>();
  for (const sentence of factual) {
    const verdict = verdicts.get(sentence.index) ?? notChecked('error');
    if (verdict.support === 'unsupported') unsupported += 1;
    if (verdict.support === 'not_checked') {
      notCheckedCount += 1;
      if (verdict.reason) reasons[verdict.reason] = (reasons[verdict.reason] ?? 0) + 1;
    }
    if (verdict.scorer && verdict.support !== 'not_checked') scorers.add(verdict.scorer);
  }
  return { total: factual.length, unsupported, notChecked: notCheckedCount, reasons, scorer: scorers.size === 1 ? [...scorers][0]! : null };
}

/** D-24: unsupported over the sentences that were checked; null when none was. */
export function unsupportedShare(summary: Pick<ClaimSummary, 'total' | 'unsupported' | 'notChecked'>): number | null {
  const checked = summary.total - summary.notChecked;
  return checked > 0 ? summary.unsupported / checked : null;
}

function claimTrace(
  input: AnswerFinishInput,
  summary: ClaimSummary,
  language: string,
  timing: { startedAt: number; endedAt: number },
  judge: { usage: JudgeUsage; startedAt: number; endedAt: number; judgeModel: string | null } | null,
): CollectedTrace {
  const tenantKey = scopeKey(input.scope);
  const stages: CollectedTrace['stages'] = [
    {
      name: 'claim_check',
      status: summary.total > 0 && summary.notChecked === summary.total ? 'skipped' : 'ok',
      startedAt: timing.startedAt,
      endedAt: timing.endedAt,
      latency_ms: Math.max(0, timing.endedAt - timing.startedAt),
      candidates_in: summary.total,
      candidates_out: summary.total - summary.notChecked,
      rules: [],
      attributes: {
        claims_total: summary.total,
        claims_unsupported: summary.unsupported,
        claims_not_checked: summary.notChecked,
        scorer: summary.scorer ?? 'none',
        language,
      },
    },
  ];
  if (judge) {
    stages.push({
      name: 'groundedness_judge',
      status: 'ok',
      startedAt: judge.startedAt,
      endedAt: judge.endedAt,
      latency_ms: judge.usage.latencyMs,
      candidates_in: null,
      candidates_out: null,
      rules: [],
      attributes: {
        input_tokens: judge.usage.inputTokens ?? -1,
        output_tokens: judge.usage.outputTokens ?? -1,
        latency_ms: judge.usage.latencyMs,
        ...(judge.usage.costUsd !== null ? { estimated_cost_usd: judge.usage.costUsd } : {}),
        ...(judge.judgeModel ? { judge_model: judge.judgeModel } : {}),
      },
    });
  }
  return {
    traceId: input.traceId,
    tenantKey,
    profile: 'chat',
    status: 'ok',
    reason: '',
    tags: ['rag-pipeline', 'profile:chat', `tenant:${tenantKey}`],
    startedAt: timing.startedAt,
    endedAt: timing.endedAt,
    stages,
  };
}

/** D-24, D-28: for a trace Langfuse already holds, or an answer with an unsupported sentence. Failures only log. */
async function reportClaims(
  input: AnswerFinishInput,
  summary: ClaimSummary,
  language: string,
  timing: { startedAt: number; endedAt: number },
  judge: Parameters<typeof claimTrace>[4],
  deps: ClaimStepDeps,
): Promise<void> {
  const config = deps.langfuse();
  if (!isLangfuseUsable(config)) return;
  const sampled = isSampled(input.traceId, config.sampleRate, 'trace') || isSampled(input.traceId, config.reviewSampleRate, 'review');
  if (!sampled && summary.unsupported === 0) return;
  const tasks: Array<Promise<unknown>> = [];
  if (OTEL_TRACE_ID.test(input.traceId)) {
    tasks.push(
      withTimeout(
        deps.exportTrace(claimTrace(input, summary, language, timing, judge), { config, flushTimeoutMs: deps.langfuseTimeoutMs }),
        deps.langfuseTimeoutMs + 500,
        'claim span',
      ),
    );
  }
  const share = unsupportedShare(summary);
  if (share !== null) {
    const score: LangfuseScoreInput = {
      traceId: input.traceId,
      name: 'unsupported_claim_share',
      value: share,
      dataType: 'NUMERIC',
      metadata: { language, scorer: summary.scorer ?? 'none', total: summary.total, unsupported: summary.unsupported, not_checked: summary.notChecked },
    };
    tasks.push(withTimeout(deps.postScores([score], { config, timeoutMs: deps.langfuseTimeoutMs }), deps.langfuseTimeoutMs + 500, 'claim scores'));
  }
  const results = await Promise.allSettled(tasks);
  const failed = results.filter((result) => result.status === 'rejected' || (result.value as PostScoresResult | undefined)?.status === 'failed').length;
  if (failed > 0) console.warn('[RAG Trace] Claim report to Langfuse failed', { answerId: input.answerId, failed });
}

/** D-24 with the flagForReview pattern: claim_unsupported on the record, then the masked review copy. Never throws. */
async function flagClaimForReview(input: AnswerFinishInput, admin: SupabaseClient, deps: ClaimStepDeps): Promise<void> {
  try {
    await withTimeout(deps.appendReviewReason(admin, { id: input.answerId, reason: 'claim_unsupported' }), deps.updateTimeoutMs, 'review reason');
  } catch (error) {
    console.warn('[Answer Record] Review reason append failed:', { answerId: input.answerId, code: errorCode(error) });
  }
  const status = await deps
    .exportReview(
      {
        traceId: input.traceId,
        tenantKey: scopeKey(input.scope),
        reason: 'claim_unsupported',
        query: input.queryText,
        answer: input.answerText,
        citedQuotes: input.citations.map((citation) => citation.quote),
        model: input.modelId,
        ...(input.accessSets ? { accessSets: input.accessSets } : {}),
      },
      { config: deps.langfuse(), timeoutMs: deps.langfuseTimeoutMs },
    )
    .catch((): ReviewExportStatus => 'failed');
  if (status === 'failed') console.warn('[RAG Trace] Review export to Langfuse failed', { answerId: input.answerId, reason: 'claim_unsupported' });
}

interface JudgeRun {
  result: JudgeClaimsResult;
  startedAt: number;
  endedAt: number;
}

/** Applies a judge result to its claims (D-25): not_enough_info counts as unsupported with that reason. */
function applyJudge(claims: readonly ClaimInput[], run: JudgeRun, verdicts: Map<number, SentenceVerdict>): void {
  const { result } = run;
  if (result.status !== 'judged') {
    for (const claim of claims) verdicts.set(claim.index, notChecked(result.reason));
    return;
  }
  const byIndex = new Map(result.verdicts.map((verdict) => [verdict.index, verdict]));
  for (const claim of claims) {
    const verdict = byIndex.get(claim.index);
    if (!verdict) verdicts.set(claim.index, notChecked('invalid_output'));
    else if (verdict.verdict === 'supported') verdicts.set(claim.index, { support: 'supported', scorer: 'llm_judge', reason: null });
    else verdicts.set(claim.index, { support: 'unsupported', scorer: 'llm_judge', reason: verdict.verdict === 'not_enough_info' ? 'not_enough_info' : null });
  }
}

/** Resolves the text part the sentence offsets point into: the last text part, checked against the records' text_hash. */
function partText(input: AnswerFinishInput, sentences: readonly AnswerSentence[]): string | null {
  const hash = sentences[0]?.text_hash;
  if (!hash) return input.answerText;
  const candidates = [input.checksText, input.answerText].filter((text): text is string => typeof text === 'string');
  return candidates.find((text) => answerTextHash(text) === hash) ?? null;
}

/**
 * D-22, D-24, D-94: checks every factual sentence after the answer-level score, in the same after() job and within its deadline.
 * Updates checks.sentences[].support and checks.claims, queues claim_unsupported, reports to Langfuse. Never throws, never edits text.
 */
export function createClaimStep(
  overrides: Partial<ClaimStepDeps> = {},
): (context: AnswerPendingContext, options?: ClaimStepOptions) => Promise<ClaimStepOutcome | null> {
  const deps: ClaimStepDeps = { ...defaultClaimDeps, ...overrides };
  return async ({ answerId, input, admin }, options = {}) => {
    try {
      const config = deps.readConfig();
      if (!config.claimCheck || !eligible(input)) return null;
      const sentences = input.checks!.sentences!;
      const factual = sentences.filter((sentence) => sentence.factual);
      if (factual.length === 0) return null;
      const text = partText(input, sentences);
      if (text === null) {
        console.warn('[Groundedness] Claim check skipped: sentence records do not match the answer text', { answerId });
        return null;
      }

      const startedAt = Date.now();
      const deadlineAt = options.deadlineAt ?? startedAt + config.groundednessTimeoutMs;
      const language = answerGroundednessLanguage(input.answerText);
      const allowVectara = allowVectaraFor(config, deps.multiTenant());
      const built = buildClaimInputs({
        text,
        sentences,
        blocks: input.premise.blocks,
        webSearchTexts: input.premise.webSearchTexts,
        capPerClaim: config.maxPremiseTokens,
      });
      const verdicts = new Map<number, SentenceVerdict>();
      for (const entry of built.skipped) verdicts.set(entry.index, notChecked(entry.reason));

      let judgeRun: JudgeRun | null = null;
      let toJudge: ClaimInput[] = [];
      if (built.claims.length > 0) {
        if (hasHhemRoute(language, allowVectara)) {
          const remaining = deadlineAt - Date.now();
          const result: ClaimCheckResult =
            remaining > 0
              ? await deps.request(
                  { request_id: answerId, language, premises: built.premises, claims: built.claims, allow_vectara: allowVectara },
                  { timeoutMs: remaining },
                )
              : failedResult({ request_id: answerId, language, premises: built.premises, claims: built.claims, allow_vectara: allowVectara }, 'timeout', 0);
          const byIndex = new Map(result.claims.map((claim) => [claim.index, claim]));
          for (const claim of built.claims) {
            const verdict = byIndex.get(claim.index);
            if (!verdict) verdicts.set(claim.index, notChecked('error'));
            else if (verdict.status === 'scored' && verdict.score !== null && verdict.scorer !== 'none') {
              const labelled = labelGroundedness(
                { status: 'scored', scorer: verdict.scorer, score: verdict.score, reason: null, truncated: false, latency_ms: result.latency_ms },
                language,
              );
              verdicts.set(claim.index, { support: labelled.label === 'verified' ? 'supported' : 'unsupported', scorer: verdict.scorer, reason: null });
            } else if (verdict.reason === 'unsupported_language') toJudge.push(claim);
            else verdicts.set(claim.index, notChecked(verdict.reason ?? 'error'));
          }
        } else {
          toJudge = built.claims;
        }

        if (toJudge.length > 0 && !config.llmJudge) {
          for (const claim of toJudge) verdicts.set(claim.index, notChecked('unsupported_language'));
        } else if (toJudge.length > 0) {
          const remaining = deadlineAt - Date.now();
          const judgeStarted = Date.now();
          const refs = new Set(toJudge.flatMap((claim) => claim.premise_refs));
          const result: JudgeClaimsResult =
            remaining > 0
              ? await deps.judge({
                  language,
                  premises: built.premises.filter((premise) => refs.has(premise.ref)),
                  claims: toJudge,
                  generatorModelId: input.modelId,
                  judgeModel: config.judgeModel,
                  signal: AbortSignal.timeout(remaining),
                })
              : { status: 'not_checked', reason: 'timeout', judgeModel: config.judgeModel || null, judgeVersion: null, usage: null };
          judgeRun = { result, startedAt: judgeStarted, endedAt: Date.now() };
          applyJudge(toJudge, judgeRun, verdicts);
        }
      }

      const summary = summarize(factual, verdicts);
      const judgeVersion = judgeRun?.result.judgeVersion ?? null;
      const updated: AnswerSentence[] = sentences.map((sentence) => {
        if (!sentence.factual) return sentence;
        const verdict = verdicts.get(sentence.index) ?? notChecked('error');
        return { ...sentence, support: verdict.support, scorer: verdict.scorer, reason: verdict.reason };
      });
      const checks = AnswerChecksSchema.parse({
        ...input.checks,
        text_language: detectLanguage(input.answerText),
        sentences: updated,
        claims: {
          total: summary.total,
          unsupported: summary.unsupported,
          not_checked: summary.notChecked,
          reasons: summary.reasons,
          scorer: summary.scorer,
          judge_version: judgeVersion,
        },
      });
      try {
        await withTimeout(deps.updateChecks(admin, { id: answerId, checks }), deps.updateTimeoutMs, 'checks update');
      } catch (error) {
        console.warn('[Answer Record] Checks update failed:', { answerId, code: errorCode(error) });
      }
      const endedAt = Date.now();

      console.log('[Groundedness] Claims', {
        answerId,
        language,
        total: summary.total,
        unsupported: summary.unsupported,
        notChecked: summary.notChecked,
        reasons: summary.reasons,
        scorer: summary.scorer ?? 'none',
        latencyMs: endedAt - startedAt,
        ...(judgeRun ? { judge: judgeRun.result.status === 'judged' ? 'judged' : judgeRun.result.reason } : {}),
      });

      let groundedness: AnswerGroundedness | undefined;
      if (judgeRun?.result.status === 'judged' && !hasHhemRoute(language, allowVectara)) {
        groundedness = judgeAnswerLabel({
          judgements: judgeRun.result.verdicts,
          judgeModel: judgeRun.result.judgeModel,
          judgeVersion: judgeRun.result.judgeVersion,
          language,
          latencyMs: judgeRun.result.usage.latencyMs,
          cells: deps.judgeCells(),
          now: deps.now,
        });
        try {
          await withTimeout(deps.updateGroundedness(admin, { id: answerId, groundedness }), deps.updateTimeoutMs, 'groundedness update');
        } catch (error) {
          console.warn('[Answer Record] Groundedness update failed:', { answerId, code: errorCode(error) });
        }
        if (groundedness.label === 'possibly_unreliable') {
          try {
            await withTimeout(deps.appendReviewReason(admin, { id: answerId, reason: 'groundedness_flagged' }), deps.updateTimeoutMs, 'review reason');
          } catch (error) {
            console.warn('[Answer Record] Review reason append failed:', { answerId, code: errorCode(error) });
          }
        }
      }

      if (summary.unsupported > 0) await flagClaimForReview(input, admin, deps);
      const judgeSpan =
        judgeRun && judgeRun.result.usage
          ? { usage: judgeRun.result.usage, startedAt: judgeRun.startedAt, endedAt: judgeRun.endedAt, judgeModel: judgeRun.result.judgeModel }
          : null;
      await reportClaims(input, summary, language, { startedAt, endedAt }, judgeSpan, deps);
      return groundedness ? { groundedness } : {};
    } catch (error) {
      console.warn('[Answer Record] Claim step failed:', { answerId, code: errorCode(error) });
      return null;
    }
  };
}
