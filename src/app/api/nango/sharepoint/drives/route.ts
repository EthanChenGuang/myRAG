import { NextRequest } from 'next/server';
import { isSharePointEnabled } from '@/lib/nango/sharepoint/config';
import { handlePickerRequest, pickerNotFound } from '../_lib/picker-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/nango/sharepoint/drives (Phase 6.3, D-22, D-24): one picker level of the session user's own connection. */
export async function GET(request: NextRequest) {
    if (!isSharePointEnabled()) return pickerNotFound();
    return handlePickerRequest(request, 'drives');
}
