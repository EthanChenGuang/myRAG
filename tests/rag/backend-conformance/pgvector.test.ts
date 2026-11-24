import { runConformance } from './cases';
import { pgvectorFactory } from './pgvector-factory';

runConformance('pgvector', pgvectorFactory);