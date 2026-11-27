/**
 * The HTTP status of a vendor error: the client's ApiError carries `status`; its UnexpectedResponse error only says
 * "Unexpected Response: <status>". Null when the error has neither (network failure, timeout).
 */
export function qdrantErrorStatus(error: unknown): number | null {
  if (typeof error === 'object' && error !== null) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) return status;
  }
  const message = error instanceof Error ? error.message : '';
  const match = /Unexpected Response: (\d{3})/.exec(message);
  return match ? Number(match[1]) : null;
}
