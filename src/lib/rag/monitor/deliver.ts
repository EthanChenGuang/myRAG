import type { MonitorAlert } from '@/lib/rag-eval/contracts.generated';

export const WEBHOOK_SIGNATURE_HEADER = 'x-myrag-signature';
export const WEBHOOK_TIMESTAMP_HEADER = 'x-myrag-timestamp';
export const MAX_DELIVERY_ATTEMPTS = 5;

export interface DeliveryReport {
  alertId: string;
  banner: { status: 'delivered'; at: string };
  delivered: NonNullable<MonitorAlert['delivered']>;
}

export async function deliverAlerts(alerts: readonly MonitorAlert[], _deps: Record<string, unknown> = {}): Promise<DeliveryReport[]> {
  return alerts.map((alert) => ({ alertId: alert.id, banner: { status: 'delivered', at: '' }, delivered: {} }));
}

export function signWebhookBody(_secret: string, _timestamp: string, _body: string): string {
  return '';
}

export function fromAlertRow(_row: Record<string, unknown>): MonitorAlert | null {
  return null;
}
