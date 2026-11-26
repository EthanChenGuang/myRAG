import type { z } from 'zod/v3';
import type { JobSettingsSnapshotSchema, ParseJobRequestSchema } from '@/lib/rag-eval/contracts.generated';

/** Wire shapes: fields with a default may be left out. */
export type JobSettingsSnapshotWire = z.input<typeof JobSettingsSnapshotSchema>;
export type ParseJobRequestWire = z.input<typeof ParseJobRequestSchema>;

// Phase 3.2 fields (plan 03.2-05). They are sent only when they differ from these defaults, so a sidecar
// deployed before them, whose contracts forbid unknown keys, still accepts the body (research Pitfall 17).
export const PARSE_JOB_REQUEST_PHASE32_DEFAULTS = {
  language_aware: false,
  languages: [],
  primary_language: null,
  carry_table_header: false,
} as const;

export const JOB_SETTINGS_PHASE32_DEFAULTS = {
  language_aware: false,
  languages: [],
  primary_language: null,
  repeat_table_header_effective: null,
  carry_table_header: false,
  row_serialization: false,
  hidden_text_check: 'off',
  approval: null,
  hold_publish: false,
  ocr_primary_language: null,
  target_language: null,
} as const;

export function omitDefaultFields<T extends Record<string, unknown>>(value: T, defaults: Readonly<Record<string, unknown>>): T {
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (key in defaults && JSON.stringify(field) === JSON.stringify(defaults[key])) continue;
    out[key] = field;
  }
  return out as T;
}
