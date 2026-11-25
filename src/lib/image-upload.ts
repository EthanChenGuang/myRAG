export type ImageKind = 'png' | 'jpeg' | 'webp' | 'ico';

export const ALLOWED_IMAGE_EXTENSIONS: readonly string[] = ['png', 'jpg', 'jpeg', 'webp', 'ico'];
export const MAX_IMAGE_UPLOAD_BYTES = 5 * 1024 * 1024;

const STORED_EXTENSION: Record<ImageKind, string> = { png: 'png', jpeg: 'jpg', webp: 'webp', ico: 'ico' };
const EXTENSION_KIND: Record<string, ImageKind> = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg', webp: 'webp', ico: 'ico' };

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  return bytes.length >= offset + signature.length && signature.every((value, index) => bytes[offset + index] === value);
}

export function sniffImageKind(bytes: Uint8Array): ImageKind | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return 'webp';
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00])) return 'ico';
  return null;
}

export type ImageValidation = { ok: true; extension: string } | { ok: false; error: string };

/** Accepts only raster images whose name, size and leading bytes agree. SVG and HTML are never accepted. */
export function validateImageUpload(fileName: string, bytes: Uint8Array): ImageValidation {
  const claimed = fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : '';
  if (!ALLOWED_IMAGE_EXTENSIONS.includes(claimed)) {
    return { ok: false, error: 'Only PNG, JPG, WEBP and ICO files are allowed' };
  }
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_UPLOAD_BYTES) {
    return { ok: false, error: 'Image must be between 1 byte and 5 MB' };
  }
  const kind = sniffImageKind(bytes);
  if (!kind || EXTENSION_KIND[claimed] !== kind) {
    return { ok: false, error: 'File content does not match an allowed image type' };
  }
  return { ok: true, extension: STORED_EXTENSION[kind] };
}
