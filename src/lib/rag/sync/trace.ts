import type { VectorSyncSliceReport } from '@/lib/rag-eval/contracts.generated';
import type { LangfuseConfig } from '@/lib/rag/trace/config';
import type { CollectedTrace, ExportTraceOptions } from '@/lib/rag/trace/langfuse';

export interface VectorSyncTraceOptions {
  config?: LangfuseConfig;
  exportTrace?: (trace: CollectedTrace, options: ExportTraceOptions) => Promise<void>;
  startedAt?: number;
}

export function traceVectorSync(_report: VectorSyncSliceReport, _options: VectorSyncTraceOptions = {}): void {}
