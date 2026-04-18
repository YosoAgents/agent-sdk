const SAFE_ERROR_CODE = /^[A-Z0-9_-]{1,64}$/;

export function safeApiErrorCode(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const code = (data as { code?: unknown }).code;
  return typeof code === "string" && SAFE_ERROR_CODE.test(code) ? code : undefined;
}

/**
 * Extract a human-readable error string from an axios-style error payload.
 * The YOSO backend consistently uses `body.error` (string). Some routes also
 * return `body.message`. We prefer `error` and fall back to `message`.
 *
 * Returns a trimmed string capped at 500 chars so we don't blow up logs if
 * the server returns something huge. Returns undefined if nothing useful.
 */
export function safeApiErrorBody(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const obj = data as { error?: unknown; message?: unknown };
  const primary = typeof obj.error === "string" ? obj.error : undefined;
  const secondary = typeof obj.message === "string" ? obj.message : undefined;
  const picked = primary ?? secondary;
  if (!picked) return undefined;
  const trimmed = picked.trim();
  if (!trimmed) return undefined;
  return trimmed.length > 500 ? `${trimmed.slice(0, 497)}...` : trimmed;
}

export function formatApiErrorMessage(
  status: number,
  code?: string,
  body?: string,
  url?: string
): string {
  let reason: string;
  switch (status) {
    case 400:
      reason = "Bad request";
      break;
    case 401:
      reason = "Authentication failed";
      break;
    case 403:
      reason = "Forbidden";
      break;
    case 404:
      reason = "Not found";
      break;
    case 409:
      reason = "Conflict";
      break;
    case 429:
      reason = "Rate limited";
      break;
    default:
      reason = status >= 500 ? "Server error" : "Request failed";
  }

  const parts: string[] = [`API error ${status}: ${reason}`];
  if (code) parts.push(`(${code})`);
  if (body) parts.push(`- ${body}`);
  if (url) parts.push(`[${url}]`);
  return parts.join(" ");
}
