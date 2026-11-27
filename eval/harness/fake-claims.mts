import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  ClaimCheckRequestSchema,
  type ClaimCheckRequest,
  type ClaimCheckResult,
} from '../../src/lib/rag-eval/contracts.generated.ts';
import { hanChars, latinTokens, overlapScore, sameSecret } from './fake-groundedness.mts';

/**
 * Harness-only stand-in for the sidecar's POST /v1/groundedness/claims (D-22, D-27). It keeps the shared-secret check
 * (constant-time compare), the generated request schema plus the sidecar's reference rules, and the language routing;
 * the scorers become a deterministic token overlap between each claim and its referenced premises. Never imported by src/.
 */
export interface FakeClaimsSidecar {
  url: string;
  secret: string;
  requests: ClaimCheckRequest[];
  close(): Promise<void>;
}

const SECRET_HEADER = 'x-sidecar-secret';
const PATH = '/v1/groundedness/claims';
const MAX_BODY_BYTES = 1_000_000;
const VECTARA_LANGUAGES = new Set(['en', 'zh-hans']);
const LOCAL_LANGUAGES = new Set(['en']);

/** The rules the sidecar's Pydantic model adds to the generated schema: unique refs and indexes, every ref resolves. */
function referencesResolve(request: ClaimCheckRequest): boolean {
  const refs = request.premises.map((premise) => premise.ref);
  const known = new Set(refs);
  if (known.size !== refs.length) return false;
  if (new Set(request.claims.map((claim) => claim.index)).size !== request.claims.length) return false;
  return request.claims.every((claim) => claim.premise_refs.every((ref) => known.has(ref)));
}

export function fakeClaimsResult(request: ClaimCheckRequest): ClaimCheckResult {
  const language = request.language.trim().toLowerCase();
  const scorer = request.allow_vectara && VECTARA_LANGUAGES.has(language) ? 'hhem_2_3_vectara' : LOCAL_LANGUAGES.has(language) ? 'hhem_2_1_open' : null;
  if (scorer === null) {
    return {
      claims: request.claims.map((claim) => ({ index: claim.index, status: 'not_checked', scorer: 'none', score: null, reason: 'unsupported_language' })),
      latency_ms: 0,
    };
  }
  const units = language === 'zh-hans' ? hanChars : latinTokens;
  const texts = new Map(request.premises.map((premise) => [premise.ref, premise.text]));
  return {
    claims: request.claims.map((claim) => ({
      index: claim.index,
      status: 'scored',
      scorer,
      score: overlapScore(
        claim.premise_refs.map((ref) => texts.get(ref) ?? ''),
        claim.hypothesis,
        units,
      ),
      reason: null,
    })),
    latency_ms: 1,
  };
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export async function startFakeClaimsSidecar(options: { secret?: string } = {}): Promise<FakeClaimsSidecar> {
  const secret = options.secret ?? crypto.randomBytes(24).toString('hex');
  const requests: ClaimCheckRequest[] = [];
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== PATH) {
      req.resume();
      send(res, 404, { error: 'not_found' });
      return;
    }
    if (!sameSecret(req.headers[SECRET_HEADER] as string | undefined, secret)) {
      req.resume();
      send(res, 401, { error: 'unauthorized' });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > MAX_BODY_BYTES) {
        send(res, 413, { error: 'groundedness_request_too_large' });
        return;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        send(res, 422, { error: 'invalid_claims_request' });
        return;
      }
      const parsed = ClaimCheckRequestSchema.safeParse(raw);
      if (!parsed.success || !referencesResolve(parsed.data)) {
        send(res, 422, { error: 'invalid_claims_request' });
        return;
      }
      requests.push(parsed.data);
      send(res, 200, fakeClaimsResult(parsed.data));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    secret,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
