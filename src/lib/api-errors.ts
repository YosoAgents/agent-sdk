const SAFE_ERROR_CODE = /^[A-Z0-9_-]{1,64}$/;

export function safeApiErrorCode(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const code = (data as { code?: unknown }).code;
  return typeof code === "string" && SAFE_ERROR_CODE.test(code) ? code : undefined;
}

export function formatApiErrorMessage(status: number, code?: string): string {
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

  return `API error ${status}: ${reason}${code ? ` (${code})` : ""}`;
}
