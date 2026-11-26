import type { AttributeDefinition } from '@/lib/rag-eval/contracts.generated';
import type { ChunkIdentifiers } from '../../identifiers/extract';
import type { TenantScope } from '../../tenant/scope';

export interface AttributeIdentifierEntry {
  raw: string;
  norm: string;
}

export function attributeIdentifierEntries(_definitions: readonly AttributeDefinition[], _attributes: Readonly<Record<string, unknown>> | null | undefined): AttributeIdentifierEntry[] {
  return [];
}

export function mergeAttributeIdentifiers(chunkEntries: readonly ChunkIdentifiers[], _attributeEntries: readonly AttributeIdentifierEntry[]): ChunkIdentifiers[] {
  return [...chunkEntries];
}

export async function loadAttributeIdentifiers(_scope: TenantScope, _documentId: string, _options: { signal: AbortSignal }): Promise<AttributeIdentifierEntry[] | null> {
  return null;
}
