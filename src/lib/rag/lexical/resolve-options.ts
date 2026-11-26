import type { RagConfig } from '../config';
import type { TenantScope } from '../tenant/scope';
import type { LexicalOptions } from './options';

export type LexicalSwitches = { v2: Pick<RagConfig['v2'], 'lexicalDictionary' | 'lexicalStemIt' | 'identifierIndex'> };
export type LexicalOptionsWarning = 'lexical_dictionary_unavailable' | 'identifier_patterns_unavailable';
export interface LexicalStamp {
  dictVersion: string | null;
  patterns: string | null;
}
export interface ResolvedLexicalOptions {
  options: LexicalOptions | undefined;
  stamp: LexicalStamp;
  warnings: LexicalOptionsWarning[];
}
export type LexicalOptionsResolver = (scope: TenantScope, config: LexicalSwitches, input: { language: string | null; signal?: AbortSignal }) => Promise<ResolvedLexicalOptions>;

export async function resolveLexicalOptions(
  _scope: TenantScope,
  _config: LexicalSwitches,
  _input: { language: string | null; signal?: AbortSignal },
): Promise<ResolvedLexicalOptions> {
  return { options: undefined, stamp: { dictVersion: null, patterns: null }, warnings: [] };
}

export function setLexicalOptionsResolverForTests(_resolver: LexicalOptionsResolver): void {}

export function resetLexicalOptionsForTests(): void {}
