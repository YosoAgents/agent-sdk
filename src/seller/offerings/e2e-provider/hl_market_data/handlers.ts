import type { ExecuteJobResult, ValidationResult } from "../../../runtime/offeringTypes.js";

const HL_INFO = "https://api.hyperliquid.xyz/info";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function hlPost(payload: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(HL_INFO, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
}

export async function executeJob(request: Record<string, unknown>): Promise<ExecuteJobResult> {
  const coin = (typeof request.coin === "string" ? request.coin : "BTC").toUpperCase();
  const dataType = typeof request.data_type === "string" ? request.data_type : "all";
  const result: Record<string, unknown> = { coin, timestamp: new Date().toISOString() };

  if (dataType === "mid_price" || dataType === "all") {
    const mids = await hlPost({ type: "allMids" });
    result.midPrice = isRecord(mids) ? (mids[coin] ?? null) : null;
  }

  if (dataType === "orderbook" || dataType === "all") {
    const book = await hlPost({ type: "l2Book", coin });
    const levels = isRecord(book) && Array.isArray(book.levels) ? book.levels : [];
    result.orderbook = {
      bids: Array.isArray(levels[0]) ? levels[0].slice(0, 10) : [],
      asks: Array.isArray(levels[1]) ? levels[1].slice(0, 10) : [],
    };
  }

  if (dataType === "candles" || dataType === "all") {
    const now = Date.now();
    const candles = await hlPost({
      type: "candleSnapshot",
      req: { coin, interval: "1h", startTime: now - 24 * 3600_000, endTime: now },
    });
    result.candles = Array.isArray(candles) ? candles.slice(-24) : [];
  }

  return { deliverable: JSON.stringify(result) };
}

export function validateRequirements(request: Record<string, unknown>): ValidationResult {
  const coin = request.coin;
  if (typeof coin !== "string" || !coin) {
    return { valid: false, reason: "coin is required (e.g. BTC, ETH, SOL)" };
  }
  const validTypes = ["mid_price", "orderbook", "candles", "all"];
  if (typeof request.data_type === "string" && !validTypes.includes(request.data_type)) {
    return { valid: false, reason: `data_type must be: ${validTypes.join(" | ")}` };
  }
  return { valid: true };
}

export function requestPayment(request: Record<string, unknown>): string {
  const coin = typeof request.coin === "string" ? request.coin : "BTC";
  return `Market data request for ${coin} accepted`;
}
