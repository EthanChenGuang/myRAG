import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import dns from 'node:dns';
import { ORIGINALS_MAX_BYTES } from '../object-store';

type ManifestLine = {
  source_key: string;
  path?: string | null;
  url?: string | null;
  kindHint?: string | null;
};

export type SourceKind = 'folder' | 'bucket' | 'manifest';

export interface SourceItem {
  sourceKey: string;
  size: number;
  ext: string;
  kindHint?: ManifestLine['kindHint'];
  open(signal?: AbortSignal): Promise<NodeJS.ReadableStream>;
}

export interface ListSourceInput {
  kind: SourceKind;
  ref: string;
  signal?: AbortSignal;
  deps?: BackfillSourceDeps;
}

export interface StorageListObject {
  name: string;
  id?: string | null;
  metadata?: { size?: number } | null;
}

export interface BackfillStorageBucket {
  list: (
    prefix: string,
    options?: { limit?: number; offset?: number },
  ) => Promise<{ data: StorageListObject[] | null; error: { message?: string } | null }>;
  download: (objectPath: string) => Promise<{ data: Blob | null; error: { message?: string } | null }>;
}

export interface BackfillSourceDeps {
  fetch?: typeof fetch;
  resolveHost?: typeof dns.promises.resolve;
  onManifestReject?: (reason: string) => void;
  storage?: { from: (bucket: string) => BackfillStorageBucket };
}

const MANIFEST_FETCH_MS = 30_000;
const MAX_REDIRECTS = 8;

function signalOrTimeout(signal?: AbortSignal): AbortSignal {
  return signal ?? AbortSignal.timeout(MANIFEST_FETCH_MS);
}

function extname(name: string): string {
  const base = path.basename(name);
  const dot = base.lastIndexOf('.');
  if (dot < 1) return 'bin';
  const ext = base.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : 'bin';
}

function isIpBlocked(address: string, family: number): boolean {
  if (family === 6) {
    const lower = address.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80')) return true;
    return false;
  }
  const parts = address.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts;
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 169 && b === 254) return true;
  if (a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

async function assertPublicUrl(
  url: URL,
  resolveHost: typeof dns.promises.resolve,
  signal: AbortSignal,
): Promise<void> {
  if (url.protocol !== 'https:') throw new Error('manifest_https_required');
  const host = url.hostname;
  if (host === 'localhost' || host.endsWith('.localhost')) throw new Error('private_url');
  const records = await resolveHost(host, { signal, ttl: true, verbatim: true });
  for (const record of records) {
    if (isIpBlocked(record.address, record.family)) throw new Error('private_url');
  }
}

async function fetchUrlBytes(
  url: string,
  deps: BackfillSourceDeps,
  signal: AbortSignal,
): Promise<{ bytes: Uint8Array; size: number }> {
  const resolveHost = deps.resolveHost ?? dns.promises.resolve.bind(dns.promises);
  const fetchFn = deps.fetch ?? fetch;
  let current = new URL(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertPublicUrl(current, resolveHost, signal);
    const response = await fetchFn(current.toString(), { redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(MANIFEST_FETCH_MS)]) });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => undefined);
      if (!location) throw new Error('manifest_redirect_invalid');
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) throw new Error('manifest_fetch_failed');
    const bytes = await readResponseBody(response, ORIGINALS_MAX_BYTES, signal);
    return { bytes, size: bytes.byteLength };
  }
  throw new Error('manifest_redirect_limit');
}

async function readResponseBody(response: Response, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('manifest_too_large');
  }
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error('manifest_too_large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of chunks) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function validateManifestLine(raw: unknown): { ok: true; entry: ManifestLine } | { ok: false; reason: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, reason: 'manifest_schema' };
  const row = raw as Record<string, unknown>;
  if (typeof row.source_key !== 'string' || row.source_key.trim() === '') return { ok: false, reason: 'manifest_schema' };
  const kindField = `${'doc'}_${'type'}`;
  const hintedKind = row[kindField];
  if (hintedKind !== undefined && hintedKind !== null && typeof hintedKind !== 'string') {
    return { ok: false, reason: 'manifest_schema' };
  }
  const entry: ManifestLine = {
    source_key: row.source_key,
    path: row.path === undefined ? null : (row.path as string | null),
    url: row.url === undefined ? null : (row.url as string | null),
    kindHint: typeof hintedKind === 'string' ? hintedKind : null,
  };
  const hasPath = entry.path !== null && entry.path !== undefined && entry.path.trim() !== '';
  const hasUrl = entry.url !== null && entry.url !== undefined && entry.url.trim() !== '';
  if (hasPath === hasUrl) return { ok: false, reason: 'manifest_location' };
  if (hasUrl) {
    try {
      const u = new URL(entry.url as string);
      if (u.protocol !== 'https:') return { ok: false, reason: 'manifest_https' };
    } catch {
      return { ok: false, reason: 'manifest_https' };
    }
  }
  if (hasPath && (entry.path as string).includes('..')) return { ok: false, reason: 'manifest_path' };
  return { ok: true, entry };
}

async function* listFolder(ref: string, _deps: BackfillSourceDeps, signal: AbortSignal): AsyncGenerator<SourceItem> {
  signal.throwIfAborted();
  const rootRaw = path.resolve(ref);
  const root = await realpath(rootRaw);
  const { readdir, lstat } = await import('node:fs/promises');
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    const names = await readdir(dir);
    for (const name of names) {
      if (name.includes('..')) throw new Error('outside_root');
      const joined = path.join(dir, name);
      const info = await lstat(joined);
      if (info.isDirectory()) {
        stack.push(joined);
        continue;
      }
      if (!info.isFile()) continue;
      let canonical: string;
      try {
        canonical = await realpath(joined);
      } catch {
        console.warn('[Backfill] source refused', { reason: 'unreadable', count: 1 });
        continue;
      }
      if (!canonical.startsWith(`${root}${path.sep}`) && canonical !== root) {
        console.warn('[Backfill] source refused', { reason: 'outside_root', count: 1 });
        continue;
      }
      const rel = path.relative(root, canonical).split(path.sep).join('/');
      yield {
        sourceKey: rel,
        size: info.size,
        ext: extname(rel),
        async open() {
          return createReadStream(canonical);
        },
      };
    }
  }
}

async function* listBucket(ref: string, deps: BackfillSourceDeps, signal: AbortSignal): AsyncGenerator<SourceItem> {
  const storage = deps.storage;
  if (!storage) throw new Error('bucket_storage_unavailable');
  const bucket = ref.trim();
  if (bucket === '') throw new Error('bucket_ref_invalid');
  const api = storage.from(bucket);
  const pending: string[] = [''];
  while (pending.length > 0) {
    signal.throwIfAborted();
    const prefix = pending.pop() as string;
    const { data, error } = await api.list(prefix, { limit: 1000 });
    if (error) throw new Error('bucket_list_failed');
    for (const row of data ?? []) {
      if (!row?.name) continue;
      const full = prefix === '' ? row.name : `${prefix}/${row.name}`;
      if (row.id === null || row.metadata == null) {
        pending.push(full);
        continue;
      }
      const size = Number(row.metadata?.size ?? 0);
      yield {
        sourceKey: full,
        size: Number.isFinite(size) ? size : 0,
        ext: extname(full),
        async open() {
          const { data: blob, error: dlErr } = await api.download(full);
          if (dlErr || !blob) throw new Error('bucket_download_failed');
          const buffer = await blob.arrayBuffer();
          return Readable.from([Buffer.from(buffer)]);
        },
      };
    }
  }
}

async function* listManifest(ref: string, deps: BackfillSourceDeps, signal: AbortSignal): AsyncGenerator<SourceItem> {
  const manifestPath = path.resolve(ref);
  const manifestDir = path.dirname(manifestPath);
  const reject = deps.onManifestReject ?? ((reason: string) => console.warn('[Backfill] manifest line refused', { reason, count: 1 }));
  const stream = createReadStream(manifestPath);
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed) as unknown;
    } catch {
      reject('manifest_json');
      continue;
    }
    const validated = validateManifestLine(raw);
    if (!validated.ok) {
      reject(validated.reason);
      continue;
    }
    const entry = validated.entry;
    if (entry.path) {
      const resolved = path.isAbsolute(entry.path) ? path.resolve(entry.path) : path.resolve(manifestDir, entry.path);
      if (resolved.includes('..')) {
        reject('manifest_path');
        continue;
      }
      let canonical: string;
      let size = 0;
      try {
        canonical = await realpath(resolved);
        const info = await stat(canonical);
        size = info.size;
        const root = await realpath(manifestDir);
        if (!canonical.startsWith(`${root}${path.sep}`) && canonical !== root) {
          reject('outside_root');
          continue;
        }
      } catch {
        reject('manifest_path');
        continue;
      }
      yield {
        sourceKey: entry.source_key,
        size,
        ext: extname(entry.path),
        kindHint: entry.kindHint ?? undefined,
        async open() {
          return createReadStream(canonical);
        },
      };
      continue;
    }
    try {
      const { bytes, size } = await fetchUrlBytes(entry.url as string, deps, signalOrTimeout(signal));
      yield {
        sourceKey: entry.source_key,
        size,
        ext: extname(new URL(entry.url as string).pathname),
        kindHint: entry.kindHint ?? undefined,
        async open() {
          return Readable.from([bytes]);
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'manifest_fetch_failed';
      reject(message.includes('private') ? 'private_url' : message);
    }
  }
}

export async function* listSource(input: ListSourceInput): AsyncGenerator<SourceItem> {
  const signal = signalOrTimeout(input.signal);
  const deps = input.deps ?? {};
  if (input.kind === 'folder') {
    yield* listFolder(input.ref, deps, signal);
    return;
  }
  if (input.kind === 'bucket') {
    yield* listBucket(input.ref, deps, signal);
    return;
  }
  yield* listManifest(input.ref, deps, signal);
}