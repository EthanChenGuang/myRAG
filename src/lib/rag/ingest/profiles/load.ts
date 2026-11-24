import type { z } from 'zod/v3';
import type { ProcessingProfileSetSchema } from '@/lib/rag-eval/contracts.generated';
import rawProfiles from '../../../../../config/rag/processing-profiles.json';

export type ProcessingProfileSet = z.infer<typeof ProcessingProfileSetSchema>;
export type ProcessingProfile = ProcessingProfileSet['profiles'][number];
export type DocType = ProcessingProfile['doc_type'];

export function loadProcessingProfiles(): ProcessingProfileSet {
  return rawProfiles as unknown as ProcessingProfileSet;
}

export function parseProcessingProfileSet(raw: unknown): ProcessingProfileSet {
  return raw as ProcessingProfileSet;
}

export function getProcessingProfile(docType: DocType): ProcessingProfile {
  return loadProcessingProfiles().profiles.find((profile) => profile.doc_type === docType) as ProcessingProfile;
}

export function getClausePatterns(_docType: DocType): readonly RegExp[] {
  return [];
}

export function resetProcessingProfilesForTests(): void {}
