import { SupersessionRulesSchema, type SupersessionRules } from '@/lib/rag-eval/contracts.generated';
import rawRules from '../../../../../config/rag/supersession-rules.json';
import type { PostPublishEvent } from '../post-publish';

export const SUPERSESSION_HOOK = 'supersession';

export function supersessionRules(): SupersessionRules {
  return SupersessionRulesSchema.parse(rawRules);
}

export interface SupersessionDocument {
  documentId: string;
  lineageId: string | null;
  filename: string;
  docType: string | null;
  language: string | null;
  docDate: string | null;
  effectiveFrom: string | null;
  contentHash: string | null;
  content: string | null;
}

export interface DetectedCandidate {
  candidateDocumentId: string;
  signals: { title_match: boolean; content_overlap_percent: number; conflicting_numbers: number };
  direction: 'document_newer' | 'candidate_newer' | null;
}

export function contentOverlap(_a: string, _b: string, _rules?: SupersessionRules): { percent: number; conflictingNumbers: number } {
  return { percent: 0, conflictingNumbers: 0 };
}

export function detectSupersessionCandidates(_d: SupersessionDocument, _p: readonly SupersessionDocument[], _r?: SupersessionRules): DetectedCandidate[] {
  return [];
}

export function supersessionDetectOn(): boolean {
  return false;
}

type Register = (name: string, run: (event: PostPublishEvent, signal: AbortSignal) => Promise<void>, options: { timeoutMs: number }) => void;

export function registerSupersessionHook(_register: Register): void {}
