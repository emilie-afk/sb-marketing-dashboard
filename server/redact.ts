// Scrub values that must never reach logs or error messages: URLs (sheet locations, signed links),
// email addresses, bearer tokens, connection strings and long opaque identifiers.
export function redact(text: unknown, max = 300): string {
  return String(text ?? "")
    .replace(/postgres(ql)?:\/\/\S+/gi, "<db-url>")
    .replace(/https?:\/\/\S+/gi, "<url>")
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "<email>")
    .replace(/Bearer\s+\S+/gi, "Bearer <redacted>")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "<id>")
    .slice(0, max);
}

/** One-line, value-free server log entry for an unexpected error. */
export function logServerError(where: string, e: unknown) {
  const err = e as { name?: string; code?: string; message?: string };
  console.error(JSON.stringify({ level: "error", where, name: err?.name ?? "Error", code: err?.code ?? null, message: redact(err?.message) }));
}
