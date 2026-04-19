import type { ExecuteJobResult, ValidationResult } from "../../../runtime/offeringTypes.js";

export async function executeJob(request: Record<string, unknown>): Promise<ExecuteJobResult> {
  return {
    deliverable: JSON.stringify({
      echo: request,
      timestamp: new Date().toISOString(),
      agent: "echo_test",
      status: "ok",
    }),
  };
}

export function validateRequirements(_request: Record<string, unknown>): ValidationResult {
  return { valid: true };
}

export function requestPayment(_request: Record<string, unknown>): string {
  return "Echo test accepted";
}
