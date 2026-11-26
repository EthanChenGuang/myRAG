import type { TerminologyLexicon, TerminologyLexiconTerm } from '@/lib/rag-eval/contracts.generated';
import type { TenantScope } from '../tenant/scope';

export type { TerminologyLexicon };

export interface TerminologyLexiconOptions {
  languages?: readonly string[];
  kinds?: readonly TerminologyLexiconTerm['kind'][];
  includeTranslations?: boolean;
}

export class TerminologyUnavailableError extends Error {}

export async function getTerminologyLexicon(_scope: TenantScope, _opts: TerminologyLexiconOptions = {}): Promise<TerminologyLexicon> {
  return { version: 's0.w0', entries_sha256: '0'.repeat(64), terms: [], translations: [] };
}

export function resetTerminologyLexiconForTests(): void {}
