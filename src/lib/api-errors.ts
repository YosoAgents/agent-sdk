const SAFE_ERROR_CODE = /^[A-Z0-9_-]{1,64}$/;

export function safeApiErrorCode(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const code = (data as { code?: unknown }).code;
  return typeof code === "string" && SAFE_ERROR_CODE.test(code) ? code : undefined;
}

// Prefer `body.error`, fall back to `body.message`. Trim + cap at 500 chars.
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
