import { createClient } from '@supabase/supabase-js';
import type { RpcClient } from '@/lib/rag/backend/supabase-rpc';
import { setIngestDepsForTests } from '@/lib/rag/ingest/deps';
import { fixtureProcessEnv } from './fake-edge.mts';
import { createFakeObjectStore, type FakeObjectStore } from '../../tests/helpers/fake-object-store.ts';
import { setObjectStoreForTests } from '@/lib/rag/ingest/object-store';
import type { FakeSidecar } from '../../tests/helpers/fake-sidecar.ts';

export function fixtureAdminClient(edgeUrl: string): RpcClient {
  const key = fixtureProcessEnv(edgeUrl).SUPABASE_SERVICE_ROLE_KEY as string;
  return createClient(edgeUrl, key, { auth: { persistSession: false, autoRefreshToken: false } }) as unknown as RpcClient;
}

export interface IngestFakes {
  sidecar: FakeSidecar;
  objectStore: FakeObjectStore;
  uninstall(): Promise<void>;
}

export async function installIngestFakes(options: { db: RpcClient }): Promise<IngestFakes> {
  setIngestDepsForTests({ db: () => options.db });
  const objectStore = createFakeObjectStore();
  setObjectStoreForTests(objectStore);
  return { sidecar: { uploads: [] } as unknown as FakeSidecar, objectStore, async uninstall() {} };
}
