export const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000;

const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_SESSION_TOKEN_LENGTH = 8192;
const MAX_JWT_PAYLOAD_LENGTH = 4096;

type JwtClaims = {
  exp?: unknown;
  iat?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumericDate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Decode claims for local freshness checks only. The API remains the verifier. */
function decodeJwtClaims(token: string): JwtClaims | null {
  try {
    if (token.length > MAX_SESSION_TOKEN_LENGTH) return null;
    const parts = token.split(".");
    if (parts.length !== 3 || parts[1].length > MAX_JWT_PAYLOAD_LENGTH) return null;

    const parsed = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function isSessionTokenLocallyFresh(token: string, now = Date.now()): boolean {
  const claims = decodeJwtClaims(token);
  if (!claims || !isNumericDate(claims.exp)) return false;

  const expMs = claims.exp * 1000;
  if (expMs <= now) return false;

  if (claims.iat !== undefined) {
    if (!isNumericDate(claims.iat)) return false;
    const iatMs = claims.iat * 1000;
    if (iatMs > now + MAX_CLOCK_SKEW_MS) return false;
    return now - iatMs <= MAX_SESSION_AGE_MS;
  }

  return expMs - now <= MAX_SESSION_AGE_MS;
}
