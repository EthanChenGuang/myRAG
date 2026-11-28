import fs from 'node:fs';
import path from 'node:path';
import {
  BASELINE_DIR,
  baselineCommand,
  baselineRelativePath,
  planLanguageChange as planLanguageChangeCore,
  type LanguageChangeContext,
  type LanguageChangeInput,
  type LanguageChangePlan,
  type LanguageChangeRefusal,
  type LanguageChangeStep,
} from '../../../../config/rag/language-change-plan.cjs';
import { getLanguageRegistry } from './registry';
import { activeEmbeddingDeclaration, activeRerankerDeclaration } from './settings';

export type { LanguageChangeContext, LanguageChangeInput, LanguageChangePlan, LanguageChangeRefusal, LanguageChangeStep };
export { BASELINE_DIR, baselineCommand, baselineRelativePath };

/** LANG-11: the change plan for a proposed language set (pure; see config/rag/language-change-plan.cjs). */
export function planLanguageChange(input: LanguageChangeInput, context: LanguageChangeContext): LanguageChangePlan {
  return planLanguageChangeCore(input, context);
}

/** The absolute path of a language's baseline record under root; null for a value that is not a language code. */
export function languageBaselinePath(root: string, code: string): string | null {
  const relative = baselineRelativePath(code);
  return relative === null ? null : path.join(root, relative);
}

/** Where a live run (private golden slice) records the language baseline: with the private golden data, untracked. */
export const LIVE_BASELINE_DIR = 'eval/golden/private/baselines/languages';

function recordFor(file: string | null, code: string): boolean {
  if (file === null || !fs.existsSync(file)) return false;
  try {
    const record = JSON.parse(fs.readFileSync(file, 'utf8')) as { language?: unknown };
    return record.language === code;
  } catch {
    return false;
  }
}

/** A baseline check: a record for the language exists (fixture or live) and parses with the language's code. */
export function baselineChecker(root: string): (code: string) => boolean {
  return (code) => {
    const fixture = languageBaselinePath(root, code);
    if (fixture === null) return false;
    return recordFor(fixture, code) || recordFor(path.join(root, LIVE_BASELINE_DIR, `${code}.json`), code);
  };
}

/** The app's context: the registry, the active reranker and the active embedding profile's declaration. */
export async function appLanguageChangeContext(root: string): Promise<LanguageChangeContext & { verifiedAgainstActiveProfile: boolean }> {
  const { declaration, verified } = await activeEmbeddingDeclaration();
  return {
    registry: getLanguageRegistry(),
    reranker: activeRerankerDeclaration(),
    embeddingProfile: declaration,
    hasBaseline: baselineChecker(root),
    verifiedAgainstActiveProfile: verified,
  };
}
