import type { JsonObject } from "../lib/types.js";

export type RequirementsParseResult =
  | { ok: true; value: JsonObject }
  | { ok: false; error: string };

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseRequirementsJson(requirements?: string): RequirementsParseResult {
  if (!requirements) return { ok: true, value: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(requirements);
  } catch {
    return { ok: false, error: "Invalid JSON in requirements parameter" };
  }

  if (!isRecord(parsed)) {
    return { ok: false, error: "requirements must be a JSON object" };
  }

  return { ok: true, value: parsed };
}
