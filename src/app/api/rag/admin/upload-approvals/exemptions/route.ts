export const runtime = 'nodejs';

const notImplemented = async (_request: Request): Promise<Response> => new Response(null, { status: 501 });

export const GET = notImplemented;
export const POST = notImplemented;
export const DELETE = notImplemented;
