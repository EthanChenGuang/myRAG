import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { OutputGuardRulesSchema, type OutputGuardRules } from '@/lib/rag-eval/contracts.generated';
import rawRules from '../../../../config/rag/output-guard-rules.json';
import { hasBackreference, normalise } from './injection-scan';

/**
 * D-39: credential and account-request rules from config/rag/output-guard-rules.json. A rule matches a sentence when
 * one of its request terms and one of its secret terms both occur in it. Terms and text go through the normaliser that
 * ingestion and retrieval use (NFKC, invisible characters removed, lower case, whitespace collapsed); a term that starts
 * or ends with a Latin-like letter or digit must start or end at a word boundary.
 */

export interface CompiledCredentialRule {
  id: string;
  language: string;
  request: readonly string[];
  secret: readonly string[];
}

let memoisedVersion: string | null = null;
let memoisedRules: OutputGuardRules | null = null;
const compiledCache = new WeakMap<OutputGuardRules, CompiledCredentialRule[]>();

const DEFAULT_FILE = (): string => path.join(process.cwd(), 'config', 'rag', 'output-guard-rules.json');
const UNSPACED_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

function versionOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 12);
}

/** Validates an output-guard rules document with the generated schema; rejects obfuscation patterns with back-references. */
export function parseOutputGuardRules(raw: unknown): OutputGuardRules {
  const rules = OutputGuardRulesSchema.parse(raw);
  for (const item of rules.obfuscation_patterns ?? []) {
    if (hasBackreference(item.pattern)) {
      throw new Error(`[RAG Security] output-guard rule ${item.id}: back-references are not allowed`);
    }
  }
  const ids = [...(rules.credential_rules ?? []).map((rule) => rule.id), ...(rules.obfuscation_patterns ?? []).map((item) => item.id)];
  if (new Set(ids).size !== ids.length) throw new Error('[RAG Security] output-guard rule ids must be unique');
  return rules;
}

/** The committed rules file (memoised per process), or the file at `filePath` (not memoised). Throws when invalid. */
export function loadOutputGuardRules(filePath?: string): OutputGuardRules {
  if (filePath) return parseOutputGuardRules(JSON.parse(readFileSync(filePath, 'utf8')));
  if (!memoisedRules) memoisedRules = parseOutputGuardRules(rawRules);
  return memoisedRules;
}

/** First 12 hex characters of the sha256 of the rules file as stored on disk (the injectionRulesVersion form). */
export function outputGuardRulesVersion(filePath?: string): string {
  if (filePath) return versionOf(readFileSync(filePath));
  if (!memoisedVersion) memoisedVersion = versionOf(readFileSync(DEFAULT_FILE()));
  return memoisedVersion;
}

/** A character that continues a word for the boundary check: a letter or digit outside the unspaced scripts. */
export function isWordChar(char: string | undefined): boolean {
  return char !== undefined && char !== '' && LETTER_OR_DIGIT.test(char) && !UNSPACED_SCRIPT.test(char);
}

/** True when normalised `term` occurs in normalised `text` at `index` with its word boundaries satisfied. */
export function termAt(text: string, term: string, index: number): boolean {
  if (!text.startsWith(term, index)) return false;
  const first = term[0];
  const last = term[term.length - 1];
  if (isWordChar(first) && isWordChar(text[index - 1])) return false;
  if (isWordChar(last) && isWordChar(text[index + term.length])) return false;
  return true;
}

function containsTerm(text: string, term: string): boolean {
  let index = text.indexOf(term);
  while (index >= 0) {
    if (termAt(text, term, index)) return true;
    index = text.indexOf(term, index + 1);
  }
  return false;
}

/** Credential rules with their terms normalised, cached per rules document. */
export function compileCredentialRules(rules: OutputGuardRules = loadOutputGuardRules()): CompiledCredentialRule[] {
  let compiled = compiledCache.get(rules);
  if (!compiled) {
    const terms = (list: readonly string[]) => [...new Set(list.map((term) => normalise(term, '')).filter(Boolean))];
    compiled = (rules.credential_rules ?? []).map((rule) => ({
      id: rule.id,
      language: rule.language,
      request: terms(rule.request_terms),
      secret: terms(rule.secret_terms),
    }));
    compiledCache.set(rules, compiled);
  }
  return compiled;
}

/**
 * The ids of the credential rules that match `sentence`: rules of `language` and of `any`, or every rule when no
 * language is given. A match needs a request term and a secret term of the same rule in the sentence.
 */
export function matchCredentialSentence(
  sentence: string,
  language?: string,
  rules: readonly CompiledCredentialRule[] = compileCredentialRules(),
): string[] {
  const text = normalise(sentence, '');
  if (text === '') return [];
  const ids: string[] = [];
  for (const rule of rules) {
    if (language !== undefined && rule.language !== language && rule.language !== 'any') continue;
    if (rule.request.some((term) => containsTerm(text, term)) && rule.secret.some((term) => containsTerm(text, term))) {
      ids.push(rule.id);
    }
  }
  return ids;
}
