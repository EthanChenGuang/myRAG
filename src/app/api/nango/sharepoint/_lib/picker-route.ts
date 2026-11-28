import { NextRequest, NextResponse } from 'next/server';

export type PickerKind = 'sites' | 'drives' | 'folders';

export async function handlePickerRequest(_request: NextRequest, _kind: PickerKind): Promise<NextResponse> {
    return NextResponse.json({ error: 'not implemented' }, { status: 501 });
}

export function pickerNotFound(): NextResponse {
    return NextResponse.json({ error: 'Not found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
}
