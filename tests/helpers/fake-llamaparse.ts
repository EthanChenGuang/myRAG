import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeLlamaPage {
  page_number: number;
  success: boolean;
  markdown?: string;
  error?: string;
}

export interface FakeLlamaItemPage {
  page_number: number;
  page_width?: number;
  page_height?: number;
  items: Array<Record<string, unknown>>;
}

export interface FakeLlamaJobSpec {
  /** Statuses answered by successive polls; the last one repeats. Default: RUNNING then COMPLETED. */
  statuses?: string[];
  pages?: FakeLlamaPage[];
  itemPages?: FakeLlamaItemPage[];
  /** Answer the upload with this status instead of a job. */
  uploadStatus?: number;
  /** Never answer a poll of this job (a hung service). */
  hangOnPoll?: boolean;
  /** Answer polls of this job with this status (for example 404 for an expired job). */
  pollStatus?: number;
}

export interface FakeLlamaCall {
  method: string;
  path: string;
  query: string;
  /** True when the request carried the Authorization header of the fake's key. Never the value. */
  authorized: boolean;
  hasAuthorization: boolean;
  contentType: string;
}

export interface FakeLlamaUpload {
  fileBytes: number;
  fileName: string;
  configuration: unknown;
}

export interface FakeLlamaParse {
  /** Base URL of the fake, for example http://127.0.0.1:41234 */
  url: string;
  apiKey: string;
  calls: FakeLlamaCall[];
  uploads: FakeLlamaUpload[];
  /** Specs are used one per upload, in order; the last one repeats. */
  enqueue(...specs: FakeLlamaJobSpec[]): void;
  /** Makes the next polls of a job answer 404, as an expired job does. */
  expire(jobId: string): void;
  /** The URL the fake serves an image from, for image items. */
  imageUrl(name: string): string;
  setImage(name: string, bytes: Uint8Array, contentType: string): void;
  redirectImage(name: string, location: string): void;
  close(): Promise<void>;
}

export const THREE_PAGES: FakeLlamaPage[] = [
  { page_number: 1, success: true, markdown: 'Handbook\n\nFirst page text about pallets.' },
  { page_number: 2, success: true, markdown: 'Receiving\n\nSecond page text about the dock.' },
  { page_number: 3, success: true, markdown: 'Shipping\n\nThird page text about the cage.' },
];

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  response.end(text);
}

/** A local stand-in for the LlamaParse v2 upload and job endpoints and for the presigned image host. */
export interface FakeLlamaParseOptions {
  apiKey?: string;
  /** Consulted on every upload before the queued specs; a returned spec answers that upload. */
  resolveSpec?: () => FakeLlamaJobSpec | undefined;
}

export async function startFakeLlamaParse(options: FakeLlamaParseOptions = {}): Promise<FakeLlamaParse> {
  const apiKey = options.apiKey ?? 'llx-test-key-0000';
  const calls: FakeLlamaCall[] = [];
  const uploads: FakeLlamaUpload[] = [];
  const specs: FakeLlamaJobSpec[] = [];
  const jobs = new Map<string, { spec: FakeLlamaJobSpec; polls: number; expired: boolean }>();
  const images = new Map<string, { bytes: Uint8Array; contentType: string }>();
  const redirects = new Map<string, string>();
  let uploadCount = 0;

  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://fake');
      const authorization = request.headers.authorization;
      calls.push({
        method: request.method ?? 'GET',
        path: url.pathname,
        query: url.search,
        authorized: authorization === `Bearer ${apiKey}`,
        hasAuthorization: authorization !== undefined,
        contentType: String(request.headers['content-type'] ?? ''),
      });

      if (url.pathname.startsWith('/images/')) {
        const name = url.pathname.slice('/images/'.length);
        const redirect = redirects.get(name);
        if (redirect) {
          response.writeHead(302, { location: redirect });
          response.end();
          return;
        }
        const image = images.get(name);
        if (!image) return send(response, 404, { detail: 'no such image' });
        response.writeHead(200, { 'content-type': image.contentType, 'content-length': image.bytes.byteLength });
        response.end(Buffer.from(image.bytes));
        return;
      }

      if (authorization !== `Bearer ${apiKey}`) return send(response, 401, { detail: 'unauthorized' });

      if (request.method === 'POST' && url.pathname === '/api/v2/parse/upload') {
        const body = await readBody(request);
        const form = await new Response(new Uint8Array(body), { headers: { 'content-type': String(request.headers['content-type'] ?? '') } }).formData();
        const file = form.get('file');
        const configuration = form.get('configuration');
        uploads.push({
          fileBytes: file instanceof Blob ? file.size : 0,
          fileName: file instanceof File ? file.name : '',
          configuration: typeof configuration === 'string' ? (JSON.parse(configuration) as unknown) : null,
        });
        const spec = options.resolveSpec?.() ?? specs[Math.min(uploadCount, specs.length - 1)] ?? {};
        uploadCount += 1;
        if (spec.uploadStatus !== undefined) return send(response, spec.uploadStatus, { detail: 'upload refused' });
        const id = `job-${uploadCount}`;
        jobs.set(id, { spec, polls: 0, expired: false });
        return send(response, 200, { id, status: 'PENDING' });
      }

      const match = /^\/api\/v2\/parse\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
      if (request.method === 'GET' && match) {
        const job = jobs.get(match[1] as string);
        if (!job || job.expired) return send(response, 404, { detail: 'job not found' });
        if (job.spec.hangOnPoll) return;
        if (job.spec.pollStatus !== undefined) return send(response, job.spec.pollStatus, { detail: 'refused' });
        const statuses = job.spec.statuses ?? ['RUNNING', 'COMPLETED'];
        const status = statuses[Math.min(job.polls, statuses.length - 1)] as string;
        job.polls += 1;
        if (status !== 'COMPLETED') return send(response, 200, { job: { id: match[1], status }, markdown: null, items: null, images_content_metadata: null });
        return send(response, 200, {
          job: { id: match[1], status },
          markdown: { pages: job.spec.pages ?? THREE_PAGES },
          items: { pages: job.spec.itemPages ?? [] },
          images_content_metadata: { images: [] },
        });
      }
      send(response, 404, { detail: 'not found' });
    })().catch(() => {
      if (!response.headersSent) send(response, 500, { detail: 'fake failure' });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url: origin,
    apiKey,
    calls,
    uploads,
    enqueue: (...next) => void specs.push(...next),
    expire(jobId) {
      const job = jobs.get(jobId);
      if (job) job.expired = true;
    },
    imageUrl: (name) => `${origin}/images/${name}`,
    setImage: (name, bytes, contentType) => void images.set(name, { bytes, contentType }),
    redirectImage: (name, location) => void redirects.set(name, location),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
