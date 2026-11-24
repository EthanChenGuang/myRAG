import { createHmac, timingSafeEqual } from 'node:crypto';

export interface PremiumContinuationPayload {
  jobId: string;
  llamaJobId: string;
  attemptNo: number;
}

function sidecarSecret(): string {
  return process.env.RAG_SIDECAR_SECRET ?? '';
}

function signPayload(encoded: string, secret: string): string {
  return createHmac('sha256', secret).update(encoded, 'utf8').digest('base64url');
}

/** Opaque, HMAC-signed continuation for a sliced LlamaParse poll (T-03.1-76). */
export function encodePremiumContinuation(payload: PremiumContinuationPayload): string {
  const secret = sidecarSecret();
  if (secret === '') throw new Error('continuation_secret_unset');
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encoded}.${signPayload(encoded, secret)}`;
}

export function decodePremiumContinuation(token: string, jobId: string): PremiumContinuationPayload | null {
  const secret = sidecarSecret();
  if (secret === '' || !token.includes('.')) return null;
  const [encoded, signature] = token.split('.', 2) as [string, string];
  if (!encoded || !signature) return null;
  const expected = signPayload(encoded, secret);
  try {
    if (!timingSafeEqual(Buffer.from(signature, 'utf8'), Buffer.from(expected, 'utf8'))) return null;
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as PremiumContinuationPayload;
    if (parsed.jobId !== jobId) return null;
    if (typeof parsed.llamaJobId !== 'string' || parsed.llamaJobId === '') return null;
    if (!Number.isInteger(parsed.attemptNo) || parsed.attemptNo < 1) return null;
    return parsed;
  } catch {
    return null;
  }
}