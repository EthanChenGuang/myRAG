import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { z } from 'zod/v3';
import { requireAdminOrDeny } from '@/lib/admin-route-auth';
import { redactUrls } from '@/lib/mcp/server-redact';
import { toPublicServer } from '@/lib/mcp/server-redact';

// Re-use the same schema from the main route
const McpServerSchema = z.object({
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

type McpServer = z.infer<typeof McpServerSchema>;

// Helper functions (duplicated for now, could be moved to shared module)
function getEnvFilePath(): string {
  return path.join(process.cwd(), '.env.local');
}

function parseEnvFile(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  const lines = content.split('\n');
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const equalIndex = trimmed.indexOf('=');
      if (equalIndex > 0) {
        const key = trimmed.substring(0, equalIndex).trim();
        const value = trimmed.substring(equalIndex + 1).trim();
        env[key] = value;
      }
    }
  }
  
  return env;
}

function stringifyEnvFile(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n') + '\n';
}

async function loadCustomServers(): Promise<McpServer[]> {
  try {
    const envPath = getEnvFilePath();
    if (!fs.existsSync(envPath)) {
      return [];
    }
    
    const content = fs.readFileSync(envPath, 'utf-8');
    const env = parseEnvFile(content);
    
    const customServersJson = env.MCP_CUSTOM_SERVERS;
    if (!customServersJson) {
      return [];
    }
    
    const customServers = JSON.parse(customServersJson);
    return Array.isArray(customServers) ? customServers : [];
  } catch (error) {
    console.error('Error loading custom MCP servers:', error);
    return [];
  }
}

async function saveCustomServers(servers: McpServer[]): Promise<void> {
  try {
    const envPath = getEnvFilePath();
    let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
    
    const serversJson = JSON.stringify(servers);
    
    // Check if MCP_CUSTOM_SERVERS already exists in the file
    if (content.includes('MCP_CUSTOM_SERVERS=')) {
      // Update the existing value using regex replacement
      content = content.replace(
        /MCP_CUSTOM_SERVERS=(.*)(\r?\n|$)/,
        `MCP_CUSTOM_SERVERS=${serversJson}$2`
      );
    } else {
      // Add the MCP_CUSTOM_SERVERS to the file
      // Look for an existing MCP section or add at the end
      if (content.includes('# MCP')) {
        // Add it in the MCP section
        content = content.replace(
          /(# MCP.*?)(\r?\n)(\r?\n|$)/,
          `$1$2MCP_CUSTOM_SERVERS=${serversJson}$2$3`
        );
      } else {
        // Add a new MCP section at the end
        if (!content.endsWith('\n')) content += '\n';
        content += `# MCP Custom Servers Configuration\nMCP_CUSTOM_SERVERS=${serversJson}\n`;
      }
    }
    
    fs.writeFileSync(envPath, content);
    console.log('MCP Servers: Successfully updated .env.local file');
  } catch (error) {
    console.error('Error saving custom MCP servers:', error);
    throw new Error('Failed to save MCP server configuration');
  }
}

async function testServerConnection(server: McpServer): Promise<{ success: boolean; message: string; latency?: number }> {
  try {
    const startTime = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), server.settings?.timeout || 30000);
    
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    
    // Add authentication headers if configured
    if (server.authentication?.type === 'bearer' && server.authentication.credentials?.token) {
      headers['Authorization'] = `Bearer ${server.authentication.credentials.token}`;
    } else if (server.authentication?.type === 'api-key' && server.authentication.credentials?.apiKey) {
      headers['X-API-Key'] = server.authentication.credentials.apiKey;
    } else if (server.authentication?.type === 'basic' && server.authentication.credentials?.username && server.authentication.credentials?.password) {
      const credentials = btoa(`${server.authentication.credentials.username}:${server.authentication.credentials.password}`);
      headers['Authorization'] = `Basic ${credentials}`;
    }
    
    const response = await fetch(server.endpoint, {
      method: 'HEAD',
      headers,
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);
    const latency = Date.now() - startTime;
    
    if (response.ok || response.status < 500) {
      return {
        success: true,
        message: `Connection successful (${response.status})`,
        latency,
      };
    } else {
      return {
        success: false,
        message: `Server error: ${response.status} ${response.statusText}`,
        latency,
      };
    }
  } catch (error: any) {
    return {
      success: false,
      message: error.name === 'AbortError' ? 'Connection timeout' : `Connection failed: ${redactUrls(String(error.message))}`,
    };
  }
}

async function discoverTools(server: McpServer): Promise<{ success: boolean; tools?: any[]; message: string }> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), server.settings?.timeout || 30000);
    
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    
    // Add authentication headers if configured
    if (server.authentication?.type === 'bearer' && server.authentication.credentials?.token) {
      headers['Authorization'] = `Bearer ${server.authentication.credentials.token}`;
    } else if (server.authentication?.type === 'api-key' && server.authentication.credentials?.apiKey) {
      headers['X-API-Key'] = server.authentication.credentials.apiKey;
    } else if (server.authentication?.type === 'basic' && server.authentication.credentials?.username && server.authentication.credentials?.password) {
      const credentials = btoa(`${server.authentication.credentials.username}:${server.authentication.credentials.password}`);
      headers['Authorization'] = `Basic ${credentials}`;
    }
    
    // Try common MCP tool discovery endpoints
    const discoveryEndpoints = [
      '/tools',
      '/discover',
      '/capabilities',
      '',
    ];
    
    for (const endpoint of discoveryEndpoints) {
      try {
        const url = server.endpoint + endpoint;
        const response = await fetch(url, {
          method: 'GET',
          headers,
          signal: controller.signal,
        });
        
        if (response.ok) {
          const data = await response.json();
          clearTimeout(timeoutId);
          
          // Try to extract tools from various response formats
          let tools = [];
          if (data.tools) {
            tools = Array.isArray(data.tools) ? data.tools : [data.tools];
          } else if (Array.isArray(data)) {
            tools = data;
          } else if (data.capabilities) {
            tools = Array.isArray(data.capabilities) ? data.capabilities : [data.capabilities];
          }
          
          return {
            success: true,
            tools,
            message: `Discovered ${tools.length} tools`,
          };
        }
      } catch (endpointError) {
        // Continue to next endpoint
        continue;
      }
    }
    
    clearTimeout(timeoutId);
    return {
      success: false,
      message: 'No discoverable tools endpoint found. The server may need manual tool configuration.',
    };
  } catch (error: any) {
    return {
      success: false,
      message: error.name === 'AbortError' ? 'Tool discovery timeout' : `Tool discovery failed: ${redactUrls(String(error.message))}`,
    };
  }
}

type RouteContext = { params: Promise<{ id: string }> };

const CREDENTIAL_FIELDS = ['token', 'apiKey', 'username', 'password'] as const;

// A blank or missing endpoint or credential in an update keeps the stored value; reads never return them.
function mergeWithStored(body: any, stored: McpServer): any {
  if (!body || typeof body !== 'object') return body;
  const merged = { ...body };
  if (typeof merged.endpoint !== 'string' || merged.endpoint.trim() === '') {
    merged.endpoint = stored.endpoint;
  }
  const authType = merged.authentication?.type ?? 'none';
  if (authType !== 'none' && authType === (stored.authentication?.type ?? 'none')) {
    const incoming = merged.authentication?.credentials ?? {};
    const kept = { ...incoming };
    for (const field of CREDENTIAL_FIELDS) {
      if (!kept[field] && stored.authentication?.credentials?.[field]) {
        kept[field] = stored.authentication.credentials[field];
      }
    }
    merged.authentication = { ...merged.authentication, credentials: kept };
  }
  return merged;
}

// GET /api/mcp/servers/[id] - Get specific server (admin only; endpoint and credentials are never returned)
export async function GET(req: NextRequest, { params }: RouteContext) {
  const denied = await requireAdminOrDeny(req);
  if (denied) return denied;

  const { id } = await params;
  try {
    const customServers = await loadCustomServers();
    const server = customServers.find(s => s.id === id);

    if (!server) {
      return NextResponse.json(
        { error: `Server with ID '${id}' not found` },
        { status: 404 }
      );
    }

    return NextResponse.json({ server: toPublicServer(server) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    console.error('[MCP Server API] failed to fetch server', { id });
    return NextResponse.json({ error: 'Failed to fetch MCP server' }, { status: 500 });
  }
}

// PUT /api/mcp/servers/[id] - Update server (admin only)
export async function PUT(req: NextRequest, { params }: RouteContext) {
  const denied = await requireAdminOrDeny(req);
  if (denied) return denied;

  const { id } = await params;
  try {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const customServers = await loadCustomServers();
    const serverIndex = customServers.findIndex(s => s.id === id);

    if (serverIndex === -1) {
      return NextResponse.json(
        { error: `Server with ID '${id}' not found` },
        { status: 404 }
      );
    }

    const serverConfig = McpServerSchema.parse(mergeWithStored(body, customServers[serverIndex]));

    if (serverConfig.id !== id) {
      return NextResponse.json(
        { error: 'Server ID in URL does not match server ID in body' },
        { status: 400 }
      );
    }

    customServers[serverIndex] = serverConfig;
    await saveCustomServers(customServers);

    console.log('[MCP Server API] server updated', { id });

    return NextResponse.json({
      server: toPublicServer(serverConfig),
      message: `Server '${serverConfig.name}' updated successfully`,
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid server configuration', details: error.errors },
        { status: 400 }
      );
    }

    console.error('[MCP Server API] failed to update server', { id });
    return NextResponse.json({ error: 'Failed to update MCP server' }, { status: 500 });
  }
}

// DELETE /api/mcp/servers/[id] - Delete server (admin only)
export async function DELETE(req: NextRequest, { params }: RouteContext) {
  const denied = await requireAdminOrDeny(req);
  if (denied) return denied;

  const { id } = await params;
  try {
    if (id === 'zapier') {
      return NextResponse.json(
        { error: 'Built-in servers cannot be deleted' },
        { status: 400 }
      );
    }

    const customServers = await loadCustomServers();
    const serverIndex = customServers.findIndex(s => s.id === id);

    if (serverIndex === -1) {
      return NextResponse.json(
        { error: `Server with ID '${id}' not found` },
        { status: 404 }
      );
    }

    const deletedServer = customServers.splice(serverIndex, 1)[0];
    await saveCustomServers(customServers);

    console.log('[MCP Server API] server deleted', { id });

    return NextResponse.json({
      message: `Server '${deletedServer.name}' deleted successfully`,
    });
  } catch {
    console.error('[MCP Server API] failed to delete server', { id });
    return NextResponse.json({ error: 'Failed to delete MCP server' }, { status: 500 });
  }
}

// POST /api/mcp/servers/[id] - Test connection or discover tools for a stored server (admin only)
export async function POST(req: NextRequest, { params }: RouteContext) {
  const denied = await requireAdminOrDeny(req);
  if (denied) return denied;

  const { id } = await params;
  try {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const action = body?.action;

    const customServers = await loadCustomServers();
    const server = customServers.find(s => s.id === id);

    if (!server) {
      return NextResponse.json(
        { error: `Server with ID '${id}' not found` },
        { status: 404 }
      );
    }

    if (action === 'test') {
      return NextResponse.json(await testServerConnection(server));
    } else if (action === 'discover') {
      return NextResponse.json(await discoverTools(server));
    } else {
      return NextResponse.json(
        { error: 'Invalid action. Supported actions: test, discover' },
        { status: 400 }
      );
    }
  } catch {
    console.error('[MCP Server API] server action failed', { id });
    return NextResponse.json({ error: 'Failed to perform server action' }, { status: 500 });
  }
}
