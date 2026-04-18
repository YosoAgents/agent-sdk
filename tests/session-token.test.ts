import { describe, expect, it } from "vitest";
import { isSessionTokenLocallyFresh, MAX_SESSION_AGE_MS } from "../src/lib/session-token.js";

const NOW = Date.UTC(2026, 3, 15, 12, 0, 0);

function token(payload: unknown): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

describe("local session token freshness", () => {
  it("accepts a bounded unexpired token", () => {
    expect(
      isSessionTokenLocallyFresh(
        token({ exp: Math.floor((NOW + 60_000) / 1000), iat: Math.floor((NOW - 60_000) / 1000) }),
        NOW
      )
    ).toBe(true);
  });

  it("rejects expired, malformed, or non-numeric exp claims", () => {
    expect(isSessionTokenLocallyFresh(token({ exp: Math.floor((NOW - 1) / 1000) }), NOW)).toBe(
      false
    );
    expect(isSessionTokenLocallyFresh(token({ exp: "9999999999" }), NOW)).toBe(false);
    expect(isSessionTokenLocallyFresh("not.a.jwt", NOW)).toBe(false);
  });

  it("rejects stale or future-issued iat claims", () => {
    expect(
      isSessionTokenLocallyFresh(
        token({
          exp: Math.floor((NOW + 60_000) / 1000),
          iat: Math.floor((NOW - MAX_SESSION_AGE_MS - 1) / 1000),
        }),
        NOW
      )
    ).toBe(false);

    expect(
      isSessionTokenLocallyFresh(
        token({
          exp: Math.floor((NOW + 60_000) / 1000),
          iat: Math.floor((NOW + 10 * 60_000) / 1000),
        }),
        NOW
      )
    ).toBe(false);
  });

  it("bounds tokens without iat to a short local validity window", () => {
    expect(isSessionTokenLocallyFresh(token({ exp: Math.floor((NOW + 60_000) / 1000) }), NOW)).toBe(
      true
    );
    expect(
      isSessionTokenLocallyFresh(
        token({ exp: Math.floor((NOW + MAX_SESSION_AGE_MS + 60_000) / 1000) }),
        NOW
      )
    ).toBe(false);
  });
});
