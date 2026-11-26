import type { z } from 'zod/v3';
import { LanguageRegistrySchema, type LanguageSettings } from '@/lib/rag-eval/contracts.generated';
import rawRegistry from '../../../../config/rag/language-packs.json';

export type LanguageRegistry = z.infer<typeof LanguageRegistrySchema>;
export type LanguagePack = LanguageRegistry['packs'][number];
/** The generated language code type (D-06): the registry codes as exported into the contracts. */
export type Language = NonNullable<LanguageSettings['languages']>[number];

/** D-04 completeness parts, in the order rag_sidecar.contracts.languages.COMPLETENESS_PARTS lists them. */
export const COMPLETENESS_PARTS = [
  'segmentation',
  'ocr_codes.docling',
  'ocr_codes.llamaparse',
  'rewrite_gate_lexicon',
  'texts.strict_refusal',
  'fixtures.corpus',
  'fixtures.golden_slices',
] as const;
export type CompletenessPart = (typeof COMPLETENESS_PARTS)[number];

interface LoadedRegistry {
  registry: LanguageRegistry;
  byCode: Map<string, LanguagePack>;
}

let loaded: LoadedRegistry | null = null;
let override: unknown = undefined;

function fail(message: string): never {
  throw new Error(`[Language Registry] ${message}`);
}

function checkPatterns(pack: LanguagePack): void {
  const lists = {
    effective_date_patterns: pack.effective_date_patterns,
    effective_date_end_patterns: pack.effective_date_end_patterns,
    version_markers: pack.version_markers,
  };
  for (const [field, patterns] of Object.entries(lists)) {
    patterns.forEach((pattern, index) => {
      try {
        new RegExp(pattern, 'u');
      } catch {
        fail(`${pack.code}: ${field} pattern ${index} does not compile`);
      }
    });
  }
}

function build(raw: unknown): LoadedRegistry {
  const registry = LanguageRegistrySchema.parse(raw);
  const byCode = new Map<string, LanguagePack>();
  for (const pack of registry.packs) {
    if (byCode.has(pack.code)) fail(`duplicate language codes: ${pack.code}`);
    checkPatterns(pack);
    byCode.set(pack.code, pack);
  }
  return { registry, byCode };
}

/** Validates a registry with the generated schema and the rules JSON Schema cannot express (unique codes, patterns compile). */
export function parseLanguageRegistry(raw: unknown): LanguageRegistry {
  return build(raw).registry;
}

function current(): LoadedRegistry {
  if (!loaded) loaded = build(override === undefined ? rawRegistry : override);
  return loaded;
}

export function getLanguageRegistry(): LanguageRegistry {
  return current().registry;
}

export function getLanguagePack(code: string): LanguagePack | undefined {
  return current().byCode.get(code);
}

/** The D-04 parts this pack lacks, in COMPLETENESS_PARTS order; empty when complete. */
export function packMissingParts(pack: LanguagePack): CompletenessPart[] {
  const present: Record<CompletenessPart, boolean> = {
    segmentation: pack.segmentation !== null,
    'ocr_codes.docling': pack.ocr_codes.docling !== null,
    'ocr_codes.llamaparse': pack.ocr_codes.llamaparse !== null,
    rewrite_gate_lexicon: pack.rewrite_gate_lexicon !== null,
    'texts.strict_refusal': pack.texts.strict_refusal !== null,
    'fixtures.corpus': pack.fixtures.corpus,
    'fixtures.golden_slices': pack.fixtures.golden_slices,
  };
  return COMPLETENESS_PARTS.filter((part) => !present[part]);
}

export function completePacks(): LanguagePack[] {
  return current().registry.packs.filter((pack) => packMissingParts(pack).length === 0);
}

/** The known codes among `codes`, deduplicated, in registry order (never the order given). */
export function registryOrder(codes: readonly string[]): string[] {
  const wanted = new Set(codes);
  return current()
    .registry.packs.map((pack) => pack.code)
    .filter((code) => wanted.has(code));
}

export function setLanguageRegistryForTests(raw: unknown): void {
  override = raw;
  loaded = null;
}

export function resetLanguageRegistryForTests(): void {
  override = undefined;
  loaded = null;
}
