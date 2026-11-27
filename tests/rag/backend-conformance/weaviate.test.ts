import { describe } from 'vitest';
import { runConformance } from './cases';
import { weaviateFactory } from './weaviate-factory';

describe.runIf(process.env.WEAVIATE_URL)('weaviate backend', () => {
  runConformance('weaviate', weaviateFactory);
});
