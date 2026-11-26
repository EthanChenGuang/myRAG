import type { OutputGuardRules } from '@/lib/rag-eval/contracts.generated';

export function loadOutputGuardRules(_filePath?: string): OutputGuardRules {
  return { schema_version: 1, version: 'stub', credential_rules: [] };
}

export function outputGuardRulesVersion(_filePath?: string): string {
  return '';
}

export function matchCredentialSentence(_sentence: string, _language?: string): string[] {
  return [];
}
