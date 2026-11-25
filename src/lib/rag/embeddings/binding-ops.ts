import {
  BindingActivationEvidenceSchema,
  BindingComparisonSchema,
  type BindingActivationEvidence,
  type BindingComparison,
} from '@/lib/rag-eval/contracts.generated';
import { ProfileUnavailableError, listEmbeddingProfiles } from './active-profile';
import { bindingKey, listBindingRows, refreshBindingsAfterOperation, type BindingRow } from './bindings';
import { callGate, type ProfileRefusal } from './profile-ops';

/** Every refusal of the 0441 gate functions reads `binding_refused: <code>`; it comes back as data, never as success. */
export type BindingRefusal = ProfileRefusal;

export interface BindingListEntry extends BindingRow {
  /** Active and its evidence names another global profile than the registry pointer (D-12). */
  stale: boolean;
}

export type CreateBindingResult = { ok: true; bindingId: string; status: string; created: boolean } | BindingRefusal;
export type SetBindingStatusResult = { ok: true; bindingId: string; status: string } | BindingRefusal;
export type RecordBindingEvidenceResult = { ok: true; bindingId: string; evidence: BindingActivationEvidence } | BindingRefusal;
export type ActivateBindingResult = { ok: true; binding: BindingRow; previous: string | null } | BindingRefusal;
export type RollbackBindingResult = { ok: true; restored: BindingRow; rolledBack: string } | BindingRefusal;
export type DeactivateBindingResult = { ok: true; deactivated: string } | BindingRefusal;

/** The evidence file is neither a BindingComparison nor a BindingActivationEvidence, or names another binding. */
export class BindingEvidenceInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BindingEvidenceInvalid';
  }
}

const UNKNOWN_BINDING: BindingRefusal = { ok: false, reason: 'binding_refused: unknown_binding', detail: 'binding_refused: unknown_binding' };

function text(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' ? value : null;
}

async function globalPointer(): Promise<string | null> {
  return (await listEmbeddingProfiles()).find((profile) => profile.status === 'active')?.id ?? null;
}

/** Every binding, read fresh, with the stale flag against the registry pointer. */
export async function listBindings(): Promise<BindingListEntry[]> {
  const [rows, pointer] = await Promise.all([listBindingRows(), globalPointer()]);
  return rows.map((row) => ({ ...row, stale: row.status === 'active' && row.baselineGlobalProfile !== pointer }));
}

/** Creates an available binding, or returns the existing row for the same doc type, tenant and profile. */
export async function createBinding(docType: string, tenantKey: string | null, profileId: string, actor: string): Promise<CreateBindingResult> {
  const outcome = await callGate('rag_create_embedding_binding', { p_doc_type: docType, p_tenant_key: tenantKey, p_profile_id: profileId, p_actor: actor });
  if ('refusal' in outcome) return outcome.refusal;
  const bindingId = text(outcome.row, 'binding_id');
  const status = text(outcome.row, 'binding_status');
  if (!bindingId || !status) throw new ProfileUnavailableError('rpc_failed', 'malformed_response');
  await refreshBindingsAfterOperation();
  return { ok: true, bindingId, status, created: outcome.row.created === true };
}

/** available, backfilling or retired. The SQL refuses active (only the gate sets it) and any change to an active row. */
export async function setBindingStatus(bindingId: string, status: string, actor: string): Promise<SetBindingStatusResult> {
  const outcome = await callGate('rag_set_embedding_binding_status', { p_binding_id: bindingId, p_status: status, p_actor: actor });
  if ('refusal' in outcome) return outcome.refusal;
  const id = text(outcome.row, 'binding_id');
  const next = text(outcome.row, 'binding_status');
  if (!id || !next) throw new ProfileUnavailableError('rpc_failed', 'malformed_response');
  await refreshBindingsAfterOperation();
  return { ok: true, bindingId: id, status: next };
}

const REAL_PROVENANCE: readonly string[] = ['production', 'human'];

/**
 * BindingComparison → BindingActivationEvidence for one binding (D-13). The slice counts come from the comparison's provenance counts of the
 * doc-type slice, so synthetic items never count as real. The verdict holds only when the comparison passed, recommended this binding's
 * profile and did not run on the fixture embedder (D-11). The gate re-checks every value.
 */
export function deriveBindingEvidence(
  comparison: BindingComparison,
  binding: BindingRow,
  baselineBindingProfile: string | null,
  recordedAt: string,
): BindingActivationEvidence {
  const candidate = comparison.candidates.find((entry) => entry.profile_id === binding.profileId);
  if (!candidate) throw new BindingEvidenceInvalidError(`the comparison has no candidate arm for ${binding.profileId}`);
  const runId = comparison.reembed_run_ids[binding.profileId];
  if (!runId) throw new BindingEvidenceInvalidError(`the comparison names no re-embed run for ${binding.profileId}`);
  const counts = Object.entries(comparison.provenance_counts);
  const n = counts.reduce((sum, [, count]) => sum + count, 0);
  const realN = counts.filter(([provenance]) => REAL_PROVENANCE.includes(provenance)).reduce((sum, [, count]) => sum + count, 0);
  const byLanguage: Record<string, boolean> = {};
  for (const language of Object.keys(candidate.by_language).sort()) byLanguage[language] = !candidate.language_regressions.includes(language);
  const evidence = {
    binding_id: binding.id,
    target_profile: comparison.recommended_profile ?? binding.profileId,
    doc_type: comparison.doc_type,
    tenant_key: binding.tenantKey,
    baseline_global_profile: comparison.baseline.profile_id,
    baseline_binding_profile: baselineBindingProfile,
    gate_passed: comparison.gate_passed && candidate.recommended && !comparison.fixture_embedder,
    doc_type_slice: { n, real_n: realN, passed: candidate.beats_baseline && candidate.beats_control, by_language: byLanguage },
    other_slices_passed: candidate.other_slice_regressions.length === 0,
    backfill_run_id: runId,
    recorded_at: recordedAt,
  };
  const parsed = BindingActivationEvidenceSchema.safeParse(evidence);
  if (!parsed.success) throw new BindingEvidenceInvalidError(parsed.error.issues.map((issue) => issue.message).join('; '));
  return parsed.data;
}

/**
 * Stores evidence on a binding through rag_record_binding_evidence. `input` is a BindingComparison (derived for this binding) or a raw
 * BindingActivationEvidence that must name this binding. Invalid input throws BindingEvidenceInvalidError before any write.
 */
export async function recordBindingEvidence(bindingId: string, input: unknown, actor: string): Promise<RecordBindingEvidenceResult> {
  let evidence: BindingActivationEvidence;
  const comparison = BindingComparisonSchema.safeParse(input);
  if (comparison.success) {
    const rows = await listBindingRows();
    const binding = rows.find((row) => row.id === bindingId);
    if (!binding) return UNKNOWN_BINDING;
    const key = bindingKey(binding);
    const active = rows.find((row) => row.status === 'active' && row.id !== binding.id && bindingKey(row) === key);
    evidence = deriveBindingEvidence(comparison.data, binding, active?.profileId ?? null, new Date().toISOString());
  } else {
    const raw = BindingActivationEvidenceSchema.safeParse(input);
    if (!raw.success) {
      throw new BindingEvidenceInvalidError(`comparison or evidence JSON is invalid: ${raw.error.issues.map((issue) => issue.message).join('; ')}`);
    }
    evidence = raw.data;
  }
  if (evidence.binding_id !== bindingId) throw new BindingEvidenceInvalidError('--binding must match evidence.binding_id');

  const outcome = await callGate('rag_record_binding_evidence', { p_binding_id: bindingId, p_evidence: evidence, p_actor: actor });
  if ('refusal' in outcome) return outcome.refusal;
  await refreshBindingsAfterOperation();
  return { ok: true, bindingId: text(outcome.row, 'binding_id') ?? bindingId, evidence };
}

/** Flips a binding to active through the gate (D-09); the previous active binding of the key becomes available. */
export async function activateBinding(bindingId: string, actor: string): Promise<ActivateBindingResult> {
  const outcome = await callGate('rag_activate_embedding_binding', { p_binding_id: bindingId, p_actor: actor });
  if ('refusal' in outcome) return outcome.refusal;
  const activated = text(outcome.row, 'activated_binding');
  if (!activated) throw new ProfileUnavailableError('rpc_failed', 'malformed_response');
  await refreshBindingsAfterOperation();
  const binding = (await listBindingRows()).find((row) => row.id === activated);
  if (!binding) throw new ProfileUnavailableError('rpc_failed', 'malformed_response');
  return { ok: true, binding, previous: text(outcome.row, 'previous_binding') };
}

/** Restores the previous binding of (doc type, tenant) when its index is still complete (D-10). */
export async function rollbackBinding(docType: string, tenantKey: string | null, actor: string): Promise<RollbackBindingResult> {
  const outcome = await callGate('rag_rollback_embedding_binding', { p_doc_type: docType, p_tenant_key: tenantKey, p_actor: actor });
  if ('refusal' in outcome) return outcome.refusal;
  const restored = text(outcome.row, 'restored_binding');
  const rolledBack = text(outcome.row, 'rolled_back_binding');
  if (!restored || !rolledBack) throw new ProfileUnavailableError('rpc_failed', 'malformed_response');
  await refreshBindingsAfterOperation();
  const binding = (await listBindingRows()).find((row) => row.id === restored);
  if (!binding) throw new ProfileUnavailableError('rpc_failed', 'malformed_response');
  return { ok: true, restored: binding, rolledBack };
}

/** Sets the active binding of (doc type, tenant) to available: the key falls back to the global profile alone (D-10). */
export async function deactivateBinding(docType: string, tenantKey: string | null, actor: string): Promise<DeactivateBindingResult> {
  const outcome = await callGate('rag_deactivate_embedding_binding', { p_doc_type: docType, p_tenant_key: tenantKey, p_actor: actor });
  if ('refusal' in outcome) return outcome.refusal;
  const deactivated = text(outcome.row, 'deactivated_binding');
  if (!deactivated) throw new ProfileUnavailableError('rpc_failed', 'malformed_response');
  await refreshBindingsAfterOperation();
  return { ok: true, deactivated };
}
