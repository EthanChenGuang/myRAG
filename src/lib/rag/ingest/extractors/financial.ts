import { extractEnhancedMetadata, type EnhancedMetadata } from '@/lib/temporal-metadata-extractor';
import type { ChunkExtractor } from './index';

/** The one extractEnhancedMetadata call per chunk; the dates extractor and the generic keys reuse its result. */
export function computeEnhancedMetadata(content: string): EnhancedMetadata {
  return extractEnhancedMetadata(content);
}

export const extractFinancial: ChunkExtractor = ({ enhanced }) => ({
  metadata: {
    financial_entities: enhanced.financial_entities,
    numerical_density: enhanced.numerical_density,
    has_financial_data: enhanced.financial_entities.length > 0,
    is_high_value_chunk: enhanced.chunk_semantic_type === 'financial_data' || enhanced.chunk_semantic_type === 'mixed',
  },
});
