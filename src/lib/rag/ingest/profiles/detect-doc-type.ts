import type { DocTypeDetection } from '@/lib/rag-eval/contracts.generated';

export const DOC_TYPE_CONFIDENCE_FLOOR = 0.6;

export interface DetectDocTypeInput {
  filename: string;
  mimeType?: string | null;
  text?: string | null;
  textLayerPageShare?: number | null;
}

export function detectDocType(_input: DetectDocTypeInput): DocTypeDetection {
  return { doc_type: 'general', confidence: 0, signals: [], method: 'rules' };
}
