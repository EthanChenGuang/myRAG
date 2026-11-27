import type { WeaviateClientLike } from './types';

export interface WeaviateCollectionState {
  exists: boolean;
  dims: number | null;
  lexicalMode: string | null;
}

export function weaviateCollectionSpec(_profileId: string, _dims: number): Record<string, unknown> {
  return {};
}

export async function describeWeaviateCollection(_client: WeaviateClientLike, _profileId: string): Promise<WeaviateCollectionState> {
  return { exists: false, dims: null, lexicalMode: null };
}
