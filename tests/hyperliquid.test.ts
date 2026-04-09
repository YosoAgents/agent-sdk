// =============================================================================
// Unit tests for Hyperliquid client utility functions.
// No network calls -- tests pure computation only.
// =============================================================================

import { describe, it, expect } from "vitest";
import {
  HyperliquidClient,
  floatToWire,
  normalizeAction,
  actionHash,
} from "../src/capabilities/trading/hyperliquid.js";

describe("HyperliquidClient.roundPrice", () => {
  it("rounds BTC-level prices to 5 sig figs", () => {
    expect(HyperliquidClient.roundPrice(70123.456)).toBe(70123);
  });

  it("rounds sub-dollar prices preserving decimals", () => {
    expect(HyperliquidClient.roundPrice(0.0034567)).toBe(0.0034567);
  });

  it("rounds 5-digit prices", () => {
    expect(HyperliquidClient.roundPrice(12345.6789)).toBe(12346);
  });

  it("handles exact 5 sig figs", () => {
    expect(HyperliquidClient.roundPrice(10000)).toBe(10000);
  });

  it("handles small prices", () => {
    expect(HyperliquidClient.roundPrice(0.00012345)).toBe(0.00012345);
  });

  it("handles very large prices", () => {
    expect(HyperliquidClient.roundPrice(123456.789)).toBe(123460);
  });
});

describe("HyperliquidClient.intervalToMs", () => {
  it("parses minute intervals", () => {
    expect(HyperliquidClient.intervalToMs("5m")).toBe(300_000);
    expect(HyperliquidClient.intervalToMs("1m")).toBe(60_000);
    expect(HyperliquidClient.intervalToMs("15m")).toBe(900_000);
  });

  it("parses hour intervals", () => {
    expect(HyperliquidClient.intervalToMs("1h")).toBe(3_600_000);
    expect(HyperliquidClient.intervalToMs("4h")).toBe(14_400_000);
  });

  it("parses day intervals", () => {
    expect(HyperliquidClient.intervalToMs("1d")).toBe(86_400_000);
  });

  it("throws on unknown format", () => {
    expect(() => HyperliquidClient.intervalToMs("5x")).toThrow("Unknown interval format");
  });
});

// -- New: Wire format helpers --

describe("floatToWire", () => {
  it("strips trailing zeros", () => {
    expect(floatToWire(3500)).toBe("3500");
    expect(floatToWire(1.5)).toBe("1.5");
    expect(floatToWire(0.1)).toBe("0.1");
  });

  it("normalizes -0 to 0", () => {
    expect(floatToWire(-0)).toBe("0");
  });

  it("preserves necessary precision", () => {
    expect(floatToWire(0.00012345)).toBe("0.00012345");
    expect(floatToWire(1234.5678)).toBe("1234.5678");
  });

  it("handles integers", () => {
    expect(floatToWire(100)).toBe("100");
    expect(floatToWire(1)).toBe("1");
  });

  it("throws on lossy rounding", () => {
    // Numbers that lose precision beyond 8 decimal places
    expect(() => floatToWire(1.000000001)).toThrow("floatToWire causes rounding");
    expect(() => floatToWire(0.123456789123)).toThrow("floatToWire causes rounding");
    // Within 8 decimals is fine
    expect(() => floatToWire(1.00000001)).not.toThrow();
  });
});

describe("normalizeAction", () => {
  it("strips trailing zeros from p and s fields", () => {
    const action = {
      type: "order",
      orders: [{ a: 4, b: true, p: "3500.00", s: "0.10000", r: false }],
    };
    const normalized = normalizeAction(action);
    expect(normalized.orders[0].p).toBe("3500");
    expect(normalized.orders[0].s).toBe("0.1");
  });

  it("strips trailing zeros from triggerPx", () => {
    const action = {
      type: "order",
      orders: [
        {
          a: 4,
          b: false,
          p: "3600.00",
          s: "0.10",
          r: true,
          t: { trigger: { triggerPx: "3600.00000", isMarket: true, tpsl: "tp" } },
        },
      ],
    };
    const normalized = normalizeAction(action);
    expect(normalized.orders[0].t.trigger.triggerPx).toBe("3600");
  });

  it("does not modify non-string fields", () => {
    const action = { type: "order", orders: [{ a: 4, b: true, r: false }] };
    const normalized = normalizeAction(action);
    expect(normalized.orders[0].a).toBe(4);
    expect(normalized.orders[0].b).toBe(true);
  });

  it("handles null/undefined gracefully", () => {
    expect(normalizeAction(null)).toBe(null);
    expect(normalizeAction(undefined)).toBe(undefined);
    expect(normalizeAction("hello")).toBe("hello");
  });
});

describe("actionHash", () => {
  it("produces deterministic output for same input", () => {
    const action = {
      type: "order",
      orders: [{ a: 4, b: true, p: "3500", s: "0.1", r: false, t: { limit: { tif: "Gtc" } } }],
      grouping: "na",
    };
    const hash1 = actionHash(action, null, 1700000000000);
    const hash2 = actionHash(action, null, 1700000000000);
    expect(hash1).toBe(hash2);
  });

  it("produces different output for different nonces", () => {
    const action = {
      type: "order",
      orders: [{ a: 4, b: true, p: "3500", s: "0.1", r: false, t: { limit: { tif: "Gtc" } } }],
      grouping: "na",
    };
    const hash1 = actionHash(action, null, 1700000000000);
    const hash2 = actionHash(action, null, 1700000000001);
    expect(hash1).not.toBe(hash2);
  });

  it("returns a valid keccak256 hash (0x-prefixed, 66 chars)", () => {
    const action = { type: "cancel", cancels: [{ a: 0, o: 12345 }] };
    const hash = actionHash(action, null, 1700000000000);
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("normalizes trailing zeros before hashing", () => {
    const action1 = { type: "order", orders: [{ p: "3500.00", s: "0.100" }], grouping: "na" };
    const action2 = { type: "order", orders: [{ p: "3500", s: "0.1" }], grouping: "na" };
    const hash1 = actionHash(action1, null, 1700000000000);
    const hash2 = actionHash(action2, null, 1700000000000);
    expect(hash1).toBe(hash2);
  });
});
