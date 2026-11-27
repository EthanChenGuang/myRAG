import { runConformance } from './cases';
import { weaviateFactory } from './weaviate-factory';
import { createFakeWeaviate } from '../backend/weaviate-fake';

/** The real seed path (PGlite, outbox, drainSlice) and the real store and adapter over the tenant-only fake client; no services. */
const fake = createFakeWeaviate();
runConformance('weaviate over the fake client', () => weaviateFactory({ read: fake, write: fake }));
