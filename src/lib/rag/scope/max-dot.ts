/**
 * D-26: the scope gate's only arithmetic, the largest dot product between any query vector and any reference vector. A JavaScript
 * loop over 8 × 300 vectors at 2048 dimensions takes 4 to 11 ms on a small host, above the 5 ms budget, so the kernel runs as a
 * 128-bit SIMD WebAssembly function (about 1 ms) with the plain loop as the fallback where WebAssembly SIMD is unavailable.
 *
 * The module is one exported function and its memory, assembled from this text format:
 *
 *   (func (export "maxdot") (param $q i32) (param $nq i32) (param $r i32) (param $nr i32) (param $bytes i32) (result f32)
 *     best = -inf
 *     for each query (stride $bytes from $q):
 *       for each reference (stride $bytes from $r):
 *         acc = f32x4(0); for i in 0..$bytes step 16: acc += v128.load(query + i) * v128.load(ref + i)
 *         best = f32.max(best, acc[0] + acc[1] + acc[2] + acc[3])
 *     return best)
 *
 * Vectors are copied into the module memory padded with zeros to a multiple of four floats, which leaves every dot product unchanged.
 */
const MAX_DOT_WASM =
  'AGFzbQEAAAABCgFgBX9/f39/AX0DAgEABQMBAAEHEwIGbWVtb3J5AgAGbWF4ZG90AAAKwgEBvwEEAX0DfwF7AX9DAACA/yEFQQAhBgJAA0AgBiABTw0BQQAhByACIQoCQANAIAcgA08NAf0MAAAAAAAAAAAAAAAAAAAAACEJQQAhCAJAA0AgCCAETw0BIAkgACAIav0AAgAgCiAIav0AAgD95gH95AEhCSAIQRBqIQgMAAsLIAUgCf0fACAJ/R8BkiAJ/R8CkiAJ/R8DkpchBSAKIARqIQogB0EBaiEHDAALCyAAIARqIQAgBkEBaiEGDAALCyAFCw==';

const PAGE_BYTES = 65_536;

interface Kernel {
  memory: WebAssembly.Memory;
  maxdot: (q: number, nq: number, r: number, nr: number, bytes: number) => number;
}

let kernel: Kernel | null | undefined;
let resident: { refs: readonly Float32Array[]; stride: number } | null = null;

function copyPadded(view: Float32Array, vectors: readonly Float32Array[], start: number, dims: number, stride: number): void {
  let offset = start;
  for (const vector of vectors) {
    view.set(vector, offset);
    if (stride !== dims) view.fill(0, offset + dims, offset + stride);
    offset += stride;
  }
}

function loadKernel(): Kernel | null {
  if (kernel !== undefined) return kernel;
  try {
    const bytes = Uint8Array.from(atob(MAX_DOT_WASM), (char) => char.charCodeAt(0));
    const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});
    const exports = instance.exports as unknown as Kernel;
    kernel = typeof exports.maxdot === 'function' && exports.memory instanceof WebAssembly.Memory ? exports : null;
  } catch {
    kernel = null;
  }
  return kernel;
}

/** The plain loop: the fallback and the reference the kernel is tested against. */
export function maxDotJs(queries: readonly Float32Array[], refs: readonly Float32Array[]): number {
  let best = Number.NEGATIVE_INFINITY;
  for (const query of queries) {
    const n = query.length;
    for (const ref of refs) {
      if (ref.length !== n) continue;
      let s0 = 0;
      let s1 = 0;
      let s2 = 0;
      let s3 = 0;
      let i = 0;
      for (; i + 3 < n; i += 4) {
        s0 += query[i]! * ref[i]!;
        s1 += query[i + 1]! * ref[i + 1]!;
        s2 += query[i + 2]! * ref[i + 2]!;
        s3 += query[i + 3]! * ref[i + 3]!;
      }
      for (; i < n; i += 1) s0 += query[i]! * ref[i]!;
      const dot = s0 + s1 + s2 + s3;
      if (dot > best) best = dot;
    }
  }
  return best;
}

/**
 * The largest dot product over every (query, reference) pair; -Infinity when either list is empty. Every vector must have the same
 * length. Synchronous. The last reference list stays in the module memory and is not copied again when the same array is passed,
 * so a reference list must not be mutated after it was scored (snapshot vectors are immutable).
 */
export function maxDot(queries: readonly Float32Array[], refs: readonly Float32Array[]): number {
  if (queries.length === 0 || refs.length === 0) return Number.NEGATIVE_INFINITY;
  const dims = queries[0]!.length;
  if (dims === 0 || queries.some((q) => q.length !== dims) || refs.some((r) => r.length !== dims)) return maxDotJs(queries, refs);
  const active = loadKernel();
  if (!active) return maxDotJs(queries, refs);
  try {
    const stride = Math.ceil(dims / 4) * 4;
    const refFloats = refs.length * stride;
    const needed = (refFloats + queries.length * stride) * 4;
    const have = active.memory.buffer.byteLength;
    if (needed > have) {
      active.memory.grow(Math.ceil((needed - have) / PAGE_BYTES));
      resident = null;
    }
    const view = new Float32Array(active.memory.buffer, 0, refFloats + queries.length * stride);
    // The references sit first and stay resident while the same list is scored again (one snapshot's centroids per request).
    if (resident?.refs !== refs || resident.stride !== stride) {
      copyPadded(view, refs, 0, dims, stride);
      resident = { refs, stride };
    }
    copyPadded(view, queries, refFloats, dims, stride);
    return active.maxdot(refFloats * 4, queries.length, 0, refs.length, stride * 4);
  } catch {
    return maxDotJs(queries, refs);
  }
}
