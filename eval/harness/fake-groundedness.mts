import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  GroundednessRequestSchema,
  type GroundednessRequest,
  type GroundednessResult,
} from '../../src/lib/rag-eval/contracts.generated.ts';

/**
 * Harness-only stand-in for the sidecar's POST /v1/groundedness (D-11, D-24). It keeps the shared-secret check and the
 * language routing, and replaces the scorers with a deterministic token-overlap score. Never imported by src/.
 */
export interface FakeGroundedness {
  url: string;
  secret: string;
  requests: GroundednessRequest[];
  close(): Promise<void>;
}

const SECRET_HEADER = 'x-sidecar-secret';
const PATH = '/v1/groundedness';
const MAX_BODY_BYTES = 1_000_000;

export function sameSecret(given: string | undefined, expected: string): boolean {
  if (typeof given !== 'string') return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export function latinTokens(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

export function hanChars(text: string): string[] {
  return text.match(/\p{Script=Han}/gu) ?? [];
}

/** Share of the hypothesis units that also occur in the premise, rounded to four places. */
export function overlapScore(premise: string[], hypothesis: string, units: (text: string) => string[]): number {
  const wanted = units(hypothesis);
  if (wanted.length === 0) return 0;
  const available = new Set(premise.flatMap(units));
  const hits = wanted.filter((unit) => available.has(unit)).length;
  return Math.round((hits / wanted.length) * 10_000) / 10_000;
}

export function fakeGroundednessResult(request: GroundednessRequest): GroundednessResult {
  const language = request.language.trim().toLowerCase();
  if (language === 'en') {
    return {
      status: 'scored',
      scorer: 'hhem_2_1_open',
      score: overlapScore(request.premise_texts, request.hypothesis, latinTokens),
      reason: null,
      truncated: false,
      latency_ms: 1,
    };
  }
  if (language === 'zh-hans') {
    if (!request.allow_vectara) {
      return { status: 'not_checked', scorer: 'none', score: null, reason: 'scorer_unavailable', truncated: false, latency_ms: 0 };
    }
    return {
      status: 'scored',
      scorer: 'hhem_2_3_vectara',
      score: overlapScore(request.premise_texts, request.hypothesis, hanChars),
      reason: null,
      truncated: false,
      latency_ms: 1,
    };
  }
  return { status: 'not_checked', scorer: 'none', score: null, reason: 'unsupported_language', truncated: false, latency_ms: 0 };
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export async function startFakeGroundedness(options: { secret?: string } = {}): Promise<FakeGroundedness> {
  const secret = options.secret ?? crypto.randomBytes(24).toString('hex');
  const requests: GroundednessRequest[] = [];
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
        send(res, 422, { error: 'invalid_groundedness_request' });
        return;
      }
      const parsed = GroundednessRequestSchema.safeParse(raw);
      if (!parsed.success) {
        send(res, 422, { error: 'invalid_groundedness_request' });
        return;
      }
      requests.push(parsed.data);
      send(res, 200, fakeGroundednessResult(parsed.data));
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
