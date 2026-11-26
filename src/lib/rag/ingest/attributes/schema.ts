import type { AttributeDefinition } from '@/lib/rag-eval/contracts.generated';
import type { TenantScope } from '../../tenant/scope';

type Unavailable = { ok: false; reason: 'unavailable' };
const UNAVAILABLE: Unavailable = { ok: false, reason: 'unavailable' };

export function docAttributesEnabled(): boolean {
  return true;
}
export async function listAttributeDefinitions(_input: unknown): Promise<{ ok: true; items: unknown[] } | Unavailable> {
  return UNAVAILABLE;
}
export async function upsertAttributeDefinition(_input: unknown, _definition: unknown): Promise<{ ok: true; item: unknown } | Unavailable> {
  return UNAVAILABLE;
}
export async function deleteAttributeDefinition(_input: unknown, _key: string): Promise<{ ok: true; key: string } | Unavailable> {
  return UNAVAILABLE;
}
export async function loadAttributeSchema(
  _scope: TenantScope,
  _options: { signal: AbortSignal; fresh?: boolean },
): Promise<{ ok: true; definitions: readonly AttributeDefinition[] } | Unavailable> {
  return UNAVAILABLE;
}
export function resetAttributeSchemaCacheForTests(): void {}
