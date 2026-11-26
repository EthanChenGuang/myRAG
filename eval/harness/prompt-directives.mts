import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Harness-only detector for a refusal directive in a system prompt (Phase 5.3 D-13): the instruction to say that the
 * documents do not answer. Patterns live in config/rag/prompt-directives.json and describe the instruction, not a subject.
 * Never imported by src/.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const PROMPT_DIRECTIVES_PATH = path.join(REPO_ROOT, 'config/rag/prompt-directives.json');
const MAX_PATTERN_CHARS = 600;

export interface LanguageDirectives {
  directives: RegExp[];
  negations: RegExp[];
}

export interface PromptDirectives {
  languages: Record<string, LanguageDirectives>;
}

function patternList(file: string, field: string, language: string, value: unknown): RegExp[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`[Prompt Directives] ${file}: ${field}.${language} must be a non-empty list of patterns`);
  }
  return value.map((source, index) => {
    if (typeof source !== 'string' || source.length === 0 || source.length > MAX_PATTERN_CHARS) {
      throw new Error(`[Prompt Directives] ${file}: ${field}.${language}[${index}] must be a pattern of 1 to ${MAX_PATTERN_CHARS} characters`);
    }
    try {
      return new RegExp(source, 'iu');
    } catch (error) {
      throw new Error(`[Prompt Directives] ${file}: ${field}.${language}[${index}] does not compile: ${(error as Error).message}`);
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads and validates the patterns file: schema_version 1, the same languages under refusal_directive and negation. */
export function loadPromptDirectives(file: string = PROMPT_DIRECTIVES_PATH): PromptDirectives {
  const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!isRecord(raw) || raw.schema_version !== 1) throw new Error(`[Prompt Directives] ${file}: schema_version must be 1`);
  const directives = raw.refusal_directive;
  const negations = raw.negation;
  if (!isRecord(directives) || !isRecord(negations)) {
    throw new Error(`[Prompt Directives] ${file}: refusal_directive and negation must be objects keyed by language`);
  }
  const languages = Object.keys(directives).sort();
  if (languages.length === 0 || languages.join(',') !== Object.keys(negations).sort().join(',')) {
    throw new Error(`[Prompt Directives] ${file}: refusal_directive and negation must name the same languages`);
  }
  const result: Record<string, LanguageDirectives> = {};
  for (const language of languages) {
    result[language] = {
      directives: patternList(file, 'refusal_directive', language, directives[language]),
      negations: patternList(file, 'negation', language, negations[language]),
    };
  }
  return { languages: result };
}

let cached: PromptDirectives | null = null;

/** True when a refusal-directive pattern of any language matches the prompt and no negation pattern does. */
export function hasRefusalDirective(prompt: string, directives?: PromptDirectives): boolean {
  if (prompt.trim() === '') return false;
  const loaded = directives ?? (cached ??= loadPromptDirectives());
  const entries = Object.values(loaded.languages);
  if (entries.some((entry) => entry.negations.some((pattern) => pattern.test(prompt)))) return false;
  return entries.some((entry) => entry.directives.some((pattern) => pattern.test(prompt)));
}
