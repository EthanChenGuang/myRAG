/**
 * Format an error message as an AI SDK v5 UI-message-stream SSE payload.
 *
 * The chat client (src/app/page.tsx) consumes the v5 SSE protocol: it splits on
 * `\n\n`, reads `data:` lines, JSON-parses them, and switches on `event.type`.
 * Emitting the legacy v4 wire format (`3:"msg"`) here produced an unparseable
 * payload that surfaced as an empty `{}` error event in the browser.
 *
 * This returns a proper `error` event carrying the message, terminated by the
 * `[DONE]` sentinel the client uses to close the stream.
 */
export function formatErrorSSE(message: string): string {
  const errorPart = JSON.stringify({ type: 'error', errorText: message });
  return `data: ${errorPart}\n\ndata: [DONE]\n\n`;
}
