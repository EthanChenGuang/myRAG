import { VectorSyncSliceReportSchema, type VectorSyncSliceReport } from '@/lib/rag-eval/contracts.generated';

export type VectorSyncLogSink = (line: string) => void;

const defaultSink: VectorSyncLogSink = (line) => console.log(line);

export interface VectorSyncLogPayload {
  mode: VectorSyncSliceReport['mode'];
  claimed: number;
  upserted: number;
  deleted: number;
  failed: number;
  dead: number;
  lagSeconds: number;
  elapsedMs: number;
}

/** D-25: the fixed field list. The report is validated against VectorSyncSliceReport with unknown keys stripped, then copied field by field. */
export function buildVectorSyncLogPayload(report: VectorSyncSliceReport): VectorSyncLogPayload {
  const valid = VectorSyncSliceReportSchema.strip().parse(report);
  return {
    mode: valid.mode,
    claimed: valid.claimed,
    upserted: valid.upserted,
    deleted: valid.deleted,
    failed: valid.failed,
    dead: valid.dead,
    lagSeconds: valid.lag_seconds,
    elapsedMs: valid.elapsed_ms,
  };
}

/** One structured line per slice; counts only, so no chunk text, lexical_text, tenant key or document name can reach the sink. */
export function logVectorSync(report: VectorSyncSliceReport, sink: VectorSyncLogSink = defaultSink): void {
  sink(`[Vector Sync] ${JSON.stringify(buildVectorSyncLogPayload(report))}`);
}
