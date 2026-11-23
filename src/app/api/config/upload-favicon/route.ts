import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { writeFile } from 'fs/promises';
import { updateEnvFile } from '@/lib/env-utils';
import { requireAdminOrDeny } from '@/lib/admin-route-auth';
import { MAX_IMAGE_UPLOAD_BYTES, validateImageUpload } from '@/lib/image-upload';

// This route is used by the config UI to upload favicon files
export async function POST(request: NextRequest) {
  const denied = await requireAdminOrDeny(request);
  if (denied) return denied;

  try {
    const formData = await request.formData();
    const faviconFile = formData.get('favicon') as File;
    
    if (!faviconFile) {
      return NextResponse.json(
        { success: false, error: 'Missing favicon file' },
        { status: 400 }
      );
    }
    
    if (faviconFile.size > MAX_IMAGE_UPLOAD_BYTES) {
      return NextResponse.json(
        { success: false, error: 'Image must be between 1 byte and 5 MB' },
        { status: 400 }
      );
    }

    const fileBuffer = Buffer.from(await faviconFile.arrayBuffer());
    const validation = validateImageUpload(faviconFile.name, fileBuffer);
    if (!validation.ok) {
      return NextResponse.json(
        { success: false, error: validation.error },
        { status: 400 }
      );
    }

    // Fixed server-chosen name; the extension comes from the validated content
    const fileName = `favicon.${validation.extension}`;
    const publicDir = path.join(process.cwd(), 'public');
    await fs.mkdir(publicDir, { recursive: true });
    await writeFile(path.join(publicDir, fileName), fileBuffer);
    
    // Create the public URL for the file
    const publicPath = `/${fileName}`;
    
    // Update the environment variable
    try {
      await updateEnvFile('NEXT_PUBLIC_FAVICON_URL', publicPath);
    } catch (error) {
      console.error('Error updating env file:', error);
      // Continue anyway, as the UI will still save the value through its normal mechanism
    }
    
    return NextResponse.json({
      success: true,
      url: publicPath,
      message: 'Favicon uploaded successfully'
    });
    
  } catch (error) {
    console.error('Error uploading favicon file:', error);
    return NextResponse.json(
      { success: false, error: 'Error uploading favicon file' },
      { status: 500 }
    );
  }
}