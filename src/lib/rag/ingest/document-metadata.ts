import type { IngestOptions } from './types';

const MAX_KEYS = 20;
const MAX_STRING_LENGTH = 500;
const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** Keys the pipeline writes itself; a caller can neither set nor overwrite them. */
const PIPELINE_KEYS: ReadonlySet<string> = new Set([
  'quarantine',
  'duplicate_of',
  'content_hash_version',
  'doc_type_detection',
  'external_url',
]);

/**
 * The plain facts a write path wants on its document row (for example the chat and message an AI answer
 * came from): short strings, numbers and booleans under safe key names. Anything else is dropped, so a
 * caller cannot nest objects, smuggle content or replace metadata the pipeline owns. Null when nothing is left.
 */
export function callerDocumentMetadata(options: IngestOptions | undefined): Record<string, string | number | boolean> | null {
  const raw = options?.documentMetadata;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const kept: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (Object.keys(kept).length >= MAX_KEYS) break;
    if (!KEY_PATTERN.test(key) || PIPELINE_KEYS.has(key)) continue;
    if (typeof value === 'string') kept[key] = value.slice(0, MAX_STRING_LENGTH);
    else if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) kept[key] = value;
  }
  return Object.keys(kept).length > 0 ? kept : null;
}
