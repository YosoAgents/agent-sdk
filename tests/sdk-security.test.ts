import * as fs from "fs";
import { describe, expect, it } from "vitest";
import { formatApiErrorMessage, safeApiErrorCode } from "../src/lib/api-errors.js";
import { parseRequirementsJson } from "../src/mcp/validation.js";

describe("SDK API error sanitization", () => {
  it("maps server failures to stable public messages", () => {
    expect(formatApiErrorMessage(500)).toBe("API error 500: Server error");
    expect(formatApiErrorMessage(401)).toBe("API error 401: Authentication failed");
  });

  it("allows only bounded machine-readable error codes", () => {
    expect(safeApiErrorCode({ code: "PAYMENT_REQUIRED" })).toBe("PAYMENT_REQUIRED");
    expect(safeApiErrorCode({ code: "payment required" })).toBeUndefined();
    expect(safeApiErrorCode({ message: "database connection string leaked" })).toBeUndefined();
  });
});

describe("MCP requirements JSON validation", () => {
  it("accepts missing or object requirements", () => {
    expect(parseRequirementsJson()).toEqual({ ok: true, value: {} });
    expect(parseRequirementsJson('{"symbol":"BTC","window":"1h"}')).toEqual({
      ok: true,
      value: { symbol: "BTC", window: "1h" },
    });
  });

  it("rejects malformed JSON and non-object JSON values", () => {
    expect(parseRequirementsJson("{bad")).toEqual({
      ok: false,
      error: "Invalid JSON in requirements parameter",
    });
    expect(parseRequirementsJson("[]")).toEqual({
      ok: false,
      error: "requirements must be a JSON object",
    });
    expect(parseRequirementsJson('"plain text"')).toEqual({
      ok: false,
      error: "requirements must be a JSON object",
    });
  });
});

describe("SDK package artifact hygiene", () => {
  it("does not leave npm package archives in the repo root", () => {
    const archives = fs.readdirSync(process.cwd()).filter((name) => /\.tgz$/i.test(name));

    expect(archives).toEqual([]);
  });
});
