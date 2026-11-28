export type SourceAlertKind = 'paused' | 'overdue' | 'failed' | 'incomplete';

export async function raiseSourceAlert(_connection: unknown, _kind: SourceAlertKind, _counts: Record<string, number>, _options: { admin?: unknown } = {}): Promise<'connection_status'> {
    return 'connection_status';
}
