import fs from 'node:fs';
import path from 'node:path';
import type {
  LanguageDeclaration,
  LanguageValidationResult,
  NormalizedLanguageSettings,
} from '../../../config/rag/validate-language-settings.cjs';

const ROOT = path.resolve(__dirname, '..', '..', '..');
export const REGISTRY_PATH = path.join(ROOT, 'config', 'rag', 'language-packs.json');
export const CASES_PATH = path.join(ROOT, 'tests', 'fixtures', 'lang', 'validate-cases.json');

export type RawRegistry = { schema_version: number; packs: Array<Record<string, unknown> & { code: string }> };

export interface RegistryChange {
  base: string;
  op: 'set' | 'delete';
  path: string[];
  value?: unknown;
}

export interface LangCase {
  name: string;
  supported: string | null;
  primary: string | null;
  context: {
    reranker: LanguageDeclaration | null;
    embeddingProfile: LanguageDeclaration | null;
    registryChange?: RegistryChange;
  };
  expect: Omit<LanguageValidationResult, 'normalized'> & {
    normalized: LanguageValidationResult['normalized'];
    settings?: NormalizedLanguageSettings;
  };
}

export function loadLangCases(): LangCase[] {
  return (JSON.parse(fs.readFileSync(CASES_PATH, 'utf8')) as { cases: LangCase[] }).cases;
}

export function shippedRegistry(): RawRegistry {
  return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8')) as RawRegistry;
}

/** The shipped registry with the case's one change applied (a fresh copy every call). */
export function registryForCase(entry: LangCase): RawRegistry {
  const registry = shippedRegistry();
  const change = entry.context.registryChange;
  if (!change) return registry;
  const pack = registry.packs.find((candidate) => candidate.code === change.base);
  if (!pack) throw new Error(`no pack ${change.base}`);
  let target: Record<string, unknown> = pack;
  for (const key of change.path.slice(0, -1)) target = target[key] as Record<string, unknown>;
  const last = change.path[change.path.length - 1];
  if (change.op === 'delete') delete target[last];
  else target[last] = change.value;
  return registry;
}

/** The result fields a case pins (settings is checked separately). */
export function expectedResult(entry: LangCase): LanguageValidationResult {
  const { settings: _settings, ...result } = entry.expect;
  return result;
}

export interface ActiveProfileCase {
  name: string;
  supported: string | null;
  primary: string | null;
  activeProfile: { id: string; provider: string; model: string };
  database: 'reachable' | 'unreachable';
  expect: LanguageValidationResult;
}

/** Phase 3.2.1 adapter-level cases: the declaration comes from the catalog of the active profile's model. */
export function loadActiveProfileCases(): ActiveProfileCase[] {
  return (JSON.parse(fs.readFileSync(CASES_PATH, 'utf8')) as { activeProfileCases: ActiveProfileCase[] }).activeProfileCases;
}
