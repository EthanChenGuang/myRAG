import { describe } from 'vitest';
import { runConformance } from './cases';
import { qdrantFactory } from './qdrant-factory';

describe.runIf(process.env.QDRANT_URL)('qdrant backend', () => {
  runConformance('qdrant', qdrantFactory);
});
