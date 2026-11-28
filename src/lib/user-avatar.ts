export interface AvatarUserLike {
  email?: string | null;
  user_metadata?: Record<string, unknown> | null;
}

export interface UserAvatar {
  imageUrl: string | null;
  initials: string | null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function safeImageUrl(value: unknown): string | null {
  const raw = str(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function initialsFrom(name: string): string | null {
  const words = name.split(/[\s._-]+/).filter(Boolean);
  if (words.length === 0) return null;
  const chars = words.length === 1
    ? Array.from(words[0]).slice(0, 2)
    : [Array.from(words[0])[0], Array.from(words[words.length - 1])[0]];
  const result = chars.join('').toUpperCase();
  return result || null;
}

export function getUserAvatar(user: AvatarUserLike | null | undefined): UserAvatar {
  if (!user) return { imageUrl: null, initials: null };
  const meta = user.user_metadata ?? {};
  const imageUrl = safeImageUrl(meta.avatar_url) ?? safeImageUrl(meta.picture);
  const displayName = str(meta.full_name) ?? str(meta.name) ?? str(meta.user_name) ?? str(meta.preferred_username);
  const emailLocal = str(user.email)?.split('@')[0] ?? null;
  const initials = (displayName && initialsFrom(displayName)) ?? (emailLocal && initialsFrom(emailLocal)) ?? null;
  return { imageUrl, initials };
}
