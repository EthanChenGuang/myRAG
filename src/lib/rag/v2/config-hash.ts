import { createHash } from 'node:crypto';
import rawOutputCaps from '../../../../eval/config/output-caps.json';
import glossaryPrompt from '../query/prompts/shared.glossary.v1.json';
import type { AnswerConfig } from '../generation/answer-config';
import { calcLimitsVersion } from '../calc/limits';
import { promptBudgetConfigVersion, tokenizerCalibrationVersion } from '../context/prompt-budget-config';
import { registryPackVersion } from '../lang/texts';
import { outputGuardRulesVersion } from '../security/credential-rules';
import { TLD_SNAPSHOT_VERSION } from '../security/link-targets';
import type { BackendIndexParams } from '../backend/index-params';
import type { AttributeFilterConfig, RetrievalParams, TerminologyParams } from '@/lib/rag-eval/contracts.generated';
import type { AttributeFilterMode, IterativeScanMode, RagConfig, RerankerKind, RerankTier } from '../config';
import type { InjectionCheckMode, SecurityConfig, ToolResultGuardMode } from '../security/config';
import { detectorsConfigVersion } from '../security/detectors';
import { injectionRulesVersion } from '../security/injection-rules';
import { lakeraAllowed } from '../security/lakera';

export interface RetrievalConfigHashSwitches {
  lexicalSearch: boolean;
  refusalThreshold: boolean;
  edgeOrder: boolean;
  compression: boolean;
  tokenBudget: number;
  parentChild: boolean;
  iterativeScan: IterativeScanMode;
  exactScanCutoff: number;
  lexicalTranslation: boolean;
  exactIdLookup: boolean;
  rerankTierChat: RerankTier;
  rerankTierVoice: RerankTier;
  /** D-03: present only for a single-language deployment, so a multilingual hash is unchanged. */
  monolingual?: true;
  /** D-19: present only while RAG_SOURCE_RECHECK is on, so the hash with the switch off is unchanged. */
  sourceRecheck?: true;
}

/** The prompt-injection defense configuration a result was built under (D-18). */
export interface RetrievalConfigHashSecurity {
  contextTagging: boolean;
  injectionCheck: InjectionCheckMode;
  promptGuard: boolean;
  lakera: boolean;
  lakeraMultiTenantAck: boolean;
  /** Whether a Lakera request may actually be sent (lakeraAllowed); a boolean, never the key. */
  lakeraEffective: boolean;
  toolResultGuard: ToolResultGuardMode;
  rulesVersion: string;
  detectorsVersion: string;
}

/**
 * Null while every 5.1 switch is at its default, so the hash equals its pre-5.1 value; otherwise the switches,
 * Lakera's effective state for this deployment mode, and the rules and detector config versions.
 */
export function securityHashComponent(
  security: SecurityConfig,
  options: { multiTenant: boolean; rulesVersion?: string; detectorsVersion?: string },
): RetrievalConfigHashSecurity | null {
  if (!security.anyNonDefault) return null;
  const lakeraEffective = lakeraAllowed({
    injectionCheck: security.injectionCheck,
    lakera: security.lakera,
    multiTenant: options.multiTenant,
    ack: security.lakeraMultiTenantAck,
    apiKeyPresent: security.lakeraApiKey !== null,
  }).allowed;
  return {
    contextTagging: security.contextTagging,
    injectionCheck: security.injectionCheck,
    promptGuard: security.promptGuard,
    lakera: security.lakera,
    lakeraMultiTenantAck: security.lakeraMultiTenantAck,
    lakeraEffective,
    toolResultGuard: security.toolResultGuard,
    rulesVersion: options.rulesVersion ?? injectionRulesVersion(),
    detectorsVersion: options.detectorsVersion ?? detectorsConfigVersion(),
  };
}

/** Phase 5.2 D-58: the answer rules an answer was produced under; present only while a prompt- or output-affecting switch is on. */
export interface RetrievalConfigHashAnswerRules {
  registryTexts: boolean;
  partialAnswerRule: boolean;
  contextRelevanceRule: boolean;
  citationPerSentence: boolean;
  versionLabels: boolean;
  maxOutputTokens: 'off' | 'auto' | number;
  outputGuard: AnswerConfig['outputGuard'];
  /** The registry pack versions: every composed part and notice is a registry text. */
  packVersion: string;
  /** While the guard is on: the output-guard rule set and the public TLD snapshot it decides bare domains with. */
  outputGuardRulesVersion?: string;
  tldVersion?: string;
  /** While RAG_MAX_OUTPUT_TOKENS is auto: the committed per-mode caps file. */
  outputCapsVersion?: string;
}

export type AnswerRulesHashConfig = Pick<
  AnswerConfig,
  'registryTexts' | 'partialAnswerRule' | 'contextRelevanceRule' | 'citationPerSentence' | 'versionLabels' | 'maxOutputTokens' | 'outputGuard'
>;

let committedCapsVersion: string | null = null;

/** SHA-256 (first 12 hex characters) of the canonical committed output-caps file. */
function outputCapsVersion(): string {
  committedCapsVersion ??= createHash('sha256').update(canonicalJson(rawOutputCaps), 'utf8').digest('hex').slice(0, 12);
  return committedCapsVersion;
}

/**
 * D-58, RESEARCH Pitfall 24: null while every prompt- or output-affecting Phase 5.2 switch is at its default, so the hash keeps
 * its pre-5.2 value; otherwise the switches and the versions of the data they read. The claim check, the judge, security events
 * and uploader holds change no answer text and stay out.
 */
export function answerRulesHashComponent(
  config: AnswerRulesHashConfig,
  options: { packVersion?: string; guardRulesVersion?: string; tldVersion?: string; capsVersion?: string } = {},
): RetrievalConfigHashAnswerRules | null {
  const cap = config.maxOutputTokens;
  const on =
    config.registryTexts ||
    config.partialAnswerRule ||
    config.contextRelevanceRule ||
    config.citationPerSentence ||
    config.versionLabels ||
    cap.kind !== 'off' ||
    config.outputGuard !== 'off';
  if (!on) return null;
  const guardOn = config.outputGuard !== 'off';
  return {
    registryTexts: config.registryTexts,
    partialAnswerRule: config.partialAnswerRule,
    contextRelevanceRule: config.contextRelevanceRule,
    citationPerSentence: config.citationPerSentence,
    versionLabels: config.versionLabels,
    maxOutputTokens: cap.kind === 'fixed' ? cap.value : cap.kind,
    outputGuard: config.outputGuard,
    packVersion: options.packVersion ?? registryPackVersion(),
    ...(guardOn
      ? { outputGuardRulesVersion: options.guardRulesVersion ?? outputGuardRulesVersion(), tldVersion: options.tldVersion ?? TLD_SNAPSHOT_VERSION }
      : {}),
    ...(cap.kind === 'auto' ? { outputCapsVersion: options.capsVersion ?? outputCapsVersion() } : {}),
  };
}

/** The query layer's setup (D-04, research A-7); present only while the layer is on, so a Phase 4 hash is unchanged. */
/** Phase 5.2.1 D-88: the calculation and prompt-budget switches and the versions of the data they read. */
export interface RetrievalConfigHashCalcBudget {
  calcTool: boolean;
  calcCheck: boolean;
  promptBudget: boolean;
  contextOverflow: AnswerConfig['contextOverflow'];
  calcLimitsVersion: string;
  promptBudgetConfigVersion: string;
  tokenizerCalibrationVersion: string;
}

export type CalcBudgetHashConfig = Pick<AnswerConfig, 'calcTool' | 'calcCheck' | 'promptBudget' | 'contextOverflow'>;

/**
 * D-88, D-58: null while the four Phase 5.2.1 switches are at their defaults (calc tool and check off, budget off, overflow
 * truncate), so the hash keeps its pre-5.2.1 value; otherwise the switches and the versions of calc-limits.json,
 * prompt-budget.json and tokenizer-calibration.json.
 */
export function calcBudgetHashComponent(
  config: CalcBudgetHashConfig,
  options: { calcLimitsVersion?: string; promptBudgetConfigVersion?: string; tokenizerCalibrationVersion?: string } = {},
): RetrievalConfigHashCalcBudget | null {
  const on = config.calcTool || config.calcCheck || config.promptBudget || config.contextOverflow !== 'truncate';
  if (!on) return null;
  return {
    calcTool: config.calcTool,
    calcCheck: config.calcCheck,
    promptBudget: config.promptBudget,
    contextOverflow: config.contextOverflow,
    calcLimitsVersion: options.calcLimitsVersion ?? calcLimitsVersion(),
    promptBudgetConfigVersion: options.promptBudgetConfigVersion ?? promptBudgetConfigVersion(),
    tokenizerCalibrationVersion: options.tokenizerCalibrationVersion ?? tokenizerCalibrationVersion(),
  };
}

export interface RetrievalConfigHashQueryLayer {
  framework: string;
  model: string;
  /** SHA-256 over the canonical effective query params. */
  queryParamsHash: string;
  /** Prompt file id to version. */
  prompts: Record<string, number>;
  transforms: Record<string, boolean>;
}

/** D-34: only the entries of the Phase 4.2 switches that are on; absent while every switch is off. */
export interface RetrievalConfigHashTuning {
  table_lookup?: { min_cells: number; limit: number; weight: number };
  diversity?: { mode: 'collapse' } | { mode: 'mmr'; mmr_lambda: number; mmr_window_factor: number };
  version_scope?: true;
  identifier_filter?: true;
  dup_clusters?: true;
  identifier_index?: true;
  /** LANG-07: the tenant's effective TERM version while RAG_LEXICAL_DICTIONARY is on (LEXICAL_DICTIONARY_UNAVAILABLE when not loaded). */
  lexical_dictionary_version?: string;
  /** RET-15: the tenant's identifier patterns fingerprint while RAG_IDENTIFIER_INDEX is on (IDENTIFIER_PATTERNS_UNAVAILABLE when not loaded). */
  identifier_patterns?: string;
}

export const LEXICAL_DICTIONARY_UNAVAILABLE = 'lexical_dictionary:unavailable';
export const IDENTIFIER_PATTERNS_UNAVAILABLE = 'identifier_patterns:unavailable';

/** D-21: the dictionary a request was retrieved with; present only while the terminology stage is enabled for the request. */
export interface RetrievalConfigHashTerminology {
  /** The effective version (s<n> or s<n>.w<m>) when the stage ended ok; TERMINOLOGY_UNAVAILABLE when it was skipped. */
  version: string;
  /** SHA-256 over the canonical TerminologyParams, config_hash and provenance left out. */
  params_sha256: string;
  dense: boolean;
}

/** The terminology stage as the hash sees it: disabled for the request, or enabled with the version it ended with (null: skipped). */
export type TerminologyHashStage = { enabled: false } | { enabled: true; version: string | null };

export const TERMINOLOGY_UNAVAILABLE = 'terminology:unavailable';

/** D-14 (XLG-05): the tenant glossary a request translated with; present only while RAG_TRANSLATION_GLOSSARY is effective. */
export interface RetrievalConfigHashGlossary {
  /** The TERM version the glossary was read at; GLOSSARY_UNAVAILABLE when it was not loaded for the request. */
  version: string;
  /** The shared.glossary addendum version (its prompt file is not in the query-layer prompt list, so the off-hash keeps its value). */
  prompt_version: number;
}

/** The glossary as the hash sees it: switch off for the request, or on with the version it was read at (null: not loaded). */
export type GlossaryHashStage = { enabled: false } | { enabled: true; version: string | null };

export const GLOSSARY_UNAVAILABLE = 'glossary:unavailable';

/** D-30: the attribute filter a request was retrieved with; present only while the attribute_resolve stage is enabled for the request. */
export interface RetrievalConfigHashAttributeFilter {
  mode: Exclude<AttributeFilterMode, 'off'>;
  rules_version: number;
  soft_weight: number;
  id_cap: number;
  /** The resolver's digest; ATTRIBUTE_STATE_NONE when nothing resolved; ATTRIBUTE_STATE_SKIPPED when the stage was skipped or not reached. */
  state: string;
}

/** The attribute_resolve stage as the hash sees it: disabled for the request, or enabled with the state it ended with. */
export type AttributeFilterHashStage = { enabled: false } | { enabled: true; state: string };

export const ATTRIBUTE_STATE_NONE = 'attribute:none';
export const ATTRIBUTE_STATE_SKIPPED = 'attribute:skipped';

export interface RetrievalConfigHashInput {
  backendId: string;
  /** D-24: an external backend's index parameters (backendIndexParams); absent for pgvector, so its hash keeps its value. */
  backendIndex?: BackendIndexParams | null;
  embeddingProfileId: string;
  lexicalVersion: number;
  rerankTextVersion: number;
  params: RetrievalParams;
  reranker: { id: RerankerKind; model: string };
  thresholdsConfigHash: string | null;
  activeChunkingProfiles: Record<string, string> | null;
  switches: RetrievalConfigHashSwitches;
  /** Present only when a 5.1 switch is not at its default (securityHashComponent). */
  security?: RetrievalConfigHashSecurity | null;
  /** Phase 5.2 D-58: present only while a prompt- or output-affecting answer switch is on (answerRulesHashComponent). */
  answerRules?: RetrievalConfigHashAnswerRules | null;
  /** Phase 5.2.1 D-88: present only while a calculation or prompt-budget switch is not at its default (calcBudgetHashComponent). */
  calcBudget?: RetrievalConfigHashCalcBudget | null;
  /** Doc type to binding profile id of the legs planned for the request; omitted (or empty) when none is planned. */
  embeddingBindings?: Record<string, string> | null;
  /** Eval only: the doc type of the control leg. */
  domainControlLeg?: string | null;
  /** D-44: the effective date passed to retrieval; absent or null while RAG_EFFECTIVE_DATES is off. */
  effectiveOn?: string | null;
  /** Present only while the query layer is on. */
  queryLayer?: RetrievalConfigHashQueryLayer | null;
  /** XLG-04: present only when translation legs run for the request (RAG_DOC_TRANSLATION on and the tenant has translations). */
  docTranslation?: { switch: 'on'; languages: string[]; weight: number } | null;
  /** D-34: present only while a Phase 4.2 query or index switch is on (tuningHashComponent). */
  tuning?: RetrievalConfigHashTuning | null;
  /** D-21: present only while the terminology stage is enabled for the request (terminologyHashBlock). */
  terminology?: RetrievalConfigHashTerminology | null;
  /** D-30: present only while the attribute_resolve stage is enabled for the request (attributeFilterHashBlock). */
  attributeFilter?: RetrievalConfigHashAttributeFilter | null;
  /** D-08: present only while BM25 is the effective lexical scoring (lexicalScoringHashBlock). */
  lexicalScoring?: RetrievalConfigHashLexicalScoring | null;
  /** D-14: present only while RAG_TRANSLATION_GLOSSARY is effective for the request (glossaryHashBlock). */
  glossary?: RetrievalConfigHashGlossary | null;
}

export interface RetrievalConfigHashLexicalScoring {
  mode: 'bm25';
  k1: number;
  b: number;
}

/** D-08: null while the effective mode is ts_rank_cd, whatever k1 and b say, so the off-hash keeps its value. */
export function lexicalScoringHashBlock(config: Pick<RagConfig, 'v2'>): RetrievalConfigHashLexicalScoring | null {
  const scoring = config.v2.lexicalScoring;
  if (scoring.mode !== 'bm25') return null;
  return { mode: 'bm25', k1: scoring.k1, b: scoring.b };
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortKeys(record[key]);
    }
    return sorted;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function paramsForHash(params: RetrievalParams): Record<string, unknown> {
  const { config_hash: _hash, provenance: _prov, ...rest } = params;
  return rest as Record<string, unknown>;
}

/**
 * D-21: the only builder of the terminology block. Undefined when the stage is disabled for the request (switch off, or
 * terminology among the config's or the eval request's disabled stages), so the hash equals the pre-terminology value.
 */
export function terminologyHashBlock(
  stage: TerminologyHashStage,
  params: TerminologyParams,
  dense: boolean,
): RetrievalConfigHashTerminology | undefined {
  if (!stage.enabled) return undefined;
  const { config_hash: _hash, provenance: _prov, ...rest } = params;
  return {
    version: stage.version ?? TERMINOLOGY_UNAVAILABLE,
    params_sha256: createHash('sha256').update(canonicalJson(rest), 'utf8').digest('hex'),
    dense,
  };
}

/**
 * D-30: the only builder of the attribute_filter block. Undefined when the stage is disabled for the request (switch off, or
 * attribute_resolve among the config's or the eval request's disabled stages), so the hash equals the value before the filter.
 */
export function attributeFilterHashBlock(
  stage: AttributeFilterHashStage,
  mode: AttributeFilterMode,
  config: AttributeFilterConfig,
): RetrievalConfigHashAttributeFilter | undefined {
  if (!stage.enabled || mode === 'off') return undefined;
  return { mode, rules_version: config.rules_version, soft_weight: config.soft_weight, id_cap: config.id_cap, state: stage.state };
}

function chunkingForHash(profiles: Record<string, string> | null): unknown {
  if (profiles === null) return 'chunking:unavailable';
  return profiles;
}

function buildPayload(input: RetrievalConfigHashInput): Record<string, unknown> {
  return {
    active_chunking_profiles: chunkingForHash(input.activeChunkingProfiles),
    backend_id: input.backendId,
    ...(input.backendIndex ? { backend_index: input.backendIndex } : {}),
    embedding_profile_id: input.embeddingProfileId,
    lexical_version: input.lexicalVersion,
    params: paramsForHash(input.params),
    rerank_text_version: input.rerankTextVersion,
    reranker: input.reranker,
    switches: input.switches,
    thresholds_config_hash: input.switches.refusalThreshold ? input.thresholdsConfigHash : null,
    ...(input.security ? { security: input.security } : {}),
    ...(input.answerRules ? { answer_rules: input.answerRules } : {}),
    ...(input.calcBudget ? { calc_budget: input.calcBudget } : {}),
    ...(input.embeddingBindings && Object.keys(input.embeddingBindings).length > 0 ? { embedding_bindings: input.embeddingBindings } : {}),
    ...(input.domainControlLeg ? { domain_control_leg: input.domainControlLeg } : {}),
    ...(input.effectiveOn ? { effective_on: input.effectiveOn } : {}),
    ...(input.queryLayer ? { query_layer: input.queryLayer } : {}),
    ...(input.docTranslation ? { doc_translation: input.docTranslation } : {}),
    ...(input.tuning && Object.keys(input.tuning).length > 0 ? { tuning: input.tuning } : {}),
    ...(input.terminology ? { terminology: input.terminology } : {}),
    ...(input.attributeFilter ? { attribute_filter: input.attributeFilter } : {}),
    ...(input.lexicalScoring ? { lexical_scoring: input.lexicalScoring } : {}),
    ...(input.glossary ? { glossary: input.glossary } : {}),
  };
}

export function computeRetrievalConfigHash(input: RetrievalConfigHashInput): string {
  const payload = buildPayload(input);
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}
/** D-14, research F-5: the only builder of the glossary block. Undefined while the switch is off, so the hash keeps its value. */
export function glossaryHashBlock(stage: GlossaryHashStage): RetrievalConfigHashGlossary | undefined {
  if (!stage.enabled) return undefined;
  return { version: stage.version ?? GLOSSARY_UNAVAILABLE, prompt_version: glossaryPrompt.version };
}
