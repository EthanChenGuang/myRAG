import { BoilerplateRulesConfigSchema, type BoilerplateRulesConfig } from '@/lib/rag-eval/contracts.generated';
import rawConfig from '../../../../../config/rag/boilerplate-rules.json';

let loadedConfig: BoilerplateRulesConfig | null = null;
let configOverride: BoilerplateRulesConfig | null = null;

/** The page-cleaning thresholds in config/rag/boilerplate-rules.json, validated once with the generated schema. */
export function boilerplateConfig(): BoilerplateRulesConfig {
  if (configOverride) return configOverride;
  if (!loadedConfig) loadedConfig = BoilerplateRulesConfigSchema.parse(rawConfig);
  return loadedConfig;
}

export function setBoilerplateConfigForTests(raw: unknown | null): void {
  configOverride = raw === null ? null : BoilerplateRulesConfigSchema.parse(raw);
}
