import type { ExecuteJobResult, ValidationResult } from "../../../runtime/offeringTypes.js";

export async function executeJob(request: any): Promise<ExecuteJobResult> {
  return {
    deliverable: JSON.stringify({
      echo: request,
      timestamp: new Date().toISOString(),
      agent: "echo_test",
      status: "ok",
    }),
  };
}

export function validateRequirements(request: any): ValidationResult {
  return { valid: true };
}

export function requestPayment(request: any): string {
  return "Echo test accepted";
}
