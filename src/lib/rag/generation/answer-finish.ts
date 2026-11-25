import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AnswerGroundednessValue, InsertAnswerRecordInput } from '@/lib/answers/store';
import type { CitationRecord } from '@/lib/rag-eval/contracts.generated';
import { getSupabaseAdmin } from '@/lib/supabase';
import { detectLanguage } from '../lang/detect';
import { isTenantScope, type TenantScope } from '../tenant/scope';
import { scheduleAfterResponse } from '../trace/schedule';
import { isMultiTenant } from '@/lib/deployment-mode';
import { scopeKey } from '../tenant/scope';
import { isLangfuseUsable, readLangfuseConfig, type LangfuseConfig } from '../trace/config';
import type { CollectedTrace, ExportTraceOptions } from '../trace/langfuse';
import { isSampled } from '../trace/sample';
import { postLangfuseScores, type LangfuseScoreInput, type PostScoresOptions, type PostScoresResult } from '../trace/scores';
import type { StageRunStatus } from '../types';
import { readGenerationConfig, type GenerationConfig } from './config';
import { answerGroundednessLanguage, scoreAnswerGroundedness, type AnswerGroundedness } from './groundedness';
import { requestGroundedness } from './groundedness-client';

export type AnswerSwitches = Pick<GenerationConfig, 'citations' | 'claudeCitations' | 'groundedness' | 'feedback'>;

export interface ShouldPersistAnswerInput {
  capabilities: { citations: boolean } | null | undefined;
  userId: string | null | undefined;
  chatId: string | null | undefined;
  config: AnswerSwitches;
}

export interface AnswerFinishInput {
  answerId: string;
  scope: TenantScope;
  userId: string;
  chatId: string | null;
  traceId: string;
  modelId: string;
  ragMode: InsertAnswerRecordInput['ragMode'];
  /** The last user question; kept in memory for later review copies, never stored by this module. */
  queryText: string;
  /** Full records from the citation session, not the capped metadata copy. */
  citations: CitationRecord[];
  citationStrategy: CitationRecord['strategy'] | null;
  invalidCitations: number;
  answerText: string;
  aborted: boolean;
  groundednessEligible: boolean;
  toolOutputUsed: boolean;
  /** The evidence sent to the model: alias blocks in order, plus webSearch result texts when that tool ran. */
  premise: { blocks: Array<{ alias: string; text: string }>; webSearchTexts: string[] };
  requestLanguage: string;
}

export interface AnswerPendingContext {
  answerId: string;
  input: AnswerFinishInput;
  admin: SupabaseClient;
}

export interface AnswerFinishDeps {
  admin: () => SupabaseClient | null;
  insert: (admin: SupabaseClient, input: InsertAnswerRecordInput) => Promise<{ inserted: boolean }>;
  schedule: (task: () => Promise<void>) => void;
  readConfig: () => Pick<GenerationConfig, 'groundedness'>;
  /** Continues with scoring when the record was inserted as pending. */
  onPending?: (context: AnswerPendingContext) => Promise<void>;
}

export interface GroundednessStepDeps {
  readConfig: () => Pick<GenerationConfig, 'vectaraOptIn' | 'vectaraMultiTenantAck' | 'maxPremiseTokens' | 'groundednessTimeoutMs'>;
  multiTenant: () => boolean;
  request: typeof requestGroundedness;
  update: (admin: SupabaseClient, input: { id: string; groundedness: AnswerGroundedness }) => Promise<boolean>;
  langfuse: () => LangfuseConfig;
  exportTrace: (trace: CollectedTrace, options: ExportTraceOptions) => Promise<void>;
  postScores: (scores: readonly LangfuseScoreInput[], options: PostScoresOptions) => Promise<PostScoresResult>;
  now: () => Date;
  updateTimeoutMs: number;
  langfuseTimeoutMs: number;
}

const UPDATE_TIMEOUT_MS = 5000;
const LANGFUSE_TIMEOUT_MS = 3000;
const OTEL_TRACE_ID = /^[0-9a-f]{32}$/;

const defaultStepDeps: GroundednessStepDeps = {
  readConfig: () => readGenerationConfig(),
  multiTenant: () => isMultiTenant(),
  request: requestGroundedness,
  update: async (admin, input) => (await import('@/lib/answers/store')).updateAnswerGroundedness(admin, input),
  langfuse: () => readLangfuseConfig(),
  exportTrace: async (trace, options) => (await import('../trace/langfuse')).exportTrace(trace, options),
  postScores: postLangfuseScores,
  now: () => new Date(),
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

function stageStatusOf(groundedness: AnswerGroundedness): StageRunStatus {
  if (groundedness.status === 'scored') return 'ok';
  if (groundedness.reason === 'timeout') return 'timeout';
  if (groundedness.reason === 'error') return 'error';
  return 'skipped';
}

function groundednessTrace(
  input: AnswerFinishInput,
  groundedness: AnswerGroundedness,
  language: string,
  startedAt: number,
  endedAt: number,
): CollectedTrace {
  const tenantKey = scopeKey(input.scope);
  return {
    traceId: input.traceId,
    tenantKey,
    profile: 'chat',
    status: groundedness.status,
    reason: groundedness.reason ?? '',
    tags: ['rag-pipeline', 'profile:chat', `tenant:${tenantKey}`],
    startedAt,
    endedAt,
    stages: [
      {
        name: 'groundedness',
        status: stageStatusOf(groundedness),
        startedAt,
        endedAt,
        latency_ms: groundedness.latencyMs ?? Math.max(0, endedAt - startedAt),
        candidates_in: null,
        candidates_out: null,
        rules: [],
        attributes: {
          groundedness_status: groundedness.status,
          scorer: groundedness.scorer ?? 'none',
          label: groundedness.label ?? 'not_checked',
          language,
          truncated: groundedness.truncated,
          ...(groundedness.reason ? { groundedness_reason: groundedness.reason } : {}),
        },
      },
    ],
  };
}

function groundednessScores(input: AnswerFinishInput, groundedness: AnswerGroundedness, language: string): LangfuseScoreInput[] {
  const metadata = {
    status: groundedness.status,
    scorer: groundedness.scorer ?? 'none',
    language,
    threshold: groundedness.threshold,
    thresholdSource: groundedness.thresholdSource,
    reason: groundedness.reason,
    truncated: groundedness.truncated,
  };
  const scores: LangfuseScoreInput[] = [];
  if (typeof groundedness.score === 'number') {
    scores.push({ traceId: input.traceId, name: 'groundedness', value: groundedness.score, dataType: 'NUMERIC', metadata });
  }
  scores.push({ traceId: input.traceId, name: 'groundedness_label', value: groundedness.label ?? 'not_checked', dataType: 'CATEGORICAL', metadata });
  return scores;
}

/** D-15: only for a trace Langfuse already holds (trace or review sample), or a possibly_unreliable label; failures leave the log line as the record. */
async function reportGroundedness(
  input: AnswerFinishInput,
  groundedness: AnswerGroundedness,
  language: string,
  timing: { startedAt: number; endedAt: number },
  deps: GroundednessStepDeps,
): Promise<void> {
  const config = deps.langfuse();
  if (!isLangfuseUsable(config)) return;
  const sampled = isSampled(input.traceId, config.sampleRate, 'trace') || isSampled(input.traceId, config.reviewSampleRate, 'review');
  if (!sampled && groundedness.label !== 'possibly_unreliable') return;
  const tasks: Array<Promise<unknown>> = [];
  if (OTEL_TRACE_ID.test(input.traceId)) {
    const trace = groundednessTrace(input, groundedness, language, timing.startedAt, timing.endedAt);
    tasks.push(withTimeout(deps.exportTrace(trace, { config, flushTimeoutMs: deps.langfuseTimeoutMs }), deps.langfuseTimeoutMs + 500, 'groundedness span'));
  }
  tasks.push(
    withTimeout(deps.postScores(groundednessScores(input, groundedness, language), { config, timeoutMs: deps.langfuseTimeoutMs }), deps.langfuseTimeoutMs + 500, 'groundedness scores'),
  );
  const results = await Promise.allSettled(tasks);
  const failed = results.filter((result) => result.status === 'rejected' || (result.value as PostScoresResult | undefined)?.status === 'failed').length;
  if (failed > 0) console.warn('[RAG Trace] Groundedness report to Langfuse failed', { answerId: input.answerId, failed });
}

/** The onPending continuation (D-15): score, store, log, then report to Langfuse when allowed. Never throws. */
export function createGroundednessStep(overrides: Partial<GroundednessStepDeps> = {}): (context: AnswerPendingContext) => Promise<void> {
  const deps: GroundednessStepDeps = { ...defaultStepDeps, ...overrides };
  return async ({ answerId, input, admin }) => {
    try {
      const startedAt = Date.now();
      let groundedness: AnswerGroundedness;
      try {
        groundedness = await scoreAnswerGroundedness(
          {
            answerId,
            answerText: input.answerText,
            blocks: input.premise.blocks,
            citedAliases: input.citations.map((citation) => citation.alias),
            webSearchTexts: input.premise.webSearchTexts,
            eligibility: { eligible: true },
            multiTenant: deps.multiTenant(),
            config: deps.readConfig(),
          },
          { request: deps.request, now: deps.now },
        );
      } catch (error) {
        console.warn('[Answer Record] Groundedness scoring failed:', { answerId, code: errorCode(error) });
        groundedness = { ...notChecked('error'), scorer: 'none', score: null, threshold: null, thresholdSource: null, truncated: false, latencyMs: 0, checkedAt: deps.now().toISOString() };
      }
      const endedAt = Date.now();
      const language = answerGroundednessLanguage(input.answerText);

      try {
        await withTimeout(deps.update(admin, { id: answerId, groundedness }), deps.updateTimeoutMs, 'groundedness update');
      } catch (error) {
        console.warn('[Answer Record] Groundedness update failed:', { answerId, code: errorCode(error) });
      }

      console.log('[Groundedness]', {
        answerId,
        status: groundedness.status,
        scorer: groundedness.scorer,
        label: groundedness.label,
        language,
        truncated: groundedness.truncated,
        latencyMs: groundedness.latencyMs,
      });

      await reportGroundedness(input, groundedness, language, { startedAt, endedAt }, deps);
    } catch (error) {
      console.warn('[Answer Record] Groundedness step failed:', { answerId, code: errorCode(error) });
    }
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCHEDULED_LIMIT = 2048;
const scheduled = new Set<string>();

const defaultDeps: AnswerFinishDeps = {
  admin: () => getSupabaseAdmin(),
  insert: async (admin, input) => (await import('@/lib/answers/store')).insertAnswerRecord(admin, input),
  schedule: scheduleAfterResponse,
  readConfig: () => readGenerationConfig(),
  onPending: createGroundednessStep(),
};

/** Ghost chats, anonymous callers, callers without the citations capability and requests with every Phase 5 switch off persist nothing. */
export function shouldPersistAnswer(input: ShouldPersistAnswerInput): boolean {
  if (input.capabilities?.citations !== true) return false;
  if (typeof input.userId !== 'string' || input.userId.length === 0) return false;
  if (typeof input.chatId === 'string' && input.chatId.startsWith('ghost-')) return false;
  const { citations, claudeCitations, groundedness, feedback } = input.config;
  return citations || claudeCitations || groundedness || feedback;
}

export function mintAnswerId(): string {
  return randomUUID();
}

function claim(answerId: string): boolean {
  if (scheduled.has(answerId)) return false;
  if (scheduled.size >= SCHEDULED_LIMIT) {
    const oldest = scheduled.values().next().value;
    if (oldest !== undefined) scheduled.delete(oldest);
  }
  scheduled.add(answerId);
  return true;
}

function errorCode(error: unknown): string {
  if (error instanceof Error) {
    const match = /\(([A-Za-z0-9_]{1,32})\)$/.exec(error.message);
    if (match) return match[1];
    if (error.name === 'ZodError') return 'invalid_record';
    return error.name || 'error';
  }
  return 'unknown';
}

function scopeOrganization(scope: TenantScope): string | null {
  return scope.kind === 'org' ? scope.organizationId : null;
}

function notChecked(reason: string): AnswerGroundednessValue {
  return { status: 'not_checked', label: 'not_checked', reason } as AnswerGroundednessValue;
}

function initialGroundedness(input: AnswerFinishInput, enabled: boolean): AnswerGroundednessValue {
  if (input.aborted) return notChecked('aborted');
  if (!enabled) return notChecked('disabled');
  if (!input.groundednessEligible) return notChecked('not_eligible');
  if (input.toolOutputUsed) return notChecked('tool_output');
  return { status: 'pending' } as AnswerGroundednessValue;
}

/** The chat is linked only when the session user owns it and its organization matches the request scope. */
async function ownedChatId(admin: SupabaseClient, input: AnswerFinishInput): Promise<string | null> {
  if (input.chatId === null || !UUID_RE.test(input.chatId)) return null;
  const chatId = input.chatId.toLowerCase();
  const userId = input.userId.toLowerCase();
  try {
    const { data, error } = await admin.from('chats').select('id,user_id,organization_id').eq('id', chatId).eq('user_id', userId).maybeSingle();
    if (error) {
      console.warn('[Answer Record] Chat lookup failed; record left unlinked:', { answerId: input.answerId, code: error.code ?? 'unknown' });
      return null;
    }
    const row = data as { id?: unknown; user_id?: unknown; organization_id?: unknown } | null;
    if (!row || String(row.id).toLowerCase() !== chatId || String(row.user_id).toLowerCase() !== userId) return null;
    const chatOrganization = typeof row.organization_id === 'string' ? row.organization_id.toLowerCase() : null;
    return chatOrganization === scopeOrganization(input.scope) ? chatId : null;
  } catch (error) {
    console.warn('[Answer Record] Chat lookup failed; record left unlinked:', { answerId: input.answerId, code: errorCode(error) });
    return null;
  }
}

async function finishAnswer(input: AnswerFinishInput, deps: AnswerFinishDeps): Promise<void> {
  if (!isTenantScope(input.scope)) throw new Error('unminted tenant scope');
  const admin = deps.admin();
  if (!admin) throw new Error('admin client unavailable');
  const groundedness = initialGroundedness(input, deps.readConfig().groundedness);
  const chatId = await ownedChatId(admin, input);
  const { inserted } = await deps.insert(admin, {
    id: input.answerId,
    scope: input.scope,
    userId: input.userId,
    chatId,
    traceId: input.traceId,
    modelId: input.modelId,
    citationStrategy: input.citationStrategy,
    ragMode: input.ragMode,
    answerLanguage: detectLanguage(input.answerText),
    invalidCitations: input.invalidCitations,
    citations: input.citations,
    groundedness,
  });
  if (!inserted || groundedness.status !== 'pending' || !deps.onPending) return;
  try {
    await deps.onPending({ answerId: input.answerId, input, admin });
  } catch (error) {
    console.warn('[Answer Record] Post-insert step failed:', { answerId: input.answerId, code: errorCode(error) });
  }
}

/** Writes the answer record after the response; runs once per answerId and never throws into the caller. */
export function scheduleAnswerFinish(input: AnswerFinishInput, deps: Partial<AnswerFinishDeps> = {}): void {
  try {
    if (!claim(input.answerId)) return;
    const resolved: AnswerFinishDeps = { ...defaultDeps, ...deps };
    resolved.schedule(async () => {
      try {
        await finishAnswer(input, resolved);
      } catch (error) {
        console.error('[Answer Record] Insert failed:', { answerId: input.answerId, code: errorCode(error) });
      }
    });
  } catch (error) {
    console.error('[Answer Record] Scheduling failed:', { answerId: input.answerId, code: errorCode(error) });
  }
}
