import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AnswerGroundednessValue, InsertAnswerRecordInput } from '@/lib/answers/store';
import type { CitationRecord } from '@/lib/rag-eval/contracts.generated';
import { getSupabaseAdmin } from '@/lib/supabase';
import { detectLanguage } from '../lang/detect';
import { isTenantScope, type TenantScope } from '../tenant/scope';
import { scheduleAfterResponse } from '../trace/schedule';
import { readGenerationConfig, type GenerationConfig } from './config';

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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCHEDULED_LIMIT = 2048;
const scheduled = new Set<string>();

const defaultDeps: AnswerFinishDeps = {
  admin: () => getSupabaseAdmin(),
  insert: async (admin, input) => (await import('@/lib/answers/store')).insertAnswerRecord(admin, input),
  schedule: scheduleAfterResponse,
  readConfig: () => readGenerationConfig(),
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
