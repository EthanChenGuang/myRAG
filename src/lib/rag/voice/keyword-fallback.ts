import type { SupabaseClient } from '@supabase/supabase-js';
import { tenantPredicate, type TenantScope } from '../tenant/scope';

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

export interface VoiceKeywordFallbackInput {
  query: string;
  scope: TenantScope;
  admin: SupabaseClient;
  signal: AbortSignal;
  existing: VoiceChunk[];
}

interface ChunkQueryResult {
  data: VoiceChunk[] | null;
  error: { message: string } | null;
}

interface ChunkFilter {
  not(column: string, operator: string, value: unknown): ChunkFilter;
  or(filters: string): ChunkFilter;
  in(column: string, values: string[]): ChunkFilter;
  limit(count: number): { abortSignal(signal: AbortSignal): PromiseLike<{ data: unknown; error: { message: string } | null }> };
}

function chunkSelect(admin: SupabaseClient, columns: string): ChunkFilter {
  return admin.from('document_chunks').select(columns) as unknown as ChunkFilter;
}

const STOP_WORDS = new Set(['the', 'is', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'for', 'on', 'with', 'by', 'at', 'show', 'me', 'what', 'where', 'can', 'you', 'please', 'who']);

const SYNONYMS: Record<string, string[]> = {
  creator: ['created', 'maker', 'founder', 'built'],
  created: ['creator', 'maker', 'founder', 'built'],
  maker: ['creator', 'created', 'founder'],
  founder: ['creator', 'created'],
  logo: ['icon', 'symbol'],
};

const IMAGE_INTENT_WORDS = ['show', 'see', 'look', 'view', 'logo', 'image', 'picture', 'photo', 'icon', 'symbol', 'who', 'creator', 'created', 'founder', 'maker'];
const PERSON_QUERY_WORDS = ['who', 'creator', 'founder', 'created', 'maker'];
const PERSON_TERMS = ['carlos', 'marcial', 'creator', 'founder', 'maker', 'author'];

const MAX_SCOPE_DOCUMENTS = 500;
const DOCUMENT_BATCH_SIZE = 100;

export function deriveVoiceKeywords(query: string): VoiceKeywords {
  let cleanQuery = '';
  let keywords: string[] = [];
  let searchKeywords: string[] = [];

  if (query.split(' ').length < 15) {
    cleanQuery = query
      .toLowerCase()
      .replace(/['’]s/g, '')
      .replace(/[^\w\s]/g, '');

    keywords = cleanQuery.split(/\s+/).filter((w) => !STOP_WORDS.has(w) && w.length > 2);

    const expanded = [...keywords];
    keywords.forEach((kw) => {
      if (SYNONYMS[kw]) expanded.push(...SYNONYMS[kw]);
    });
    searchKeywords = [...new Set(expanded)];
  }

  return { cleanQuery, keywords, searchKeywords };
}

async function inScopeDocumentIds(admin: SupabaseClient, scope: TenantScope, signal: AbortSignal): Promise<string[] | null> {
  const predicate = tenantPredicate(scope);
  if (predicate.kind === 'none') return null;

  const base = admin.from('documents').select('id');
  const scoped =
    predicate.kind === 'org' ? base.eq('organization_id', predicate.organizationId) : base.eq('user_id', predicate.userId).is('organization_id', null);
  const { data, error } = await scoped.limit(MAX_SCOPE_DOCUMENTS).abortSignal(signal);
  if (error) throw new Error(`[Voice Keyword Fallback] in-scope document lookup failed: ${error.message}`);

  const ids = ((data ?? []) as Array<{ id: string }>).map((row) => row.id);
  if (ids.length >= MAX_SCOPE_DOCUMENTS) {
    console.warn('[Document Search] Voice keyword fallback limited to the first in-scope documents', { limit: MAX_SCOPE_DOCUMENTS });
  }
  return ids;
}

async function queryChunks(
  admin: SupabaseClient,
  documentIds: string[] | null,
  signal: AbortSignal,
  columns: string,
  refine: (query: ChunkFilter) => ChunkFilter,
  limit: number,
): Promise<ChunkQueryResult> {
  if (documentIds === null) {
    const { data, error } = await refine(chunkSelect(admin, columns)).limit(limit).abortSignal(signal);
    return { data: data as VoiceChunk[] | null, error };
  }
  if (documentIds.length === 0) return { data: [], error: null };

  const batches: string[][] = [];
  for (let i = 0; i < documentIds.length; i += DOCUMENT_BATCH_SIZE) batches.push(documentIds.slice(i, i + DOCUMENT_BATCH_SIZE));

  const responses = await Promise.all(
    batches.map((batch) => refine(chunkSelect(admin, columns).in('document_id', batch)).limit(limit).abortSignal(signal)),
  );
  const failed = responses.find((response) => response.error);
  if (failed?.error) return { data: null, error: failed.error };
  const data = responses.flatMap((response) => (response.data ?? []) as VoiceChunk[]).slice(0, limit);
  return { data, error: null };
}

function matchesAny(text: string, terms: string[]): boolean {
  const lower = text.toLowerCase();
  return terms.some((term) => lower.includes(term));
}

function imageMeta(chunk: VoiceChunk): string {
  return `${chunk.metadata?.name || ''} ${chunk.metadata?.image_context || ''}`;
}

/**
 * Text-based retrieval for named entities that vector search can miss. In personal and org scopes every chunk
 * query is restricted to the documents the scope owns, so keyword hits cannot cross tenants.
 */
export async function voiceKeywordFallback(input: VoiceKeywordFallbackInput): Promise<VoiceChunk[]> {
  const { query, scope, admin, signal } = input;
  const chunks: VoiceChunk[] = input.existing.map((chunk) => ({ ...chunk }));

  const { keywords, searchKeywords } = deriveVoiceKeywords(query);
  if (searchKeywords.length === 0) return chunks;

  console.log('[Document Search] Voice keyword search', { keywords: searchKeywords });

  const documentIds = await inScopeDocumentIds(admin, scope, signal);
  const queryLower = query.toLowerCase();

  // Single-tenant vector rows carry no id, so only chunks added here are deduplicated; kept for output parity.
  const existingIds = new Set(chunks.map((c) => c.id));

  const isImageIntent = IMAGE_INTENT_WORDS.some((w) => queryLower.includes(w));
  if (isImageIntent) {
    const imageConditions = searchKeywords.map((kw) => `metadata->>image_context.ilike.%${kw}%,metadata->>name.ilike.%${kw}%`).join(',');

    const { data: imageData, error: imageError } = await queryChunks(
      admin,
      documentIds,
      signal,
      'id, document_id, content, metadata',
      (q) => q.not('metadata->>image_url', 'is', 'null').or(imageConditions),
      20,
    );

    if (!imageError && imageData && imageData.length > 0) {
      let matchesToProcess = imageData;

      if (queryLower.includes('logo')) {
        const logoSpecific = imageData.filter(
          (img) => (img.metadata?.name || '').toLowerCase().includes('logo') || (img.metadata?.image_context || '').toLowerCase().includes('logo'),
        );
        if (logoSpecific.length > 0) matchesToProcess = logoSpecific;
      } else if (PERSON_QUERY_WORDS.some((w) => queryLower.includes(w))) {
        const creatorMatches = imageData.filter((img) => matchesAny(imageMeta(img), PERSON_TERMS));
        if (creatorMatches.length > 0) matchesToProcess = creatorMatches;
      }

      matchesToProcess.forEach((img) => {
        if (existingIds.has(img.id)) {
          const existingChunk = chunks.find((c) => c.id === img.id);
          if (existingChunk) existingChunk.similarity = 3.0;
        } else {
          chunks.push({ ...img, similarity: 3.0 });
          existingIds.add(img.id);
        }
      });
    }
  }

  const keyPhrase = keywords.join('%');
  const phraseConditions = [`metadata->>name.ilike.%${keyPhrase}%`, `metadata->>image_context.ilike.%${keyPhrase}%`];

  const { data: phraseData } = await queryChunks(admin, documentIds, signal, 'id, document_id, content, metadata', (q) => q.or(phraseConditions.join(',')), 100);

  if (phraseData && phraseData.length > 0) {
    const phraseIds = new Set(chunks.map((c) => c.id));
    for (const pc of phraseData) {
      if (!phraseIds.has(pc.id)) {
        chunks.push({ ...pc, similarity: 2.0 });
        phraseIds.add(pc.id);
      }
    }
  }

  const conditions: string[] = [];
  searchKeywords.forEach((kw) => {
    conditions.push(`metadata->>image_context.ilike.%${kw}%`);
    conditions.push(`metadata->>name.ilike.%${kw}%`);
    if (['creator', 'created', 'founder', 'maker', 'carlos', 'marcial'].includes(kw)) {
      conditions.push(`content.ilike.%${kw}%`);
    }
  });

  if (conditions.length > 0) {
    const { data: keywordData, error: keywordError } = await queryChunks(
      admin,
      documentIds,
      signal,
      'id, document_id, content, metadata',
      (q) => q.or(conditions.join(',')),
      50,
    );

    if (!keywordError && keywordData && keywordData.length > 0) {
      const scored = keywordData.map((kc) => {
        const matchText = [kc.metadata?.image_context || '', kc.metadata?.name || '', kc.content || ''].join(' ').toLowerCase();

        let matchCount = 0;
        for (const kw of keywords) {
          if (matchText.includes(kw)) matchCount++;
        }

        const isLogoQuery = keywords.includes('logo');
        const isLogoContent = matchText.includes('logo');
        const isPersonQuery = ['creator', 'founder', 'carlos', 'who'].some((k) => keywords.includes(k));
        const isPersonContent = ['carlos', 'marcial', 'creator', 'founder'].some((k) => matchText.includes(k));

        let penalty = 0;
        if (isLogoQuery && !isLogoContent) penalty = 0.5;
        if (isLogoContent && !isLogoQuery) penalty = 0.2;

        let relevance = matchCount / Math.max(1, keywords.length);
        if (isLogoQuery && isLogoContent) relevance += 0.4;
        if (isPersonQuery && isPersonContent) relevance += 0.4;
        relevance -= penalty;

        return { ...kc, keywordRelevance: Math.max(0.1, relevance) };
      });

      scored.sort((a, b) => b.keywordRelevance - a.keywordRelevance);

      const relevantChunks = scored.filter((kc) => kc.keywordRelevance >= 0.25);

      const keywordIds = new Set(chunks.map((c) => c.id));
      for (const kc of relevantChunks.slice(0, 5)) {
        if (!keywordIds.has(kc.id)) {
          chunks.push({ ...kc, similarity: kc.keywordRelevance });
          keywordIds.add(kc.id);
        }
      }
    } else if (keywordError) {
      console.warn('[Document Search] Voice keyword fallback error', { message: keywordError.message });
    }
  }

  return chunks;
}
