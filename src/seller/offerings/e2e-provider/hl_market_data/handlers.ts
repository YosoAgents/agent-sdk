import type { ExecuteJobResult, ValidationResult } from "../../../runtime/offeringTypes.js";

const HL_INFO = "https://api.hyperliquid.xyz/info";

async function hlPost(payload: Record<string, unknown>) {
  const res = await fetch(HL_INFO, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
}

export async function executeJob(request: any): Promise<ExecuteJobResult> {
  const coin = ((request.coin as string) || "BTC").toUpperCase();
  const dataType = (request.data_type as string) || "all";
  const result: Record<string, unknown> = { coin, timestamp: new Date().toISOString() };

  if (dataType === "mid_price" || dataType === "all") {
    const mids = await hlPost({ type: "allMids" });
    result.midPrice = mids[coin] ?? null;
  }

  if (dataType === "orderbook" || dataType === "all") {
    const book = await hlPost({ type: "l2Book", coin });
    result.orderbook = {
      bids: book.levels?.[0]?.slice(0, 10),
      asks: book.levels?.[1]?.slice(0, 10),
    };
  }

  if (dataType === "candles" || dataType === "all") {
    const now = Date.now();
    const candles = await hlPost({
      type: "candleSnapshot",
      req: { coin, interval: "1h", startTime: now - 24 * 3600_000, endTime: now },
    });
    result.candles = candles?.slice(-24);
  }

  return { deliverable: JSON.stringify(result) };
}

export function validateRequirements(request: any): ValidationResult {
  const coin = request.coin as string;
  if (!coin) return { valid: false, reason: "coin is required (e.g. BTC, ETH, SOL)" };
  const validTypes = ["mid_price", "orderbook", "candles", "all"];
  if (request.data_type && !validTypes.includes(request.data_type)) {
    return { valid: false, reason: `data_type must be: ${validTypes.join(" | ")}` };
  }
  return { valid: true };
}

export function requestPayment(request: any): string {
  return `Market data request for ${request.coin || "BTC"} accepted`;
}
