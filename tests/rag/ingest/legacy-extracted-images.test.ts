import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// 06.3-SECURITY W5: the legacy process-document route uploaded LlamaCloud page images to the public
// chat-attachments/extracted-images/ folder under a timestamp name. No document, chunk or client referenced them, so a
// purge could never find or remove them. The route must not write such unreferenced copies.

const ROUTE = path.join(process.cwd(), 'src/app/api/process-document/route.ts');

describe('legacy process-document extracted images (06.3-SECURITY W5)', () => {
  const source = fs.readFileSync(ROUTE, 'utf8');

  it('uploads nothing to the extracted-images folder', () => {
    expect(source).not.toMatch(/extracted-images\//);
    expect(source).not.toMatch(/uploadExtractedImage\s*\(/);
  });

  it('returns no extracted image URLs for a stored document', () => {
    expect(source).not.toMatch(/extractedImages:\s*processedImages/);
  });
});
