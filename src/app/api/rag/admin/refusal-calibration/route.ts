import { NextResponse } from 'next/server';
import { requireAdminOrDeny } from '@/lib/admin-route-auth';
import {
  currentRefusalCalibrationInputs,
  currentRefusalCalibrationStatus,
  PENDING_KEYS,
  pendingCells,
  refusalCalibrationStatus,
  type PendingAlert,
  type PendingChangeRecord,
} from '@/lib/rag';
import { getSupabaseAdmin } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CHANGE_WINDOW_DAYS = 400;
const MAX_CHANGE_ROWS = 1000;
const MAX_ALERT_ROWS = 500;

function jsonNoStore(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

interface QueryResult {
  data: unknown;
  error: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

function changeRecords(data: unknown): PendingChangeRecord[] | null {
  if (!Array.isArray(data)) return null;
  const rows: PendingChangeRecord[] = [];
  for (const row of data) {
    if (!isRecord(row) || typeof row.created_at !== 'string' || !Array.isArray(row.changed_keys)) return null;
    rows.push({ created_at: row.created_at, changed_keys: row.changed_keys.filter((key): key is string => typeof key === 'string') });
  }
  return rows;
}

function scoreShiftAlerts(data: unknown): PendingAlert[] | null {
  if (!Array.isArray(data)) return null;
  const rows: PendingAlert[] = [];
  for (const row of data) {
    if (!isRecord(row) || typeof row.id !== 'string' || typeof row.language !== 'string' || typeof row.day !== 'string') return null;
    rows.push({ id: row.id, language: row.language, day: row.day });
  }
  return rows;
}

/**
 * D-18 / D-24: change records of reranker, embedding-model or tokenizer settings from the last 400 days, and open or acknowledged
 * top_score_psi alerts, read with the service-role client. Any missing table, read error or unexpected row means null, and the status is
 * answered exactly as before the pending marks existed.
 */
async function readPendingSources(): Promise<{ changes: PendingChangeRecord[]; alerts: PendingAlert[] } | null> {
  try {
    const admin = getSupabaseAdmin();
    if (!admin) return null;
    const since = new Date(Date.now() - CHANGE_WINDOW_DAYS * 86_400_000).toISOString();
    const [changes, alerts] = (await Promise.all([
      admin
        .from('rag_config_change_records')
        .select('created_at, changed_keys')
        .gte('created_at', since)
        .overlaps('changed_keys', [...PENDING_KEYS])
        .order('created_at', { ascending: false })
        .limit(MAX_CHANGE_ROWS),
      admin
        .from('rag_monitor_alerts')
        .select('id, language, day')
        .eq('rule', 'top_score_psi')
        .in('status', ['open', 'acknowledged'])
        .order('day', { ascending: false })
        .limit(MAX_ALERT_ROWS),
    ])) as [QueryResult, QueryResult];
    if (changes.error || alerts.error) return null;
    const changeRows = changeRecords(changes.data);
    const alertRows = scoreShiftAlerts(alerts.data);
    if (!changeRows || !alertRows) return null;
    return { changes: changeRows, alerts: alertRows };
  } catch {
    return null;
  }
}

/**
 * The refusal switch, the configured reranker and model per tier, every threshold cell with its point estimates and 95% upper bounds, and
 * the Config UI warnings (D-17). With the change records and alerts readable, each cell also carries its derived pending mark (D-18, D-24).
 * Read-only: thresholds change only through the calibration tool and a pull request.
 */
export async function GET(request: Request): Promise<Response> {
  const denied = await requireAdminOrDeny(request);
  if (denied) return denied;

  try {
    const sources = await readPendingSources();
    if (!sources) return jsonNoStore({ success: true, ...currentRefusalCalibrationStatus() });
    const { thresholds, config, embeddingModel } = currentRefusalCalibrationInputs();
    const pending = pendingCells({ thresholds, changes: sources.changes, alerts: sources.alerts, running: { config, embeddingModel } });
    return jsonNoStore({ success: true, ...refusalCalibrationStatus(thresholds, config, pending) });
  } catch (error) {
    console.error('[RAG Admin] refusal calibration status failed', { reason: error instanceof Error ? error.name : 'unexpected' });
    return jsonNoStore({ success: false, error: 'refusal_status_unavailable' }, 500);
  }
}
