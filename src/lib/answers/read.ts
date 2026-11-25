import type { SupabaseClient } from '@supabase/supabase-js';
import type { AnswerRecordRow } from './store';

export type DocumentAvailability = 'current' | 'unavailable';

export function toAnswerRecord(_row: AnswerRecordRow, _now: Date, _documents: Record<string, DocumentAvailability>, _options: { feedbackEnabled: boolean }): unknown {
  return {};
}

export async function documentStatuses(_client: SupabaseClient, _documentIds: string[]): Promise<Record<string, DocumentAvailability>> {
  return {};
}
