/**
 * Sentence records stored before not_checked records carried a reason have `reason: null`, which the generated schema now
 * rejects. Reading such a record fills `claim_check_off` (no check ran on it) so stored marks and checks keep loading.
 */
export function withLegacySentenceReasons(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    const record = entry as Record<string, unknown>;
    const notChecked = record.support === undefined || record.support === 'not_checked';
    return notChecked && (record.reason === null || record.reason === undefined) ? { ...record, reason: 'claim_check_off' } : record;
  });
}

/** The same for a stored checks object: only its `sentences` entry is touched. */
export function withLegacyChecksSentenceReasons(checks: unknown): unknown {
  if (!checks || typeof checks !== 'object' || Array.isArray(checks)) return checks;
  const record = checks as Record<string, unknown>;
  if (!Array.isArray(record.sentences)) return checks;
  return { ...record, sentences: withLegacySentenceReasons(record.sentences) };
}
