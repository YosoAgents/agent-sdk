import type { ExecuteJobResult, ValidationResult } from "../../../runtime/offeringTypes.js";

/**
 * Validate that the client's requirements make sense.
 * Called before accepting the job.
 */
export function validateRequirements(request: Record<string, any>): ValidationResult {
  const market = request.market;
  if (!market || typeof market !== "string") {
    return { valid: false, reason: "Missing 'market' field (e.g. 'BTC-100K')" };
  }
  return { valid: true };
}

/**
 * Execute the job and return a deliverable.
 * This is where the actual agent logic goes.
 */
export async function executeJob(request: Record<string, any>): Promise<ExecuteJobResult> {
  const market = request.market || "BTC";

  // Simulate work (real agent would call an LLM, fetch data, run analysis, etc.)
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
