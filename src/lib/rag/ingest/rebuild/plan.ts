import { createHash } from 'node:crypto';
import { canonicalJson } from '@/lib/rag-eval/trace';
import type { RebuildMechanism } from '../fingerprint';
import { countImpact, MECHANISM_COMMANDS, type FingerprintGroup } from '../fingerprint/impact';

/** The mechanisms `rag:rebuild start` accepts; the security rescan has its own action (plan 03.2-40). */
export const REBUILDABLE_MECHANISMS = ['reparse', 'rechunk', 'relex', 'reembed', 'recaption', 'retranslate'] as const;
export type RebuildableMechanism = (typeof REBUILDABLE_MECHANISMS)[number];

export function isRebuildableMechanism(value: unknown): value is RebuildableMechanism {
  return typeof value === 'string' && (REBUILDABLE_MECHANISMS as readonly string[]).includes(value);
}

/** A current ready document with its stored fingerprint, as rag_rebuild_candidates returns it. */
export interface RebuildCandidate {
  documentId: string;
  tenantKey: string;
  docType: string;
  fingerprint: string | null;
  parts: unknown;
}

export interface RebuildTarget {
  documentId: string;
  tenantKey: string;
  docType: string;
}

/** The documents the saved settings leave on previous settings for one mechanism (D-11), and those that cannot be compared. */
export interface RebuildSelection {
  documents: RebuildTarget[];
  withoutFingerprint: number;
}

/**
 * Per document, the same comparison as the coverage count (countImpact over the saved values): a document is selected when the expected
 * parts for this mechanism differ from its stored parts. Documents without a fingerprint are never selected; they need the backfill first.
 */
export function selectAffected(candidates: readonly RebuildCandidate[], mechanism: RebuildMechanism, proposal: Record<string, string>): RebuildSelection {
  const documents: RebuildTarget[] = [];
  let withoutFingerprint = 0;
  for (const candidate of candidates) {
    const group: FingerprintGroup = { docType: candidate.docType, fingerprint: candidate.fingerprint, parts: candidate.parts, documents: 1 };
    const counts = countImpact([group], proposal);
    if (counts.withoutFingerprint > 0) {
      withoutFingerprint += 1;
      continue;
    }
    const byType = counts.affected.get(mechanism);
    const affected = byType ? [...byType.values()].reduce((sum, value) => sum + value, 0) : 0;
    if (affected > 0) documents.push({ documentId: candidate.documentId, tenantKey: candidate.tenantKey, docType: candidate.docType });
  }
  return { documents, withoutFingerprint };
}

/** One hash per mechanism and saved values: a second start under the same settings finds the run of the first. */
export function rebuildSettingsHash(mechanism: RebuildMechanism, proposal: Record<string, string>): string {
  return createHash('sha256').update(canonicalJson({ mechanism, values: proposal })).digest('hex');
}

export interface PlanOptions {
  ingestAsync: boolean;
  settingsHash: string;
}

export type RebuildPlan =
  | { kind: 'nothing'; mechanism: RebuildableMechanism; affected: 0 }
  | { kind: 'held_batch'; mechanism: 'reparse'; activation: 'rebuild_batch'; affected: number; documents: RebuildTarget[] }
  | { kind: 'needs_async'; mechanism: 'reparse'; affected: number; command: string }
  | { kind: 'chunking_profile'; mechanism: 'rechunk'; activation: 'chunking_profiles'; affected: number; profiles: ProfileBuild[]; documents: RebuildTarget[] }
  | { kind: 'command'; mechanism: 'relex' | 'reembed' | 'recaption' | 'retranslate'; activation: 'embedding_profiles' | 'none'; affected: number; commands: string[] };

/** A chunking profile a rechunk rebuild creates: the legacy child size of the doc type and no parents (research F-9). */
export interface ProfileBuild {
  profileId: string;
  docType: string;
  childTokens: number;
  parentMode: 'none';
  parentTokens: null;
  preset: 'custom';
}

/**
 * D-11, pure: how a rebuild of the selected documents runs. reparse re-ingests them from the stored originals as a held batch when the
 * queue is on (RAG_INGEST_ASYNC=on), otherwise it lists the count and the command.
 */
export function planRebuild(mechanism: RebuildableMechanism, selection: RebuildSelection, options: PlanOptions): RebuildPlan {
  const affected = selection.documents.length;
  if (affected === 0) return { kind: 'nothing', mechanism, affected: 0 };
  void options.settingsHash;
  if (mechanism === 'reparse') {
    if (!options.ingestAsync) return { kind: 'needs_async', mechanism, affected, command: MECHANISM_COMMANDS.reparse };
    return { kind: 'held_batch', mechanism, activation: 'rebuild_batch', affected, documents: selection.documents };
  }
  return { kind: 'nothing', mechanism, affected: 0 };
}
