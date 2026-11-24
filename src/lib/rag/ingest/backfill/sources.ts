import { BlockList, isIP } from 'node:net';
import { createReadStream } from 'node:fs';
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { lookup as dnsLookup } from 'node:dns/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { Readable } from 'node:stream';
import { BackfillManifestEntrySchema, type BackfillManifestEntry } from '@/lib/rag-eval/contracts.generated';
import { isTenantScope, scopeKey, type TenantScope } from '@/lib/rag/tenant/scope';
import { ORIGINALS_BUCKET, ORIGINALS_MAX_BYTES } from '../object-store';

export type SourceKind = 'folder' | 'bucket' | 'manifest';

export interface SourceItem {
  sourceKey: string;
  size: number;
  ext: string;
  docType?: BackfillManifestEntry['doc_type'];
  open(signal?: AbortSignal): Promise<NodeJS.ReadableStream>;
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

export interface ResolvedAddress {
  address: string;
  family: number;
}

export interface BackfillSourceDeps {
  fetch?: typeof fetch;
  /** Resolves every address the host maps to; the default is getaddrinfo, the same lookup a connection uses. */
  lookupHost?: (host: string, signal: AbortSignal) => Promise<ResolvedAddress[]>;
  /** Called with a reason code (never a name or a path) for every refused entry. */
  onReject?: (reason: string) => void;
  storage?: { from: (bucket: string) => BackfillStorageBucket };
}

export interface ListSourceInput {
  kind: SourceKind;
  ref: string;
  signal?: AbortSignal;
  deps?: BackfillSourceDeps;
  /** Bucket sources only: the exact bucket names the operator allows. Absent or empty refuses every bucket. */
  allowedBuckets?: readonly string[];
  /** Bucket sources only: the scope from backfillScope. A user or organization scope confines listing to that tenant's prefix. */
  scope?: TenantScope;
}

export class SourceRejection extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`[Backfill] source refused: ${reason}`);
    this.name = 'SourceRejection';
    this.reason = reason;
  }
}

const FETCH_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
const BUCKET_PAGE = 1_000;
const BUCKET_NAME_RE = /^[a-z0-9][a-z0-9._-]{1,62}$/;
/** Every bucket the application itself writes to; each holds files of all tenants, so none can be a backfill source. */
const APP_BUCKETS = new Set([ORIGINALS_BUCKET, 'chat-images', 'chat-attachments', 'chat-videos', '3d-models', 'backgrounds']);

const BLOCKED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];
const BLOCKED_V6: Array<[string, number]> = [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
];

const blockList = new BlockList();
for (const [net, prefix] of BLOCKED_V4) blockList.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of BLOCKED_V6) blockList.addSubnet(net, prefix, 'ipv6');

/** True for loopback, private, link-local, carrier-grade NAT, multicast, reserved and any unparsable address (fails closed). */
export function isBlockedAddress(raw: string): boolean {
  let address = raw.trim().toLowerCase();
  const zone = address.indexOf('%');
  if (zone >= 0) address = address.slice(0, zone);
  const family = isIP(address);
  if (family === 0) return true;
  if (family === 4) return blockList.check(address, 'ipv4');
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (dotted) return isBlockedAddress(dotted[1] as string);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
  if (hex) {
    const hi = Number.parseInt(hex[1] as string, 16);
    const lo = Number.parseInt(hex[2] as string, 16);
    return isBlockedAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return blockList.check(address, 'ipv6');
}

async function defaultLookup(host: string, signal: AbortSignal): Promise<ResolvedAddress[]> {
  signal.throwIfAborted();
  const records = await dnsLookup(host, { all: true, verbatim: true });
  signal.throwIfAborted();
  return records;
}

async function assertPublicUrl(url: URL, lookupHost: NonNullable<BackfillSourceDeps['lookupHost']>, signal: AbortSignal): Promise<void> {
  if (url.protocol !== 'https:') throw new SourceRejection('manifest_https');
  if (url.username !== '' || url.password !== '') throw new SourceRejection('manifest_https');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === '' || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new SourceRejection('private_url');
  }
  if (isIP(host) !== 0) {
    if (isBlockedAddress(host)) throw new SourceRejection('private_url');
    return;
  }
  let records: ResolvedAddress[];
  try {
    records = await lookupHost(host, signal);
  } catch {
    throw new SourceRejection('manifest_dns');
  }
  if (records.length === 0) throw new SourceRejection('manifest_dns');
  for (const record of records) {
    if (isBlockedAddress(record.address)) throw new SourceRejection('private_url');
  }
}

async function readResponseBody(response: Response, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new SourceRejection('too_large');
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
      if (total > maxBytes) throw new SourceRejection('too_large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks, total);
}

/** Fetches one https URL: every hop (the first and each redirect) is checked against private ranges before a request is made. */
async function fetchUrlBytes(url: string, deps: BackfillSourceDeps, signal: AbortSignal): Promise<Uint8Array> {
  const lookupHost = deps.lookupHost ?? defaultLookup;
  const fetchFn = deps.fetch ?? fetch;
  let current: URL;
  try {
    current = new URL(url);
  } catch {
    throw new SourceRejection('manifest_https');
  }
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertPublicUrl(current, lookupHost, signal);
    const hopSignal = AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]);
    const response = await fetchFn(current.toString(), { redirect: 'manual', signal: hopSignal });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => undefined);
      if (!location) throw new SourceRejection('manifest_redirect');
      try {
        current = new URL(location, current);
      } catch {
        throw new SourceRejection('manifest_redirect');
      }
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new SourceRejection('manifest_fetch_failed');
    }
    return readResponseBody(response, ORIGINALS_MAX_BYTES, hopSignal);
  }
  throw new SourceRejection('manifest_redirect');
}

function extname(name: string): string {
  const base = path.basename(name);
  const dot = base.lastIndexOf('.');
  if (dot < 1) return 'bin';
  const ext = base.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : 'bin';
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
}

function makeReject(deps: BackfillSourceDeps): (reason: string) => void {
  const counts = new Map<string, number>();
  return (reason) => {
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
    console.warn('[Backfill] source refused', { reason, count: counts.get(reason) });
    deps.onReject?.(reason);
  };
}

async function* listFolder(ref: string, deps: BackfillSourceDeps, signal: AbortSignal): AsyncGenerator<SourceItem> {
  const reject = makeReject(deps);
  const root = await realpath(path.resolve(ref));
  const pending: string[] = [root];
  while (pending.length > 0) {
    signal.throwIfAborted();
    const dir = pending.pop() as string;
    const names = (await readdir(dir)).sort();
    const subdirs: string[] = [];
    for (const name of names) {
      const joined = path.join(dir, name);
      const link = await lstat(joined);
      if (link.isDirectory()) {
        subdirs.push(joined);
        continue;
      }
      if (!link.isFile() && !link.isSymbolicLink()) continue;
      let canonical: string;
      try {
        canonical = await realpath(joined);
      } catch {
        reject('path_unreadable');
        continue;
      }
      if (!inside(root, canonical)) {
        reject('outside_root');
        continue;
      }
      const info = await stat(canonical);
      if (!info.isFile()) continue;
      if (info.size > ORIGINALS_MAX_BYTES) {
        reject('too_large');
        continue;
      }
      const rel = path.relative(root, joined).split(path.sep).join('/');
      yield {
        sourceKey: rel,
        size: info.size,
        ext: extname(rel),
        async open() {
          const again = await realpath(joined);
          if (!inside(root, again)) throw new SourceRejection('outside_root');
          return createReadStream(again);
        },
      };
    }
    for (const sub of subdirs.reverse()) pending.push(sub);
  }
}

/** The object-key prefix a tenant's files must live under in an operator bucket; single-tenant has one tenant and no prefix. */
function tenantPrefix(scope: TenantScope): string {
  scopeKey(scope);
  if (scope.kind === 'single') return '';
  if (scope.kind === 'org') return `o/${scope.organizationId as string}`;
  return `u/${scope.userId as string}`;
}

function validBucketEntryName(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\');
}

async function* listBucket(
  ref: string,
  allowedBuckets: readonly string[] | undefined,
  scope: TenantScope | undefined,
  deps: BackfillSourceDeps,
  signal: AbortSignal,
): AsyncGenerator<SourceItem> {
  const reject = makeReject(deps);
  const bucket = ref.trim();
  if (!BUCKET_NAME_RE.test(bucket)) throw new SourceRejection('bucket_ref_invalid');
  if (APP_BUCKETS.has(bucket)) throw new SourceRejection('bucket_internal');
  if (!Array.isArray(allowedBuckets) || !allowedBuckets.includes(bucket)) throw new SourceRejection('bucket_not_allowed');
  if (!isTenantScope(scope)) throw new SourceRejection('bucket_scope_required');
  if (!deps.storage) throw new SourceRejection('bucket_storage_unavailable');
  const base = tenantPrefix(scope);
  const api = deps.storage.from(bucket);
  const visited = new Set<string>();
  const pending: string[] = [base];
  while (pending.length > 0) {
    const prefix = pending.pop() as string;
    if (visited.has(prefix)) continue;
    visited.add(prefix);
    for (let offset = 0; ; offset += BUCKET_PAGE) {
      signal.throwIfAborted();
      const { data, error } = await api.list(prefix, { limit: BUCKET_PAGE, offset });
      if (error) throw new SourceRejection('bucket_list_failed');
      const rows = data ?? [];
      for (const row of rows) {
        if (!row?.name) continue;
        if (!validBucketEntryName(row.name)) {
          reject('outside_prefix');
          continue;
        }
        const full = prefix === '' ? row.name : `${prefix}/${row.name}`;
        if (base !== '' && !full.startsWith(`${base}/`)) {
          reject('outside_prefix');
          continue;
        }
        if (row.id === null || row.id === undefined) {
          pending.push(full);
          continue;
        }
        const size = Number(row.metadata?.size ?? 0);
        if (Number.isFinite(size) && size > ORIGINALS_MAX_BYTES) {
          reject('too_large');
          continue;
        }
        yield {
          sourceKey: full,
          size: Number.isFinite(size) ? size : 0,
          ext: extname(full),
          async open() {
            const { data: blob, error: downloadError } = await api.download(full);
            if (downloadError || !blob) throw new SourceRejection('bucket_download_failed');
            return Readable.from([Buffer.from(await blob.arrayBuffer())]);
          },
        };
      }
      if (rows.length < BUCKET_PAGE) break;
    }
  }
}

function parseManifestLine(line: string): { ok: true; entry: BackfillManifestEntry } | { ok: false; reason: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { ok: false, reason: 'manifest_json' };
  }
  const parsed = BackfillManifestEntrySchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'manifest_schema' };
  const entry = parsed.data;
  const hasPath = entry.path !== null && entry.path.trim() !== '';
  const hasUrl = entry.url !== null && entry.url.trim() !== '';
  if (hasPath === hasUrl) return { ok: false, reason: 'manifest_location' };
  if (hasUrl) {
    try {
      if (new URL(entry.url as string).protocol !== 'https:') return { ok: false, reason: 'manifest_https' };
    } catch {
      return { ok: false, reason: 'manifest_https' };
    }
  }
  return { ok: true, entry };
}

async function* listManifest(ref: string, deps: BackfillSourceDeps, signal: AbortSignal): AsyncGenerator<SourceItem> {
  const reject = makeReject(deps);
  const manifestPath = await realpath(path.resolve(ref));
  const manifestDir = path.dirname(manifestPath);
  const root = await realpath(manifestDir);
  const stream = createReadStream(manifestPath);
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const seenKeys = new Set<string>();
  try {
    for await (const line of lines) {
      signal.throwIfAborted();
      const trimmed = line.trim();
      if (trimmed === '') continue;
      const parsed = parseManifestLine(trimmed);
      if (!parsed.ok) {
        reject(parsed.reason);
        continue;
      }
      const { entry } = parsed;
      if (seenKeys.has(entry.source_key)) {
        reject('manifest_duplicate_key');
        continue;
      }
      seenKeys.add(entry.source_key);
      const docType = entry.doc_type ?? undefined;

      if (entry.path !== null && entry.path.trim() !== '') {
        if (entry.path.split(/[\\/]+/).includes('..')) {
          reject('outside_root');
          continue;
        }
        const resolved = path.isAbsolute(entry.path) ? path.resolve(entry.path) : path.resolve(manifestDir, entry.path);
        let canonical: string;
        let size: number;
        try {
          canonical = await realpath(resolved);
          const info = await stat(canonical);
          if (!info.isFile()) {
            reject('path_unreadable');
            continue;
          }
          size = info.size;
        } catch {
          reject('path_unreadable');
          continue;
        }
        if (!inside(root, canonical)) {
          reject('outside_root');
          continue;
        }
        if (size > ORIGINALS_MAX_BYTES) {
          reject('too_large');
          continue;
        }
        yield {
          sourceKey: entry.source_key,
          size,
          ext: extname(entry.path),
          docType,
          async open() {
            const again = await realpath(resolved);
            if (!inside(root, again)) throw new SourceRejection('outside_root');
            return createReadStream(again);
          },
        };
        continue;
      }

      const url = entry.url as string;
      let bytes: Uint8Array;
      try {
        bytes = await fetchUrlBytes(url, deps, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        reject(error instanceof SourceRejection ? error.reason : 'manifest_fetch_failed');
        continue;
      }
      yield {
        sourceKey: entry.source_key,
        size: bytes.byteLength,
        ext: extname(new URL(url).pathname),
        docType,
        async open() {
          return Readable.from([Buffer.from(bytes)]);
        },
      };
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

/**
 * Lists the files of one source in a stable order. Refused entries (outside the root, private URL, oversize, ...) are
 * skipped and reported by reason code only; nothing about a file's name or content is logged.
 */
export async function* listSource(input: ListSourceInput): AsyncGenerator<SourceItem> {
  const signal = input.signal ?? new AbortController().signal;
  const deps = input.deps ?? {};
  if (input.kind === 'folder') yield* listFolder(input.ref, deps, signal);
  else if (input.kind === 'bucket') yield* listBucket(input.ref, input.allowedBuckets, input.scope, deps, signal);
  else yield* listManifest(input.ref, deps, signal);
}
