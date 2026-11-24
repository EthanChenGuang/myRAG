import { assertObjectKey, getObjectStore, type StoredObject } from './object-store';

/** Parse output of every parser: the Markdown a run chunks from. */
export const PARSE_ARTIFACT = 'parse.md';
/** The Docling JSON next to the Markdown when Docling ran; the Docling plan fills it. */
export const DOCLING_ARTIFACT = 'docling.json';

const TENANT_KEY = /^[a-z]:[a-z0-9-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EXTENSION = /^[a-z0-9]{1,8}$/;
const ARTIFACT_NAME = /^[a-z0-9]{1,16}\.[a-z0-9]{1,8}$/;
const CONTENT_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const MAX_VERSION = 1_000_000_000;

/** What an artifact needs from a run: the tenant key, the version's lineage and number, the abort signal and the state that records keys. */
export interface ArtifactContext {
  identity: { tenantKey: string } | null;
  document: { lineageId: string; version: number } | null;
  signal: AbortSignal;
  state: { artifacts: Record<string, string> };
}

/** `<tenant_key>/<lineage_id>/<version>/`: built from the tenant key, two UUID-shaped values and an integer, never from a filename. */
export function versionPrefix(tenantKey: string, lineageId: string, version: number): string {
  const lineage = lineageId.toLowerCase();
  if (!TENANT_KEY.test(tenantKey)) throw new Error('[Ingest] artifact prefix: tenant key is not valid');
  if (!UUID.test(lineage)) throw new Error('[Ingest] artifact prefix: lineage id is not valid');
  if (!Number.isInteger(version) || version < 1 || version > MAX_VERSION) throw new Error('[Ingest] artifact prefix: version is not valid');
  return `${tenantKey}/${lineage}/${version}/`;
}

/** `original.<ext>`: the extension of the filename when it is 1 to 8 ASCII letters or digits, `bin` otherwise. The filename itself never enters a key. */
export function originalName(filename: string): string {
  const dot = filename.lastIndexOf('.');
  const extension = dot < 0 ? '' : filename.slice(dot + 1).toLowerCase();
  return `original.${EXTENSION.test(extension) ? extension : 'bin'}`;
}

export function originalKey(prefix: string, filename: string): string {
  return `${prefix}${originalName(filename)}`;
}

/** The media type to store with an object: the type and subtype of what the caller sent, or application/octet-stream. */
export function safeContentType(value: string | null | undefined): string {
  const type = (value ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  return CONTENT_TYPE.test(type) ? type : 'application/octet-stream';
}

/** True for a fixed ASCII basename such as original.pdf or parse.md. */
export function isArtifactName(name: string): boolean {
  return ARTIFACT_NAME.test(name);
}

function artifactKey(ctx: ArtifactContext, name: string): string {
  if (!isArtifactName(name)) throw new Error('[Ingest] artifact name is not a fixed ASCII basename');
  if (!ctx.identity || !ctx.document) throw new Error('[Ingest] artifact needs the tenant key and the document version');
  const key = `${versionPrefix(ctx.identity.tenantKey, ctx.document.lineageId, ctx.document.version)}${name}`;
  assertObjectKey(key);
  return key;
}

/** Stores one artifact of the run's version, replacing an earlier copy, and records its key in the state. Returns the key. */
export async function saveArtifact(ctx: ArtifactContext, name: string, bytes: Uint8Array, contentType: string): Promise<string> {
  const key = artifactKey(ctx, name);
  await getObjectStore().put(key, bytes, { contentType: safeContentType(contentType), signal: ctx.signal });
  ctx.state.artifacts[name] = key;
  return key;
}

/** One artifact of the run's version, or null when it was never stored. */
export async function loadArtifact(ctx: ArtifactContext, name: string): Promise<StoredObject | null> {
  return getObjectStore().get(artifactKey(ctx, name), { signal: ctx.signal });
}

/** Removes every artifact the state records for this version. Best effort: a failure is logged without keys and never ends the run. */
export async function removeArtifacts(ctx: ArtifactContext): Promise<void> {
  if (!ctx.identity || !ctx.document) return;
  const prefix = versionPrefix(ctx.identity.tenantKey, ctx.document.lineageId, ctx.document.version);
  for (const [name, key] of Object.entries(ctx.state.artifacts)) {
    if (!key.startsWith(prefix)) continue;
    try {
      await getObjectStore().remove(key, { signal: ctx.signal });
      delete ctx.state.artifacts[name];
    } catch (error) {
      console.error('[Ingest] could not remove a stored artifact', { error: error instanceof Error ? error.name : 'unknown' });
    }
  }
}
