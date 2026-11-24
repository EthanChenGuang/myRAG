// Loaded on demand (import()) after the process environment is set: it imports app modules that read `@/lib/env` once.
import { createClient } from '@supabase/supabase-js';
import type { RpcClient } from '@/lib/rag/backend/supabase-rpc';
import { resetIngestConfigForTests, type IngestEnvInput } from '@/lib/rag/ingest/config';
import { resetIngestDepsForTests, setIngestDepsForTests } from '@/lib/rag/ingest/deps';
import { resetObjectStoreForTests, setObjectStoreForTests } from '@/lib/rag/ingest/object-store';
import { resetLlamaParseParserForTests, setLlamaParseParserForTests } from '@/lib/rag/ingest/parsers/llamaparse-v2';
import { ParserError, type DocumentParser } from '@/lib/rag/ingest/parsers/shared';
import { createSidecarParser, resetSidecarParserForTests, setSidecarParserForTests } from '@/lib/rag/ingest/parsers/sidecar-docling';
import { fixtureProcessEnv } from './fake-edge.mts';
import { embedText } from './fixture-embedder.mts';
import { createFakeObjectStore, type FakeObjectStore } from '../../tests/helpers/fake-object-store.ts';
import { startFakeSidecar, type FakeSidecar } from '../../tests/helpers/fake-sidecar.ts';

/** What ingest mode runs with: the unified pipeline and LlamaParse as the configured parser, which the stub below leaves unavailable. */
export const INGEST_MODE_ENV: IngestEnvInput = { RAG_INGEST_PIPELINE: 'unified', RAG_PARSER: 'llamaparse' };

/** The service-role client of the fake edge. It is built here, not taken from the app singleton, so every build talks to its own edge. */
export function fixtureAdminClient(edgeUrl: string): RpcClient {
  const key = fixtureProcessEnv(edgeUrl).SUPABASE_SERVICE_ROLE_KEY as string;
  return createClient(edgeUrl, key, { auth: { persistSession: false, autoRefreshToken: false } }) as unknown as RpcClient;
}

const llamaParseStub: DocumentParser = {
  name: 'llamaparse',
  unavailableReason: () => 'missing_key',
  async parse() {
    throw new ParserError('llamaparse', 'missing_key');
  },
};

export interface IngestFakes {
  /** The HTTP stand-in for the sidecar; it serves the recorded ParseResults of eval/fixtures/ingest/manifest.json by file hash. */
  sidecar: FakeSidecar;
  /** The in-memory store that keeps originals and parse artifacts. */
  objectStore: FakeObjectStore;
  uninstall(): Promise<void>;
}

/**
 * Replaces everything ingest() would call outside the database with a local fake: the sidecar client talks to the fake sidecar over
 * HTTP, LlamaParse is an always-unavailable stub, storage is in memory and embeddings come from the fixture embedder. The database is
 * the caller's, so ingest() runs the real writer functions on it. Test setters only; production modules keep their real defaults.
 */
export async function installIngestFakes(options: { db: RpcClient; env?: IngestEnvInput }): Promise<IngestFakes> {
  const sidecar = await startFakeSidecar();
  const objectStore = createFakeObjectStore();
  resetIngestConfigForTests();
  setIngestDepsForTests({
    db: () => options.db,
    embedDocuments: async (texts) => texts.map((text) => embedText(text)),
    ingestEnv: () => options.env ?? INGEST_MODE_ENV,
  });
  setObjectStoreForTests(objectStore);
  setLlamaParseParserForTests(llamaParseStub);
  setSidecarParserForTests(createSidecarParser({ baseUrl: sidecar.url, secret: sidecar.secret }));
  return {
    sidecar,
    objectStore,
    async uninstall() {
      resetSidecarParserForTests();
      resetLlamaParseParserForTests();
      resetObjectStoreForTests();
      resetIngestDepsForTests();
      resetIngestConfigForTests();
      await sidecar.close();
    },
  };
}
