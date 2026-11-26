import type { z } from 'zod/v3';
import { LanguageRegistrySchema, type LanguageSettings } from '@/lib/rag-eval/contracts.generated';
import rawRegistry from '../../../../config/rag/language-packs.json';
import { TEXT_KEYS as SHARED_TEXT_KEYS } from '../../../../config/rag/validate-language-settings.cjs';

export type LanguageRegistry = z.infer<typeof LanguageRegistrySchema>;
export type LanguagePack = LanguageRegistry['packs'][number];
/** The generated language code type (D-06): the registry codes as exported into the contracts. */
export type Language = NonNullable<LanguageSettings['languages']>[number];

type PackTexts = LanguagePack['texts'];
/** Phase 5.2 D-08: a fixed-text key, `<group>.<key>`, derived from the generated LanguagePack contract. */
export type TextKey = { [G in keyof PackTexts]: `${G & string}.${keyof PackTexts[G] & string}` }[keyof PackTexts];
/** Every fixed-text key in the order of rag_sidecar.contracts.languages.TEXT_KEYS. */
export const TEXT_KEYS = SHARED_TEXT_KEYS as readonly TextKey[];

/** The text of `key` in `pack`, or null when the pack lacks it. `key` must be one of TEXT_KEYS. */
export function packText(pack: LanguagePack, key: TextKey): string | null {
  const [group, name] = key.split('.') as [keyof PackTexts, string];
  return (pack.texts[group] as Record<string, string | null>)[name] ?? null;
}

const FIXED_PARTS = ['segmentation', 'ocr_codes.docling', 'ocr_codes.llamaparse', 'rewrite_gate_lexicon'] as const;
const FIXTURE_PARTS = ['fixtures.corpus', 'fixtures.golden_slices'] as const;
export type CompletenessPart = (typeof FIXED_PARTS)[number] | `texts.${TextKey}` | (typeof FIXTURE_PARTS)[number];
/** D-04 completeness parts (every text key since Phase 5.2 D-08), in the order rag_sidecar.contracts.languages.COMPLETENESS_PARTS lists them. */
export const COMPLETENESS_PARTS: readonly CompletenessPart[] = [
  ...FIXED_PARTS,
  ...TEXT_KEYS.map((key) => `texts.${key}` as const),
  ...FIXTURE_PARTS,
];

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
  const present = {
    segmentation: pack.segmentation !== null,
    'ocr_codes.docling': pack.ocr_codes.docling !== null,
    'ocr_codes.llamaparse': pack.ocr_codes.llamaparse !== null,
    rewrite_gate_lexicon: pack.rewrite_gate_lexicon !== null,
    ...Object.fromEntries(TEXT_KEYS.map((key) => [`texts.${key}`, packText(pack, key) !== null])),
    'fixtures.corpus': pack.fixtures.corpus,
    'fixtures.golden_slices': pack.fixtures.golden_slices,
  } as Record<CompletenessPart, boolean>;
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
