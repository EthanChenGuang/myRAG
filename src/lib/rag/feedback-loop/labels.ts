import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod/v3';
import { ExpertLabelSchema, type ExpertLabel } from '@/lib/rag-eval/contracts.generated';

type Client = SupabaseClient;

export function normalizeQuoteText(text: string): string {
  return text;
}

export const LabelRequestSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('labelled'), label: ExpertLabelSchema }).strict(),
  z.object({ status: z.literal('skipped') }).strict(),
]);
export type LabelRequest = z.infer<typeof LabelRequestSchema>;

export type EvidenceFailureReason = 'chunk_not_in_tenant' | 'chunk_not_servable' | 'document_mismatch' | 'quote_empty' | 'quote_not_found';

export type SaveLabelResult =
  | { ok: true; item_id: string; status: 'labelled' | 'skipped'; triage: string[]; label: ExpertLabel | null; labelled_at: string }
  | { ok: false; reason: 'not_found' | 'exported' }
  | { ok: false; reason: 'invalid_evidence'; span: number; detail: EvidenceFailureReason }
  | { ok: false; reason: 'invalid_not_relevant'; index: number };

export async function validateAndSaveLabel(_ssr: Client, _admin: Client, _id: string, _request: LabelRequest, _expertId: string): Promise<SaveLabelResult> {
  return { ok: false, reason: 'not_found' };
}
