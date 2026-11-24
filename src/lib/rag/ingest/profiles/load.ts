import type { z } from 'zod/v3';
import { ProcessingProfileSetSchema } from '@/lib/rag-eval/contracts.generated';
import rawProfiles from '../../../../../config/rag/processing-profiles.json';

export type ProcessingProfileSet = z.infer<typeof ProcessingProfileSetSchema>;
export type ProcessingProfile = ProcessingProfileSet['profiles'][number];
export type DocType = ProcessingProfile['doc_type'];

interface LoadedProfiles {
  set: ProcessingProfileSet;
  byType: Map<DocType, ProcessingProfile>;
  clausePatterns: Map<DocType, readonly RegExp[]>;
}

const DOC_TYPES: readonly DocType[] = ProcessingProfileSetSchema.shape.profiles.element.shape.doc_type.options;
const TIER_RANK = { fast: 0, structured: 1, premium: 2 } as const;

let loaded: LoadedProfiles | null = null;

function fail(message: string): never {
  throw new Error(`[Ingest Config] ${message}`);
}

function requireUnique(values: readonly string[], profileId: string, what: string): void {
  if (new Set(values).size !== values.length) fail(`${profileId}: ${what} must not repeat a value`);
}

function compileClausePatterns(profile: ProcessingProfile): RegExp[] {
  return (profile.chunker.clause_patterns ?? []).map((pattern, index) => {
    try {
      return new RegExp(pattern, 'u');
    } catch {
      return fail(`${profile.id}: clause pattern ${index} does not compile`);
    }
  });
}

function checkProfile(profile: ProcessingProfile): void {
  const { id, chunker } = profile;
  if (id !== `${profile.doc_type}@${profile.version}`) fail(`${id}: id must equal <doc_type>@<version>`);
  if (chunker.overlap_tokens >= chunker.max_tokens) fail(`${id}: overlap_tokens must be smaller than max_tokens`);
  if (chunker.min_chunk_tokens > chunker.max_tokens) fail(`${id}: min_chunk_tokens must not exceed max_tokens`);
  requireUnique(profile.parser.preference, id, 'parser preference');
  requireUnique(profile.parser.ocr_languages, id, 'ocr_languages');
  requireUnique(profile.extractors, id, 'extractors');
  if (profile.min_tier && profile.max_tier && TIER_RANK[profile.min_tier] > TIER_RANK[profile.max_tier]) {
    fail(`${id}: min_tier must not rank above max_tier`);
  }
  if (profile.parent_child && profile.parent_child.child_max_tokens >= profile.parent_child.parent_max_tokens) {
    fail(`${id}: child_max_tokens must be smaller than parent_max_tokens`);
  }
}

function build(raw: unknown): LoadedProfiles {
  const set = ProcessingProfileSetSchema.parse(raw);
  const byType = new Map<DocType, ProcessingProfile>();
  const clausePatterns = new Map<DocType, readonly RegExp[]>();
  for (const profile of set.profiles) {
    if (byType.has(profile.doc_type)) fail(`doc type ${profile.doc_type} has more than one profile`);
    checkProfile(profile);
    byType.set(profile.doc_type, profile);
    clausePatterns.set(profile.doc_type, compileClausePatterns(profile));
  }
  const missing = DOC_TYPES.filter((docType) => !byType.has(docType));
  if (missing.length > 0) fail(`missing profiles for doc types: ${missing.join(', ')}`);
  return { set, byType, clausePatterns };
}

/**
 * Validates a profile set with the generated schema and the rules JSON Schema cannot express
 * (one profile per type, id consistency, token budgets, tier order, clause patterns compile).
 */
export function parseProcessingProfileSet(raw: unknown): ProcessingProfileSet {
  return build(raw).set;
}

function current(): LoadedProfiles {
  if (!loaded) loaded = build(rawProfiles);
  return loaded;
}

export function loadProcessingProfiles(): ProcessingProfileSet {
  return current().set;
}

export function getProcessingProfile(docType: DocType): ProcessingProfile {
  return current().byType.get(docType) ?? fail(`unknown doc type ${String(docType)}`);
}

export function profileFor(_source: string, docType: DocType): ProcessingProfile {
  return getProcessingProfile(docType);
}

export function getClausePatterns(docType: DocType): readonly RegExp[] {
  return current().clausePatterns.get(docType) ?? fail(`unknown doc type ${String(docType)}`);
}

export function resetProcessingProfilesForTests(): void {
  loaded = null;
}
