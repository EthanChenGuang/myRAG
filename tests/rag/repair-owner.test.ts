import { describe, expect, it, vi } from 'vitest';
import { repairOwnerMembership } from '@/lib/rag/tenant/repair-owner';

const USER = '33333333-3333-4333-8333-333333333333';
const ORG = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';

describe('repairOwnerMembership', () => {
  it('does nothing in single-tenant mode', async () => {
    const verify = vi.fn();
    await repairOwnerMembership({ requestedOrganizationId: ORG, getUser: async () => ({ id: USER }), deploymentMode: 'single-tenant', verify });
    expect(verify).not.toHaveBeenCalled();
  });

  it.each([undefined, null, '', 'null', 'not-a-uuid', 42])('does nothing for the personal or malformed request %p', async (requested) => {
    const verify = vi.fn();
    await repairOwnerMembership({ requestedOrganizationId: requested, getUser: async () => ({ id: USER }), deploymentMode: 'multi-tenant', verify });
    expect(verify).not.toHaveBeenCalled();
  });

  it('does nothing without a session user', async () => {
    const verify = vi.fn();
    await repairOwnerMembership({ requestedOrganizationId: ORG, getUser: async () => null, deploymentMode: 'multi-tenant', verify });
    expect(verify).not.toHaveBeenCalled();
  });

  it('calls the verification with the session user and the lowercased organization', async () => {
    const verify = vi.fn(async () => ({ hasAccess: true }));
    await repairOwnerMembership({ requestedOrganizationId: ` ${ORG} `, getUser: async () => ({ id: USER }), deploymentMode: 'multi-tenant', verify });
    expect(verify).toHaveBeenCalledWith(USER, ORG.toLowerCase());
  });

  it('never throws when the session lookup or the verification fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      repairOwnerMembership({
        requestedOrganizationId: ORG,
        getUser: async () => {
          throw new Error('auth down');
        },
        deploymentMode: 'multi-tenant',
      }),
    ).resolves.toBeUndefined();
    await expect(
      repairOwnerMembership({
        requestedOrganizationId: ORG,
        getUser: async () => ({ id: USER }),
        deploymentMode: 'multi-tenant',
        verify: async () => {
          throw new Error('db down');
        },
      }),
    ).resolves.toBeUndefined();
  });
});
