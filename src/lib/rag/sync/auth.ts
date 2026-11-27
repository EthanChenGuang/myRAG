export type VectorSyncAccessResult = { ok: true } | { ok: false; status: 401 | 503; error: string };

export function checkVectorSyncAccess(_headers: Headers, _secret: string | undefined): VectorSyncAccessResult {
  return { ok: true };
}
