import { isAdminUser, type RagAdminDb } from '@/lib/rag';

export interface ScopedImageContext {
  imageUrl?: string;
  downloadableUrls?: string[];
  attachedImages?: unknown[];
  extractedAt?: number;
}

type ImageContextStore = Record<string, ScopedImageContext>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Key for per-caller MCP state: the verified user id plus the chat id, never the chat id alone. */
export function callerScopeKey(userId: string, chatId: string): string {
  return `${userId.toLowerCase()}::${chatId}`;
}

function imageStore(create: boolean): ImageContextStore | undefined {
  const holder = globalThis as unknown as { mcpImageContext?: ImageContextStore };
  if (!holder.mcpImageContext && create) holder.mcpImageContext = {};
  return holder.mcpImageContext;
}

export function writeImageContext(userId: string, chatId: string, entry: ScopedImageContext): void {
  const store = imageStore(true);
  if (store) store[callerScopeKey(userId, chatId)] = entry;
}

export function readImageContext(userId: string, chatId: string | undefined | null): ScopedImageContext | undefined {
  if (!chatId) return undefined;
  return imageStore(false)?.[callerScopeKey(userId, chatId)];
}

export function deleteImageContext(userId: string, chatId: string | undefined | null): void {
  if (!chatId) return;
  const store = imageStore(false);
  if (store) delete store[callerScopeKey(userId, chatId)];
}

/** Image URLs recorded for this caller and chat, from the exact scoped entry only. */
export function imageUrlsFromContext(userId: string, chatId: string | undefined | null): string[] {
  const context = readImageContext(userId, chatId);
  if (!context) return [];
  if (Array.isArray(context.downloadableUrls) && context.downloadableUrls.length > 0) return context.downloadableUrls;
  return context.imageUrl ? [context.imageUrl] : [];
}

/**
 * The operator's MCP account is for admins only. Returns the verified admin user id, or null for anonymous
 * callers, non-admins and any lookup failure (fail closed).
 */
export async function resolveMcpAdminUserId(input: {
  getSessionUser: () => Promise<{ id: string } | null>;
  admin: RagAdminDb | null;
  signal: AbortSignal;
}): Promise<string | null> {
  try {
    const user = await input.getSessionUser();
    if (!user || typeof user.id !== 'string' || !UUID_RE.test(user.id) || !input.admin) return null;
    return (await isAdminUser(input.admin, user.id.toLowerCase(), input.signal)) ? user.id : null;
  } catch {
    return null;
  }
}
