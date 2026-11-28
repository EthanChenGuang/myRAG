import { listScopeExamples, loadRagConfig, scopeGateCalibrationView, scopeGateStatus, SCOPE_EXAMPLE_LIMIT, SCOPE_EXAMPLE_MAX_CHARS } from '@/lib/rag';
import type { RagConfig, ScopeExample, ScopeGateStatus } from '@/lib/rag';
import { getRAGBehaviorMode, type RAGBehaviorMode } from '@/lib/rag-mode';
import type { ScopeGateCalibration } from '@/lib/rag-eval/contracts.generated';
import { OrganizationIdSchema, SCOPE_CALIBRATE_COMMAND, SCOPE_CENTROIDS_COMMAND, invalid, jsonNoStore, organizationIdParam, requireAdminOrDenyWithActor, resolveWorkspace, unavailable } from './_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type SwitchState = 'on' | 'off';
type PipelineState = 'ready' | 'legacy' | 'layer_off' | 'bypass' | 'stage_disabled';
type ThresholdState = 'ready' | 'missing' | 'eval_only' | 'invalid';
type ScopeDataState = 'ready' | 'missing' | 'rebuilding' | 'unsupported';

function switchState(config: RagConfig): SwitchState {
  return config.queryAdditions.raw.scopeGate ? 'on' : 'off';
}

function pipelineState(config: RagConfig, ragMode: RAGBehaviorMode): PipelineState {
  if (config.pipeline !== 'v2' || config.pipelineBlocked !== null || config.pipelineServedLegacy) return 'legacy';
  if (!config.queryLayer.enabled) return 'layer_off';
  if (ragMode === 'bypass') return 'bypass';
  if (config.operatorDisabledStages?.has('scope_gate')) return 'stage_disabled';
  return 'ready';
}

function thresholdState(calibration: ScopeGateCalibration | null, profileId: string, ragMode: RAGBehaviorMode): ThresholdState {
  if (!calibration) return 'invalid';
  if (ragMode === 'bypass') return 'missing';
  const cell = (calibration.cells ?? []).find((entry) => entry.embedding_profile_id === profileId && entry.rag_mode === ragMode);
  if (!cell || cell.status !== 'calibrated' || cell.threshold === null || cell.margin === null) return 'missing';
  return calibration.source === 'fixture' ? 'eval_only' : 'ready';
}

function scopeDataState(status: ScopeGateStatus): ScopeDataState {
  if (status.rebuildRunning) return 'rebuilding';
  if (status.unsupported) return 'unsupported';
  const total = status.groups.doc_type + status.groups.scope_tag + status.groups.tenant;
  return total > 0 ? 'ready' : 'missing';
}

function thresholdRows(calibration: ScopeGateCalibration | null, activeProfileId: string) {
  if (!calibration) return [];
  return (calibration.cells ?? []).map((cell) => ({
    embeddingProfileId: cell.embedding_profile_id,
    activeProfile: cell.embedding_profile_id === activeProfileId,
    ragMode: cell.rag_mode,
    status: cell.status,
    source: calibration.source,
    threshold: cell.threshold,
    margin: cell.margin,
    falseRefusalRate: cell.false_refusal_rate,
    falseRefusalN: cell.false_refusal_n,
    falseRefusalUpper95: cell.false_refusal_upper_95 ?? null,
    correctRefusalRate: cell.correct_refusal_rate,
    correctRefusalN: cell.correct_refusal_n,
    recordedAt: calibration.recorded_at,
  }));
}

function exampleRow(example: ScopeExample) {
  return { id: example.id, text: example.text, createdBy: example.createdBy, createdAt: example.createdAt, inUse: true };
}

/**
 * D-33 item 2, D-26, D-27: what the scope gate does for the verified admin's workspace. The running switch, pipeline, query-layer flag,
 * RAG mode and active profile, the four readiness rows (the server decides canSkip), the scope data per kind, the rebuild capability,
 * the out-of-scope examples with their limits and the read-only threshold rows of eval/config/scope-gate.json. Named fields only: no
 * tenant key, vector, user question or score is ever answered.
 */
export async function GET(request: Request): Promise<Response> {
  const gate = await requireAdminOrDenyWithActor(request);
  if (!gate.ok) return gate.response;

  const parsed = OrganizationIdSchema.safeParse(organizationIdParam(request));
  if (!parsed.success) return invalid(parsed.error);
  const workspace = await resolveWorkspace(gate.userId, parsed.data, request.signal);
  if (!workspace.ok) return workspace.response;

  try {
    const [status, examples] = await Promise.all([scopeGateStatus(workspace.scope), listScopeExamples(workspace.scope)]);
    if (!status.ok || !examples.ok) {
      console.error('[RAG Admin] scope gate status failed', { code: !status.ok ? status.code : !examples.ok ? examples.code : 'unknown' });
      return unavailable();
    }
    const config = loadRagConfig(process.env);
    const ragMode = getRAGBehaviorMode();
    const calibration = scopeGateCalibrationView();
    const profileId = status.status.profileId;

    const readiness = {
      switch: switchState(config),
      pipeline: pipelineState(config, ragMode),
      thresholds: thresholdState(calibration, profileId, ragMode),
      scopeData: scopeDataState(status.status),
    };
    const canSkip =
      readiness.switch === 'on' &&
      readiness.pipeline === 'ready' &&
      readiness.thresholds === 'ready' &&
      readiness.scopeData === 'ready' &&
      !config.disabledStages.has('scope_gate');

    console.log('[RAG Admin] scope gate status', {
      groups: status.status.groups.doc_type + status.status.groups.scope_tag + status.status.groups.tenant,
      examples: examples.examples.length,
      canSkip,
    });

    return jsonNoStore({
      success: true,
      running: {
        scopeGate: readiness.switch === 'on',
        pipeline: config.pipeline,
        queryLayer: config.queryLayer.enabled,
        ragMode,
        activeProfileId: profileId,
      },
      canSkip,
      readiness: [
        { row: 'switch', state: readiness.switch },
        { row: 'pipeline', state: readiness.pipeline },
        { row: 'thresholds', state: readiness.thresholds, profileId, ragMode, command: SCOPE_CALIBRATE_COMMAND },
        { row: 'scope_data', state: readiness.scopeData },
      ],
      scopeData: {
        state: readiness.scopeData,
        kinds: [
          { kind: 'doc_type', referencePoints: status.status.groups.doc_type },
          { kind: 'scope_tag', referencePoints: status.status.groups.scope_tag },
          { kind: 'tenant', referencePoints: status.status.groups.tenant },
        ],
        chunksIncluded: status.status.chunksIncluded,
        updatedAt: status.status.newestUpdate,
        rebuild: status.status.unsupported ? { browser: false, command: SCOPE_CENTROIDS_COMMAND } : { browser: true, command: null },
      },
      examples: {
        rows: examples.examples.map(exampleRow),
        total: examples.examples.length,
        limit: SCOPE_EXAMPLE_LIMIT,
        maxChars: SCOPE_EXAMPLE_MAX_CHARS,
      },
      thresholds: {
        present: calibration !== null,
        valid: calibration !== null,
        source: calibration?.source ?? null,
        recordedAt: calibration?.recorded_at ?? null,
        command: SCOPE_CALIBRATE_COMMAND,
        rows: thresholdRows(calibration, profileId),
      },
    });
  } catch (error) {
    console.error('[RAG Admin] scope gate status failed', { reason: error instanceof Error ? error.name : 'unexpected' });
    return unavailable();
  }
}
