import { createHash } from 'node:crypto';
import type { QueryParams } from '@/lib/rag-eval/contracts.generated';
import type { QueryAdditionSwitches, QueryLayerConfig } from '../config';
import { canonicalJson, type RetrievalConfigHashQueryLayer } from '../v2/config-hash';
import langchainContextualize from './prompts/langchain.contextualize.v1.json';
import langchainDecompose from './prompts/langchain.decompose.v1.json';
import langchainHyde from './prompts/langchain.hyde.v1.json';
import langchainMultiQuery from './prompts/langchain.multi-query.v1.json';
import llamaindexCondense from './prompts/llamaindex.condense.v1.json';
import llamaindexFusion from './prompts/llamaindex.fusion.v1.json';
import llamaindexHydeEn from './prompts/llamaindex.hyde.en.v1.json';
import llamaindexHydeIt from './prompts/llamaindex.hyde.it.v1.json';
import llamaindexHydeZh from './prompts/llamaindex.hyde.zh.v1.json';
import llamaindexSubq from './prompts/llamaindex.subq.v1.json';
import sharedSubqFilters from './prompts/shared.subq-filters.v1.json';
import sharedSuffix from './prompts/shared.suffix.v1.json';
import sharedTranslate from './prompts/shared.translate.v1.json';

/**
 * Prompt files whose version enters the hash in their own switch-gated block instead of this list, so the hash with their switch
 * off keeps its value: shared.glossary (D-14) is in the glossary block (glossaryHashBlock); shared.subq-filters joins `prompts`
 * only while RAG_QUERY_SUBQ_FILTERS is effective (queryLayerHashComponent's subqFilters argument).
 */
export const SWITCH_GATED_PROMPT_IDS: ReadonlySet<string> = new Set(['shared.glossary', sharedSubqFilters.id]);

/** Every query-layer prompt file except SWITCH_GATED_PROMPT_IDS; a test fails when a file in prompts/ is missing here. */
const PROMPT_FILES: ReadonlyArray<{ id: string; version: number }> = [
  langchainContextualize,
  langchainDecompose,
  langchainHyde,
  langchainMultiQuery,
  llamaindexCondense,
  llamaindexFusion,
  llamaindexHydeEn,
  llamaindexHydeIt,
  llamaindexHydeZh,
  llamaindexSubq,
  sharedSuffix,
  sharedTranslate,
];

/** Prompt file id to version. */
export function queryPromptVersions(): Record<string, number> {
  return Object.fromEntries(PROMPT_FILES.map((file) => [file.id, file.version]));
}

/**
 * 06.2 G5: the query-addition switches that change retrieval but have no prompt or block of their own, with their defaults. A
 * switch enters the hash only while its value differs from its default, so the hash at the defaults keeps its value.
 */
export const QUERY_ADDITION_HASH_DEFAULTS = {
  completeness: true,
  historyFallback: true,
  langidSidecar: false,
  scopeGate: false,
} as const satisfies Partial<Record<keyof QueryAdditionSwitches, boolean>>;

export type QueryAdditionHashSwitches = Partial<Record<keyof typeof QUERY_ADDITION_HASH_DEFAULTS, boolean>>;

/** The non-default query-addition switches, or undefined when every one is at its default. */
export function queryAdditionsHashBlock(switches: QueryAdditionHashSwitches | undefined): Record<string, boolean> | undefined {
  if (!switches) return undefined;
  const block: Record<string, boolean> = {};
  for (const [name, defaultValue] of Object.entries(QUERY_ADDITION_HASH_DEFAULTS) as Array<[keyof typeof QUERY_ADDITION_HASH_DEFAULTS, boolean]>) {
    const value = switches[name];
    if (typeof value === 'boolean' && value !== defaultValue) block[name] = value;
  }
  return Object.keys(block).length > 0 ? block : undefined;
}

/** The query-layer part of the retrieval-config hash (research A-7): framework, model, params, prompt versions and transform switches. */
export function queryLayerHashComponent(
  layer: QueryLayerConfig,
  params: QueryParams,
  gated: { subqFilters?: boolean; additions?: QueryAdditionHashSwitches } = {},
): RetrievalConfigHashQueryLayer {
  const additions = queryAdditionsHashBlock(gated.additions);
  return {
    framework: layer.framework,
    model: layer.model,
    queryParamsHash: createHash('sha256').update(canonicalJson(params), 'utf8').digest('hex'),
    prompts: { ...queryPromptVersions(), ...(gated.subqFilters === true ? { [sharedSubqFilters.id]: sharedSubqFilters.version } : {}) },
    transforms: { ...layer.transforms },
    ...(additions ? { additions } : {}),
  };
}
