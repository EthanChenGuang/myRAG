import { useOrganizationStore } from '@/lib/stores/organization-store';

export function getActiveOrganizationId(): string | undefined {
  const { currentOrganization, isPersonalMode } = useOrganizationStore.getState();
  return !isPersonalMode && currentOrganization?.id ? currentOrganization.id : undefined;
}
