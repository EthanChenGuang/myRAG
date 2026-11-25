interface RedactableServer {
  id: string;
  name: string;
  description?: string;
  endpoint?: string;
  type?: string;
  enabled?: boolean;
  authentication?: {
    type?: string;
    credentials?: Record<string, string | undefined>;
  };
  settings?: Record<string, unknown>;
}

export interface PublicMcpServer {
  id: string;
  name: string;
  description?: string;
  type?: string;
  enabled: boolean;
  host: string;
  hasCredentials: boolean;
  authentication: { type: string };
  settings?: Record<string, unknown>;
}

export function hostOf(endpoint: string | undefined): string {
  if (!endpoint) return '';
  try {
    return new URL(endpoint).host;
  } catch {
    return '';
  }
}

/** Strips full URLs from free text such as upstream error messages; they can carry account secrets. */
export function redactUrls(text: string): string {
  return text.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url]');
}

/** The shape any MCP server read returns: the host and a credentials flag, never the endpoint path, query or credentials. */
export function toPublicServer(server: RedactableServer): PublicMcpServer {
  const credentials = server.authentication?.credentials ?? {};
  return {
    id: server.id,
    name: server.name,
    ...(server.description !== undefined ? { description: server.description } : {}),
    ...(server.type !== undefined ? { type: server.type } : {}),
    enabled: server.enabled !== false,
    host: hostOf(server.endpoint),
    hasCredentials: Object.values(credentials).some((value) => typeof value === 'string' && value !== ''),
    authentication: { type: server.authentication?.type ?? 'none' },
    ...(server.settings ? { settings: server.settings } : {}),
  };
}
