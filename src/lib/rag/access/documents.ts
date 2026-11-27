import { AccessGroupsError } from './errors';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function setDocumentsAccess(..._args: unknown[]): Promise<any> {
  throw new AccessGroupsError('setDocumentsAccess', 'not_implemented');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function setUploadAccess(..._args: unknown[]): Promise<any> {
  throw new AccessGroupsError('setUploadAccess', 'not_implemented');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function listAccessDocuments(..._args: unknown[]): Promise<any> {
  throw new AccessGroupsError('listAccessDocuments', 'not_implemented');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function documentAudiences(..._args: unknown[]): Promise<any> {
  throw new AccessGroupsError('documentAudiences', 'not_implemented');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function documentAccessCounts(..._args: unknown[]): Promise<any> {
  throw new AccessGroupsError('documentAccessCounts', 'not_implemented');
}

