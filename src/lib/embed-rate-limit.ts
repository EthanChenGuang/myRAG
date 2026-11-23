import { env } from '@/lib/env';

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

// In-memory store for rate limiting (in production, use Redis or similar)
const rateLimitStore = new Map<string, RateLimitEntry>();

// Clean up expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore.entries()) {
    if (now > entry.resetTime) {
      rateLimitStore.delete(key);
    }
  }
}, 5 * 60 * 1000);

export function checkRateLimit(identifier: string): { allowed: boolean; remaining: number; resetTime: number } {
  const limit = parseInt(env.EMBED_RATE_LIMIT);
  const windowMs = 60 * 60 * 1000; // 1 hour
  const now = Date.now();
  
  const entry = rateLimitStore.get(identifier);
  
  if (!entry || now > entry.resetTime) {
    // First request or window expired
    const resetTime = now + windowMs;
    rateLimitStore.set(identifier, { count: 1, resetTime });
    return { allowed: true, remaining: limit - 1, resetTime };
  }
  
  if (entry.count >= limit) {
    // Rate limit exceeded
    return { allowed: false, remaining: 0, resetTime: entry.resetTime };
  }
  
  // Increment count
  entry.count++;
  rateLimitStore.set(identifier, entry);
  
  return { allowed: true, remaining: limit - entry.count, resetTime: entry.resetTime };
}

function lastForwardedHop(header: string | null): string | null {
  const hops = (header || '').split(',').map(hop => hop.trim()).filter(Boolean);
  return hops.length > 0 ? hops[hops.length - 1]! : null;
}

/** The client IP as seen by the nearest trusted proxy; never the left-most, client-controlled X-Forwarded-For entry. */
export function getTrustedClientIp(request: Request): string {
  const realIp = request.headers.get('x-real-ip')?.trim();
  if (process.env.VERCEL) {
    return realIp || request.headers.get('x-vercel-forwarded-for')?.trim() || lastForwardedHop(request.headers.get('x-forwarded-for')) || 'unknown';
  }
  return lastForwardedHop(request.headers.get('x-forwarded-for')) || realIp || 'unknown';
}

export function getRateLimitIdentifier(request: Request): string {
  const tenant = env.RAG_EMBED_TENANT || 'default';
  return `${getTrustedClientIp(request)}:${tenant}`;
}
