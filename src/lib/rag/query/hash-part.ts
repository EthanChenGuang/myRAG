import { createHash } from 'node:crypto';
import type { QueryParams } from '@/lib/rag-eval/contracts.generated';
import type { QueryLayerConfig } from '../config';
import { canonicalJson, type RetrievalConfigHashQueryLayer } from '../v2/config-hash';
import llamaindexCondense from './prompts/llamaindex.condense.v1.json';
import llamaindexFusion from './prompts/llamaindex.fusion.v1.json';
import llamaindexHydeEn from './prompts/llamaindex.hyde.en.v1.json';
import llamaindexHydeIt from './prompts/llamaindex.hyde.it.v1.json';
import llamaindexHydeZh from './prompts/llamaindex.hyde.zh.v1.json';
import llamaindexSubq from './prompts/llamaindex.subq.v1.json';
import sharedSuffix from './prompts/shared.suffix.v1.json';
import sharedTranslate from './prompts/shared.translate.v1.json';

/** Every query-layer prompt file; a test fails when a file in prompts/ is missing here. */
const PROMPT_FILES: ReadonlyArray<{ id: string; version: number }> = [
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

/** The query-layer part of the retrieval-config hash (research A-7): framework, model, params, prompt versions and transform switches. */
export function queryLayerHashComponent(layer: QueryLayerConfig, params: QueryParams): RetrievalConfigHashQueryLayer {
  return {
    framework: layer.framework,
    model: layer.model,
    queryParamsHash: createHash('sha256').update(canonicalJson(params), 'utf8').digest('hex'),
    prompts: queryPromptVersions(),
    transforms: { ...layer.transforms },
  };
}
