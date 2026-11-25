import type { SupabaseClient } from '@supabase/supabase-js';
import type { InsertAnswerRecordInput } from '@/lib/answers/store';
import type { CitationRecord } from '@/lib/rag-eval/contracts.generated';
import type { TenantScope } from '../tenant/scope';
import type { GenerationConfig } from './config';

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
  queryText: string;
  citations: CitationRecord[];
  citationStrategy: CitationRecord['strategy'] | null;
  invalidCitations: number;
  answerText: string;
  aborted: boolean;
  groundednessEligible: boolean;
  toolOutputUsed: boolean;
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
  onPending?: (context: AnswerPendingContext) => Promise<void>;
}

export function shouldPersistAnswer(_input: ShouldPersistAnswerInput): boolean {
  return false;
}

export function mintAnswerId(): string {
  return '';
}

export function scheduleAnswerFinish(_input: AnswerFinishInput, _deps: Partial<AnswerFinishDeps> = {}): void {}
