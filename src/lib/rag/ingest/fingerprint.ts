import type { IngestFingerprintParts } from '@/lib/rag-eval/contracts.generated';
import type { LanguageSettings } from '../lang/settings';
import type { StageContext } from './types';

export const FINGERPRINT_CHUNKING_PROFILE_ID = 'legacy';
export const EMBEDDING_PROFILE_VERSION = 1;

export function buildIngestFingerprint(_parts: IngestFingerprintParts): string {
  return '';
}

export function effectiveOcrLanguages(_profileOcrLanguages: readonly string[], _settings: LanguageSettings): string[] {
  return [];
}

export function ocrEngineCodes(_parserUsed: string, _ocrLanguages: readonly string[]): string[] {
  return [];
}

export function collectFingerprintParts(_ctx: StageContext): IngestFingerprintParts {
  return {} as IngestFingerprintParts;
}

export function expectedFingerprintFor(parts: IngestFingerprintParts, _proposed: Record<string, string | undefined>): { parts: IngestFingerprintParts; fingerprint: string } {
  return { parts, fingerprint: '' };
}
