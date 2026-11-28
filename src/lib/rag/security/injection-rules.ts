import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export { loadInjectionRules, scanText } from './injection-scan';

let memoised: string | null = null;

function versionOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 12);
}

/**
 * The rule-set version: the first 12 hex characters of the sha256 of config/rag/injection-rules.json as stored on
 * disk. InjectionRuleSet.schema_version is the contract version, so any edit to the rules changes this value instead.
 * Memoised per process for the default file; a path argument hashes that file and is not memoised.
 */
export function injectionRulesVersion(filePath?: string): string {
  if (filePath) return versionOf(readFileSync(filePath));
  if (!memoised) memoised = versionOf(readFileSync(path.join(process.cwd(), 'config', 'rag', 'injection-rules.json')));
  return memoised;
}
