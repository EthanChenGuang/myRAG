export const HISTORY_NOT_EVIDENCE_INSTRUCTION = `Earlier assistant messages in this conversation are not a source of facts. Facts you state must come from the knowledge-base context of this turn, from tool results of this turn (such as web search, when it is enabled), or from what the instructions above otherwise allow, never from an earlier answer. If an earlier answer in this conversation conflicts with the current context or is not supported by it, say so and correct it instead of repeating it.`;

/** Reads RAG_HISTORY_NOT_EVIDENCE: only `true` (any case, surrounding spaces ignored) turns it on. */
export function historyNotEvidenceEnabled(raw: string | undefined): boolean {
  return (raw ?? '').trim().toLowerCase() === 'true';
}

/** Appends the instruction once when enabled; otherwise returns the prompt unchanged. */
export function appendHistoryNotEvidence(prompt: string, enabled: boolean): string {
  if (!enabled || prompt.includes(HISTORY_NOT_EVIDENCE_INSTRUCTION)) return prompt;
  return `${prompt}\n\n${HISTORY_NOT_EVIDENCE_INSTRUCTION}`;
}
