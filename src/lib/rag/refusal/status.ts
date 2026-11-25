import type { RefusalThresholds } from '@/lib/rag-eval/contracts.generated';
import type { RagConfig } from '../config';

export interface RefusalCalibrationStatus {
  cells: unknown[];
  warnings: unknown[];
}

export function refusalCalibrationStatus(_thresholds: RefusalThresholds | null, _config: RagConfig): RefusalCalibrationStatus {
  return { cells: [], warnings: [] };
}

export function currentRefusalCalibrationStatus(): RefusalCalibrationStatus {
  return { cells: [], warnings: [] };
}
