import { z } from 'zod/v3';
import { readEnvFile, stringifyJsonForEnv, writeEnvUpdates } from '@/lib/env-file';

export const McpServerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  endpoint: z.string().url(),
  type: z.enum(['http', 'sse']).default('http'),
  authentication: z.object({
    type: z.enum(['none', 'bearer', 'api-key', 'basic']).default('none'),
    credentials: z.object({
      token: z.string().optional(),
      apiKey: z.string().optional(),
      username: z.string().optional(),
      password: z.string().optional(),
    }).optional(),
    credentialsOrigin: z.string().optional(),
  }).optional(),
  settings: z.object({
    timeout: z.number().default(30000),
    retryAttempts: z.number().default(3),
    enabledInChat: z.boolean().default(true),
    enabledInEmbed: z.boolean().default(false),
    yoloMode: z.boolean().default(false),
  }).optional(),
  enabled: z.boolean().default(true),
});

export type McpServer = z.infer<typeof McpServerSchema>;

export const CREDENTIAL_FIELDS = ['token', 'apiKey', 'username', 'password'] as const;

export function endpointOrigin(endpoint: string | undefined): string {
  if (!endpoint) return '';
  try {
    return new URL(endpoint).origin;
  } catch {
    return '';
  }
}

function hasCredentials(server: Pick<McpServer, 'authentication'>): boolean {
  const credentials = server.authentication?.credentials ?? {};
  return CREDENTIAL_FIELDS.some((field) => typeof credentials[field] === 'string' && credentials[field] !== '');
}

/** The credentials that may be sent to this server's endpoint: none when they were stored for a different origin. */
export function credentialsForEndpoint(server: McpServer): McpServer['authentication'] {
  const authentication = server.authentication;
  if (!authentication || !hasCredentials(server)) return authentication;
  const boundTo = authentication.credentialsOrigin;
  if (boundTo && boundTo !== endpointOrigin(server.endpoint)) {
    return { type: authentication.type };
  }
  return authentication;
}

export function authHeaders(server: McpServer): Record<string, string> {
  const authentication = credentialsForEndpoint(server);
  const credentials = authentication?.credentials;
  if (authentication?.type === 'bearer' && credentials?.token) {
    return { Authorization: `Bearer ${credentials.token}` };
  }
  if (authentication?.type === 'api-key' && credentials?.apiKey) {
    return { 'X-API-Key': credentials.apiKey };
  }
  if (authentication?.type === 'basic' && credentials?.username && credentials?.password) {
    return { Authorization: `Basic ${btoa(`${credentials.username}:${credentials.password}`)}` };
  }
  return {};
}

/** Binds the credentials of a server about to be stored to its endpoint origin. */
export function bindCredentials(server: McpServer): McpServer {
  if (!server.authentication) return server;
  const { credentialsOrigin: _previous, ...rest } = server.authentication;
  return {
    ...server,
    authentication: hasCredentials(server)
      ? { ...rest, credentialsOrigin: endpointOrigin(server.endpoint) }
      : rest,
  };
}

/**
 * A blank or missing endpoint or credential in an update keeps the stored value, but only while the endpoint origin
 * is unchanged: pointing a server at another origin discards the stored credentials unless new ones come with the request.
 */
export function mergeWithStored(body: any, stored: McpServer): any {
  if (!body || typeof body !== 'object') return body;
  const merged = { ...body };
  if (typeof merged.endpoint !== 'string' || merged.endpoint.trim() === '') {
    merged.endpoint = stored.endpoint;
  }
  const sameOrigin = endpointOrigin(merged.endpoint) === endpointOrigin(stored.endpoint);
  const storedCredentials = sameOrigin ? credentialsForEndpoint(stored)?.credentials : undefined;
  const authType = merged.authentication?.type ?? 'none';
  if (authType !== 'none' && authType === (stored.authentication?.type ?? 'none') && storedCredentials) {
    const incoming = merged.authentication?.credentials ?? {};
    const kept = { ...incoming };
    for (const field of CREDENTIAL_FIELDS) {
      if (!kept[field] && storedCredentials[field]) {
        kept[field] = storedCredentials[field];
      }
    }
    merged.authentication = { ...merged.authentication, credentials: kept };
  }
  if (merged.authentication && typeof merged.authentication === 'object') {
    const { credentialsOrigin: _ignored, ...clientAuth } = merged.authentication;
    merged.authentication = clientAuth;
  }
  return merged;
}

export async function loadCustomServers(): Promise<McpServer[]> {
  try {
    const raw = readEnvFile().MCP_CUSTOM_SERVERS;
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    console.error('[MCP Servers] failed to load custom servers');
    return [];
  }
}

export async function saveCustomServers(servers: McpServer[]): Promise<void> {
  writeEnvUpdates({ MCP_CUSTOM_SERVERS: stringifyJsonForEnv(servers.map(bindCredentials)) });
}
