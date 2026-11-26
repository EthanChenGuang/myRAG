import type { VectorSyncSliceReport } from '@/lib/rag-eval/contracts.generated';

export type VectorSyncLogSink = (line: string) => void;

export function logVectorSync(report: VectorSyncSliceReport, sink: VectorSyncLogSink = (line) => console.log(line)): void {
  sink(`[Vector Sync] ${JSON.stringify(report)}`);
}
