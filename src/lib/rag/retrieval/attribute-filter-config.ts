import { AttributeFilterConfigSchema, type AttributeFilterConfig } from '@/lib/rag-eval/contracts.generated';
import rawConfig from '../../../../config/rag/attribute-filter.json';

/** The contract has no lexicon row cap field, so the cap of the value read is this constant (D-29). */
export const ATTRIBUTE_LEXICON_ROW_CAP = 5000;

let loaded: AttributeFilterConfig | null = null;
let override: AttributeFilterConfig | null = null;

/** The numbers of config/rag/attribute-filter.json, validated once with the generated schema (D-30). */
export function attributeFilterConfig(): AttributeFilterConfig {
  if (override) return override;
  if (!loaded) loaded = AttributeFilterConfigSchema.parse(rawConfig);
  return loaded;
}

export function setAttributeFilterConfigForTests(config: unknown | null): void {
  override = config === null ? null : AttributeFilterConfigSchema.parse(config);
}
