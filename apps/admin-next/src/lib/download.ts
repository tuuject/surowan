/**
 * Triggers a client-side download of text the API or a viewer already produced.
 * The MIME type only labels the bytes the browser receives; callers that save
 * structured data pass `application/json`.
 */
export function downloadTextFile(filename: string, text: string, mimeType = 'text/plain;charset=utf-8'): void {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoked on the next task so the click has already been dispatched.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
