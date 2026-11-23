import type { SupabaseClient } from '@supabase/supabase-js';
import type { TenantScope } from '../tenant/scope';

export interface VoiceChunk {
  id?: string;
  chunk_id?: string;
  document_id?: string;
  content?: string;
  similarity?: number;
  metadata?: Record<string, any> | null;
  keywordRelevance?: number;
  embedding?: number[];
}

export interface VoiceKeywords {
  cleanQuery: string;
  keywords: string[];
  searchKeywords: string[];
}

export function deriveVoiceKeywords(_query: string): VoiceKeywords {
  return { cleanQuery: '', keywords: [], searchKeywords: [] };
}

export interface VoiceKeywordFallbackInput {
  query: string;
  scope: TenantScope;
  admin: SupabaseClient;
  signal: AbortSignal;
  existing: VoiceChunk[];
}

export async function voiceKeywordFallback(_input: VoiceKeywordFallbackInput): Promise<VoiceChunk[]> {
  return [];
}
