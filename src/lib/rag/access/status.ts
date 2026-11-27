import { AccessGroupsError } from './errors';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function accessStatus(..._args: unknown[]): Promise<any> {
  throw new AccessGroupsError('accessStatus', 'not_implemented');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function syncAccessStatus(..._args: unknown[]): Promise<any> {
  throw new AccessGroupsError('syncAccessStatus', 'not_implemented');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function runAccessDrift(..._args: unknown[]): Promise<any> {
  throw new AccessGroupsError('runAccessDrift', 'not_implemented');
}

