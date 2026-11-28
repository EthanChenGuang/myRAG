import type { ReplaceCandidate } from '@/components/ui/replaces-picker';
import type { ScopeTagVocabularyEntry } from '@/components/ui/scope-tag-picker';

export interface UploadTagsConfig {
  enabled: boolean;
  vocabulary: ScopeTagVocabularyEntry[];
}

export interface UploadReplacesConfig {
  enabled: boolean;
  confirmedAtOnce: boolean;
}

export const UPLOAD_TAGS_OFF: UploadTagsConfig = { enabled: false, vocabulary: [] };
export const UPLOAD_REPLACES_OFF: UploadReplacesConfig = { enabled: false, confirmedAtOnce: false };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** The tags block of the picker-defaults answer (D-40); anything malformed keeps the picker hidden. */
export function readUploadTags(value: unknown): UploadTagsConfig {
  const block = record(value);
  if (!block || block.enabled !== true || !Array.isArray(block.vocabulary)) return UPLOAD_TAGS_OFF;
  const vocabulary: ScopeTagVocabularyEntry[] = [];
  for (const item of block.vocabulary) {
    const entry = record(item);
    if (!entry) continue;
    const { dimension, value: tagValue, label } = entry;
    if (typeof dimension !== 'string' || typeof tagValue !== 'string' || typeof label !== 'string') continue;
    if (!dimension || !tagValue) continue;
    vocabulary.push({ dimension, value: tagValue, label });
  }
  return vocabulary.length > 0 ? { enabled: true, vocabulary } : UPLOAD_TAGS_OFF;
}

/** The replaces block of the picker-defaults answer (D-41, decision 9); only an explicit true shows the control. */
export function readUploadReplaces(value: unknown): UploadReplacesConfig {
  const block = record(value);
  if (!block || block.enabled !== true) return UPLOAD_REPLACES_OFF;
  return { enabled: true, confirmedAtOnce: block.confirmedAtOnce === true };
}

interface DocumentRowLike {
  id: string;
  name: string;
  status?: string;
  uploadedAt?: Date;
  ingest?: { status: string };
}

/** The workspace's documents already loaded by the dashboard that are ready; rows still running or held are left out. */
export function replaceCandidatesFrom(rows: readonly DocumentRowLike[]): ReplaceCandidate[] {
  const seen = new Set<string>();
  const candidates: ReplaceCandidate[] = [];
  for (const row of rows) {
    if (row.status !== 'ready') continue;
    if (row.ingest && row.ingest.status !== 'ready') continue;
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    candidates.push({ id: row.id, name: row.name, uploadedAt: row.uploadedAt ?? null });
  }
  return candidates;
}

export function withoutKey<T>(map: Record<string, T>, key: string): Record<string, T> {
  if (!Object.prototype.hasOwnProperty.call(map, key)) return map;
  const next = { ...map };
  delete next[key];
  return next;
}
