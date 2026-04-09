// =============================================================================
// Integration tests for Hyperliquid client against testnet.
// Requires HYPERLIQUID_PRIVATE_KEY, HYPERLIQUID_WALLET_ADDRESS, HYPERLIQUID_TESTNET=true.
// Skipped entirely if env vars are missing or TESTNET is not explicitly true.
// =============================================================================

import { describe, it, expect, beforeAll } from "vitest";
import { HyperliquidClient } from "../src/capabilities/trading/hyperliquid.js";
import { loadHyperliquidConfig } from "../src/capabilities/trading/config.js";

const hasCredentials =
  !!process.env.HYPERLIQUID_PRIVATE_KEY &&
  !!process.env.HYPERLIQUID_WALLET_ADDRESS &&
  process.env.HYPERLIQUID_TESTNET === "true";

describe.runIf(hasCredentials)("HyperliquidClient integration (testnet)", () => {
  let client: HyperliquidClient;

  beforeAll(async () => {
    const config = loadHyperliquidConfig();
    if (!config) throw new Error("Config should be available when credentials are set");
    if (!config.testnet)
      throw new Error("SAFETY: Integration tests require HYPERLIQUID_TESTNET=true");
    client = new HyperliquidClient(config);
    await client.initialize();
  }, 30_000);

  it("loads metadata with available assets", () => {
    const assets = client.getAvailableAssets();
    expect(assets.native.length).toBeGreaterThan(0);
    // ETH should always be available
    const eth = assets.native.find((a) => a.ticker === "ETH");
    expect(eth).toBeDefined();
  });

  it("gets account balance", async () => {
    const balance = await client.getAccountBalance();
    expect(balance).not.toBeNull();
    expect(balance!.equity).toBeGreaterThanOrEqual(0);
    expect(balance!.availableBalance).toBeGreaterThanOrEqual(0);
  }, 30_000);

  it("gets ETH mid price", async () => {
    const mid = await client.getMidPrice("ETH");
    expect(mid).not.toBeNull();
    expect(mid!).toBeGreaterThan(0);
  }, 30_000);

  it("places and cancels a limit order", async () => {
    const mid = await client.getMidPrice("ETH");
    expect(mid).not.toBeNull();

    // Place far below market — won't fill
    const farPrice = Math.floor(mid! * 0.5);
    const result = await client.placeLimitOrder("ETH", true, farPrice, 10);

    expect(result.success).toBe(true);
    expect(result.orderId).toBeDefined();
    expect(result.status).toBe("resting");

    // Cancel
    const cancelResult = await client.cancelOrder("ETH", result.orderId!);
    expect(cancelResult.success).toBe(true);
  }, 30_000);

  it("gets open positions without error", async () => {
    const positions = await client.getOpenPositions();
    expect(Array.isArray(positions)).toBe(true);
  }, 30_000);
});
