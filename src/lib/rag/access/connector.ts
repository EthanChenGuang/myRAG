import { AccessGroupsError } from './errors';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function applyConnectorAccess(..._args: unknown[]): Promise<any> {
  throw new AccessGroupsError('applyConnectorAccess', 'not_implemented');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function matchConnectorMembers(..._args: unknown[]): Promise<any> {
  throw new AccessGroupsError('matchConnectorMembers', 'not_implemented');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function listConnectorMap(..._args: unknown[]): Promise<any> {
  throw new AccessGroupsError('listConnectorMap', 'not_implemented');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function setConnectorMap(..._args: unknown[]): Promise<any> {
  throw new AccessGroupsError('setConnectorMap', 'not_implemented');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function deleteConnectorMap(..._args: unknown[]): Promise<any> {
  throw new AccessGroupsError('deleteConnectorMap', 'not_implemented');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function listSharingRules(..._args: unknown[]): Promise<any> {
  throw new AccessGroupsError('listSharingRules', 'not_implemented');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function setSharingRule(..._args: unknown[]): Promise<any> {
  throw new AccessGroupsError('setSharingRule', 'not_implemented');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function connectorFailClosedCounts(..._args: unknown[]): Promise<any> {
  throw new AccessGroupsError('connectorFailClosedCounts', 'not_implemented');
}

