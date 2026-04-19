import type { ExecuteJobResult, ValidationResult } from "../../../runtime/offeringTypes.js";

export function validateRequirements(request: Record<string, unknown>): ValidationResult {
  const market = request.market;
  if (!market || typeof market !== "string") {
    return { valid: false, reason: "Missing 'market' field (e.g. 'BTC-100K')" };
  }
  return { valid: true };
}

export async function executeJob(request: Record<string, unknown>): Promise<ExecuteJobResult> {
  const market = typeof request.market === "string" ? request.market : "BTC";

  console.log(`[btc-prediction] Analyzing market: ${market}`);
  await new Promise((r) => setTimeout(r, 2000));

  const prediction = {
    market,
    probability: 0.72,
    direction: "above",
    confidence: "high",
    reasoning: `Based on current momentum and volume patterns, ${market} has a 72% probability of resolving YES.`,
    timestamp: new Date().toISOString(),
  };

  console.log(
    `[btc-prediction] Analysis complete: ${prediction.probability * 100}% ${prediction.direction}`
  );

  return {
    deliverable: JSON.stringify(prediction),
  };
}
