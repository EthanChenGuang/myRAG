import type { GroundednessResult } from '@/lib/rag-eval/contracts.generated';
import type { RetrievalStatus } from '../types';
import type { AliasedBlock } from './citations/blocks';

export interface GroundednessEligibilityInput {
  enabled: boolean;
  webChatWithCitations: boolean;
  ragMode: string;
  retrievalStatus: RetrievalStatus;
  blockCount: number;
  isRefusal: boolean;
  ghostChat: boolean;
  toolOutputUsed: boolean;
}
export type GroundednessEligibility = { eligible: true } | { eligible: false; reason: 'not_eligible' | 'tool_output' };
export function groundednessEligibility(_input: GroundednessEligibilityInput): GroundednessEligibility {
  return { eligible: true };
}
export interface PremiseInput {
  blocks: readonly AliasedBlock[];
  citedAliases: Iterable<string>;
  webSearchTexts: readonly string[];
  maxTokens: number;
  countTokens?: (text: string) => number;
}
export type Premise = { status: 'ok'; premiseTexts: string[]; truncated: boolean } | { status: 'too_long' } | { status: 'empty_premise' };
export function buildPremise(_input: PremiseInput): Premise {
  return { status: 'empty_premise' };
}
export type Hypothesis = { status: 'ok'; hypothesis: string } | { status: 'not_checked'; reason: 'empty_answer' };
export function buildHypothesis(answer: string): Hypothesis {
  return { status: 'ok', hypothesis: answer };
}
export type GroundednessLanguage = 'en' | 'it' | 'zh-Hans' | 'zh-Hant' | 'zh' | 'unknown';
export function answerGroundednessLanguage(_answer: string): GroundednessLanguage {
  return 'unknown';
}
export function allowVectaraFor(_config: { vectaraOptIn: boolean; vectaraMultiTenantAck: boolean }, _multiTenant: boolean): boolean {
  return true;
}
export type ThresholdSource = 'default' | 'calibrated';
export type GroundednessThresholdCells = ReadonlyMap<string, { threshold: number; source: ThresholdSource }>;
export function loadGroundednessThresholdsFromData(_data: unknown): { cells: GroundednessThresholdCells } {
  return { cells: new Map() };
}
export function loadGroundednessThresholds(): { cells: GroundednessThresholdCells } {
  return { cells: new Map() };
}
export type GroundednessLabel = 'verified' | 'possibly_unreliable' | 'not_checked';
export interface LabelledGroundedness {
  status: GroundednessResult['status'];
  label: GroundednessLabel;
  scorer: GroundednessResult['scorer'];
  score: number | null;
  threshold: number | null;
  thresholdSource: ThresholdSource | null;
  reason: string | null;
  truncated: boolean;
  latencyMs: number;
}
export function labelGroundedness(result: GroundednessResult, _language: string, _cells?: GroundednessThresholdCells): LabelledGroundedness {
  return { status: result.status, label: 'not_checked', scorer: result.scorer, score: null, threshold: null, thresholdSource: null, reason: null, truncated: false, latencyMs: 0 };
}
