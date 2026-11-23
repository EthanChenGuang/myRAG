import { runRetrieval } from '@/lib/rag';

export function tenantBrandTypeChecks(): void {
  // @ts-expect-error a hand-built object literal is not a TenantScope
  void runRetrieval({ scope: { kind: 'single', userId: null, organizationId: null }, query: 'q', profile: 'eval', signal: new AbortController().signal });
}
