import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod/v3';
import type { DictionaryCandidate, TrainingPair } from '@/lib/rag-eval/contracts.generated';

export const GoldenExportLineSchema = z.any();
export type GoldenExportLine = { id: string; query_masked: string | null; label: { paraphrased_question: string | null }; evidence: Array<{ chunk_id: string; quote_verified: boolean; chunk_text: string | null }> };
export interface MarkItem { id: string; split?: 'dev' | 'test'; split_group?: string }
export interface MarkResult { marked: unknown[]; conflicts: unknown[]; ignored: unknown[] }

export async function exportDictionary(_admin: SupabaseClient, _tenantKey: string): Promise<DictionaryCandidate[]> { return []; }
export async function exportTraining(_admin: SupabaseClient, _tenantKey: string): Promise<TrainingPair[]> { return []; }
export async function exportGolden(_admin: SupabaseClient, _tenantKey: string): Promise<GoldenExportLine[]> { return []; }
export async function markExported(_admin: SupabaseClient, _tenantKey: string, _items: MarkItem[]): Promise<MarkResult> { return { marked: [], conflicts: [], ignored: [] }; }
