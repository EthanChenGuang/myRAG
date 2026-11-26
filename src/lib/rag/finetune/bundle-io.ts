import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { z } from 'zod/v3';
import {
  DatasetManifestSchema,
  FinetunePairSchema,
  VectorFileHeaderSchema,
} from '@/lib/rag-eval/contracts.generated';

export type DatasetManifest = z.infer<typeof DatasetManifestSchema>;
export type FinetunePair = z.infer<typeof FinetunePairSchema>;
export type VectorFileHeader = z.infer<typeof VectorFileHeaderSchema>;

export const MANIFEST_FILE = 'manifest.json';
export const VECTORS_DIR = 'vectors';
/** The kept-query files, in the order embed-queries reads them; a file that is not there is skipped. Rows are FinetunePair. */
export const KEPT_QUERY_FILES = ['queries.kept.jsonl', 'queries.test.kept.jsonl', 'pairs.mined.jsonl'] as const;

export type BundleErrorCode =
  | 'bundle_missing'
  | 'manifest_missing'
  | 'manifest_invalid'
  | 'rows_invalid'
  | 'rows_foreign_tenant'
  | 'rows_duplicate_id'
  | 'vector_shape'
  | 'header_invalid'
  | 'sha256_mismatch';

export class BundleError extends Error {
  constructor(
    readonly code: BundleErrorCode,
    readonly detail: string | null = null,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'BundleError';
  }
}

/** Reads and validates <bundle>/manifest.json with the generated DatasetManifest schema; a bundle whose manifest fails is refused. */
export function readBundleManifest(bundleDir: string): DatasetManifest {
  if (!fs.existsSync(bundleDir) || !fs.statSync(bundleDir).isDirectory()) throw new BundleError('bundle_missing');
  const file = path.join(bundleDir, MANIFEST_FILE);
  if (!fs.existsSync(file)) throw new BundleError('manifest_missing');
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new BundleError('manifest_invalid', 'not json');
  }
  const parsed = DatasetManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || '(root)'))].slice(0, 5);
    throw new BundleError('manifest_invalid', fields.join(', '));
  }
  const manifest = parsed.data;
  if (manifest.purpose === 'private' && manifest.tenant_keys.length !== 1) throw new BundleError('manifest_invalid', 'tenant_keys');
  return manifest;
}

export interface KeptQuery {
  tenantKey: string;
  pairId: string;
  text: string;
}

/**
 * Every kept query of the bundle (train and dev, test, mined) in file order. Rows must parse as FinetunePair, belong to a tenant of the
 * manifest and not repeat a pair id. Error details name line numbers and fields only, never row text.
 */
export function readKeptQueries(bundleDir: string, manifest: DatasetManifest): KeptQuery[] {
  const tenants = new Set(manifest.tenant_keys);
  const seen = new Set<string>();
  const out: KeptQuery[] = [];
  for (const name of KEPT_QUERY_FILES) {
    const file = path.join(bundleDir, name);
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (const [index, line] of lines.entries()) {
      if (line.trim() === '') continue;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        throw new BundleError('rows_invalid', `${name}:${index + 1} not json`);
      }
      const parsed = FinetunePairSchema.safeParse(raw);
      if (!parsed.success) throw new BundleError('rows_invalid', `${name}:${index + 1} ${parsed.error.issues[0]?.path.join('.') ?? ''}`.trim());
      const pair = parsed.data;
      if (!tenants.has(pair.tenant_key)) throw new BundleError('rows_foreign_tenant', `${name}:${index + 1}`);
      if (seen.has(pair.pair_id)) throw new BundleError('rows_duplicate_id', `${name}:${index + 1}`);
      seen.add(pair.pair_id);
      out.push({ tenantKey: pair.tenant_key, pairId: pair.pair_id, text: pair.anchor });
    }
  }
  return out;
}

/** A tenant key in a file name: the colon becomes an underscore, so the name stays within the bundle file pattern. */
export function tenantFileKey(tenantKey: string): string {
  return tenantKey.replace(':', '_');
}

/** vectors/<tenant>.<profile> for stored chunk vectors, vectors/query-vectors.<tenant>.<profile> for query vectors. */
export function vectorFileBase(kind: 'chunks' | 'queries', tenantKey: string, profileId: string): string {
  const stem = `${tenantFileKey(tenantKey)}.${profileId}`;
  return path.posix.join(VECTORS_DIR, kind === 'queries' ? `query-vectors.${stem}` : stem);
}

export const vectorFiles = (base: string) => ({ f32: `${base}.f32`, rows: `${base}.rows.jsonl`, header: `${base}.header.json` });

/** Row-major float32 little-endian. */
export function encodeF32(rows: ArrayLike<number>[], dims: number): Buffer {
  const buffer = Buffer.alloc(rows.length * dims * 4);
  rows.forEach((row, r) => {
    if (row.length !== dims) throw new BundleError('vector_shape', `row ${r}`);
    for (let c = 0; c < dims; c += 1) buffer.writeFloatLE(Number(row[c]), (r * dims + c) * 4);
  });
  return buffer;
}

export function decodeF32(buffer: Buffer, dims: number): Float32Array[] {
  if (dims < 1 || buffer.length % (dims * 4) !== 0) throw new BundleError('vector_shape');
  const rows: Float32Array[] = [];
  for (let offset = 0; offset < buffer.length; offset += dims * 4) {
    const row = new Float32Array(dims);
    for (let c = 0; c < dims; c += 1) row[c] = buffer.readFloatLE(offset + c * 4);
    rows.push(row);
  }
  return rows;
}

export const sha256Hex = (data: Buffer | string): string => crypto.createHash('sha256').update(data).digest('hex');

export interface VectorSetMeta {
  tenantKey: string;
  profileId: string;
  model: string;
  dims: number;
}

/**
 * Writes one vector set (f32, rows.jsonl, header.json) to temporary files next to their targets. Nothing is visible under the final
 * names until commit(); abort() removes the temporary files. Files are created with mode 0600.
 */
export class StagedVectorSet {
  private readonly tmpSuffix = `.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  private readonly hash = crypto.createHash('sha256');
  private readonly f32Fd: number;
  private readonly rowsFd: number;
  private count = 0;
  private header: VectorFileHeader | null = null;
  readonly files: { f32: string; rows: string; header: string };

  constructor(
    private readonly bundleDir: string,
    readonly base: string,
    readonly meta: VectorSetMeta,
  ) {
    this.files = vectorFiles(base);
    fs.mkdirSync(path.join(bundleDir, path.dirname(base)), { recursive: true, mode: 0o700 });
    this.f32Fd = fs.openSync(this.tmp('f32'), 'w', 0o600);
    this.rowsFd = fs.openSync(this.tmp('rows'), 'w', 0o600);
  }

  private tmp(kind: 'f32' | 'rows' | 'header'): string {
    return path.join(this.bundleDir, this.files[kind] + this.tmpSuffix);
  }

  get rows(): number {
    return this.count;
  }

  append(vector: ArrayLike<number>, row: Record<string, unknown>): void {
    if (this.header) throw new Error('vector set already finished');
    if (vector.length !== this.meta.dims) throw new BundleError('vector_shape', `row ${this.count}`);
    const bytes = encodeF32([vector], this.meta.dims);
    this.hash.update(bytes);
    fs.writeSync(this.f32Fd, bytes);
    fs.writeSync(this.rowsFd, `${JSON.stringify(row)}\n`);
    this.count += 1;
  }

  /** Closes the data files and writes the header to its temporary file. */
  finish(): VectorFileHeader {
    if (this.header) return this.header;
    fs.closeSync(this.f32Fd);
    fs.closeSync(this.rowsFd);
    const header = VectorFileHeaderSchema.parse({
      tenant_key: this.meta.tenantKey,
      profile_id: this.meta.profileId,
      model: this.meta.model,
      dims: this.meta.dims,
      rows: this.count,
      dtype: 'float32-le',
      sha256: this.hash.digest('hex'),
    });
    fs.writeFileSync(this.tmp('header'), `${JSON.stringify(header, null, 2)}\n`, { mode: 0o600 });
    this.header = header;
    return header;
  }

  /** Moves the three files to their final names, header last. */
  commit(): void {
    if (!this.header) this.finish();
    fs.renameSync(this.tmp('f32'), path.join(this.bundleDir, this.files.f32));
    fs.renameSync(this.tmp('rows'), path.join(this.bundleDir, this.files.rows));
    fs.renameSync(this.tmp('header'), path.join(this.bundleDir, this.files.header));
  }

  abort(): void {
    for (const fd of [this.f32Fd, this.rowsFd]) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
    for (const kind of ['f32', 'rows', 'header'] as const) fs.rmSync(this.tmp(kind), { force: true });
  }
}

/** Commits every staged set, or aborts them all when any step before commit failed. */
export async function withStagedSets<T>(body: (stage: (base: string, meta: VectorSetMeta) => StagedVectorSet) => Promise<T>, bundleDir: string): Promise<T> {
  const sets: StagedVectorSet[] = [];
  try {
    const result = await body((base, meta) => {
      const set = new StagedVectorSet(bundleDir, base, meta);
      sets.push(set);
      return set;
    });
    for (const set of sets) set.finish();
    for (const set of sets) set.commit();
    return result;
  } catch (error) {
    for (const set of sets) set.abort();
    throw error;
  }
}

/** Reads a committed vector set and checks the header schema, the sha256 and the row count. */
export function readVectorSet(bundleDir: string, base: string): { header: VectorFileHeader; vectors: Float32Array[] } {
  const files = vectorFiles(base);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(bundleDir, files.header), 'utf8'));
  } catch {
    throw new BundleError('header_invalid');
  }
  const parsed = VectorFileHeaderSchema.safeParse(raw);
  if (!parsed.success) throw new BundleError('header_invalid');
  const header = parsed.data;
  const data = fs.readFileSync(path.join(bundleDir, files.f32));
  if (sha256Hex(data) !== header.sha256) throw new BundleError('sha256_mismatch');
  const vectors = decodeF32(data, header.dims);
  if (vectors.length !== header.rows) throw new BundleError('vector_shape', 'row count');
  return { header, vectors };
}
