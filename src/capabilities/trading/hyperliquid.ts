import { ethers } from "ethers";
import { encode } from "@msgpack/msgpack";
import axios, { type AxiosInstance } from "axios";
import type { HyperliquidConfig } from "./config.js";
import type { JsonObject } from "../../lib/types.js";

const MAINNET_URL = "https://api.hyperliquid.xyz";
const TESTNET_URL = "https://api.hyperliquid-testnet.xyz";

// Builder-deployed perp offset (first builder dex = XYZ)
// From Python SDK info.py: 110000 + i * 10000 where i is 0-based dex index
const XYZ_OFFSET = 110000;

// EIP-712 domain for phantom agent signing (fixed, never changes)
const PHANTOM_DOMAIN = {
  name: "Exchange",
  version: "1",
  chainId: 1337,
  verifyingContract: "0x0000000000000000000000000000000000000000",
};

const AGENT_TYPES = {
  Agent: [
    { name: "source", type: "string" },
    { name: "connectionId", type: "bytes32" },
  ],
};

export const HYPERLIQUID_ORDER_TYPES = ["limit", "market", "alo"] as const;
export type HyperliquidOrderType = (typeof HYPERLIQUID_ORDER_TYPES)[number];

type ExchangeStatus =
  | string
  | {
      resting?: { oid: string | number };
      filled?: { oid: string | number };
      error?: string;
    };

interface ExchangeResponse {
  status?: string;
  response?: string | { data?: { statuses?: ExchangeStatus[] } };
}

interface PositionPayload {
  coin: string;
  szi: string;
  entryPx: string;
  unrealizedPnl: string;
  liquidationPx?: string | null;
}

/** Normalize a float to wire format. Matches Python SDK's float_to_wire(). */
export function floatToWire(x: number): string {
  const rounded = x.toFixed(8);
  if (Math.abs(parseFloat(rounded) - x) >= 1e-12) {
    throw new Error(`floatToWire causes rounding: ${x}`);
  }
  let normalized = rounded.replace(/\.?0+$/, "");
  if (normalized === "-0") normalized = "0";
  return normalized;
}

function removeTrailingZeros(value: string): string {
  if (!value.includes(".")) return value;
  let normalized = value.replace(/\.?0+$/, "");
  if (normalized === "-0") normalized = "0";
  return normalized;
}

export function normalizeAction<T>(obj: T): T {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) {
    return obj.map((item) => normalizeAction(item)) as unknown as T;
  }
  const result: Record<string, unknown> = { ...(obj as Record<string, unknown>) };
  for (const key in result) {
    if (!Object.prototype.hasOwnProperty.call(result, key)) continue;
    const value = result[key];
    if (value && typeof value === "object") {
      result[key] = normalizeAction(value);
    } else if ((key === "p" || key === "s" || key === "triggerPx") && typeof value === "string") {
      result[key] = removeTrailingZeros(value);
    }
  }
  return result as T;
}

/**
 * Hash an action for signing. Port of Python SDK's action_hash().
 * msgpack(action) + nonce(8B BE) + vaultFlag(1B) [+ vaultAddr(20B)] → keccak256
 */
export function actionHash(action: unknown, vaultAddress: string | null, nonce: number): string {
  const normalized = normalizeAction(action);
  const msgpackBytes = encode(normalized);

  const additionalBytes = vaultAddress === null ? 9 : 29;
  const data = new Uint8Array(msgpackBytes.length + additionalBytes);
  data.set(msgpackBytes);

  const view = new DataView(data.buffer);
  // Nonce as big-endian uint64
  view.setBigUint64(msgpackBytes.length, BigInt(nonce), false);

  if (vaultAddress === null) {
    view.setUint8(msgpackBytes.length + 8, 0);
  } else {
    view.setUint8(msgpackBytes.length + 8, 1);
    data.set(ethers.getBytes(vaultAddress), msgpackBytes.length + 9);
  }

  return ethers.keccak256(data);
}

/** All known cancel/reject statuses from Hyperliquid docs. */
const CANCEL_STATUSES = new Set([
  "canceled",
  "marginCanceled",
  "selfTradeCanceled",
  "reduceOnlyCanceled",
  "siblingFilledCanceled",
  "liquidatedCanceled",
  "vaultWithdrawalCanceled",
  "openInterestCapCanceled",
  "delistedCanceled",
  "scheduledCancel",
  "tickRejected",
  "minTradeNtlRejected",
  "perpMarginRejected",
  "reduceOnlyRejected",
  "badAloPxRejected",
  "iocCancelRejected",
  "badTriggerPxRejected",
  "marketOrderNoLiquidityRejected",
  "positionIncreaseAtOpenInterestCapRejected",
  "positionFlipAtOpenInterestCapRejected",
  "tooAggressiveAtOpenInterestCapRejected",
  "openInterestIncreaseRejected",
  "insufficientSpotBalanceRejected",
  "oracleRejected",
  "perpMaxPositionRejected",
]);

export interface OrderResult {
  success: boolean;
  orderId?: string;
  error?: string;
  status?: string;
}

export interface BracketOrderResult {
  success: boolean;
  entryOid?: string;
  tpOid?: string;
  slOid?: string;
  error?: string;
}

export interface Position {
  ticker: string;
  direction: "long" | "short";
  size: number;
  entryPrice: number;
  unrealizedPnl: number;
  liquidationPrice: number | null;
}

export interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timeMs: number;
}

export interface BracketOrderParams {
  coin: string;
  isBuy: boolean;
  sizeUsd: number;
  entryPrice: number;
  entryType?: HyperliquidOrderType;
  tpPrice?: number;
  slPrice?: number;
}

export class HyperliquidClient {
  private readonly baseUrl: string;
  private readonly wallet: ethers.Wallet;
  private readonly address: string;
  private readonly http: AxiosInstance;
  private szDecimals: Map<string, number> = new Map();
  private assetIndices: Map<string, number> = new Map();
  private xyzTickers: Set<string> = new Set();

  // Mid-price cache with 2s TTL
  private midCache: Map<string, { price: number; ts: number }> = new Map();
  private static readonly MID_CACHE_TTL = 2000;

  constructor(config: HyperliquidConfig) {
    this.baseUrl = config.testnet ? TESTNET_URL : MAINNET_URL;
    this.wallet = new ethers.Wallet(config.privateKey);
    this.address = config.walletAddress;
    this.http = axios.create({
      baseURL: this.baseUrl,
      timeout: 10_000,
      headers: { "Content-Type": "application/json" },
    });
  }

  /** Load metadata from exchange. Call once after construction. */
  async initialize(): Promise<void> {
    await this.loadMeta();
  }

  private async loadMeta(): Promise<void> {
    // Native perps - universe array position IS the asset index (0-based)
    const meta = await this.infoPost<{ universe: Array<{ name: string; szDecimals: number }> }>(
      "meta"
    );
    meta.universe.forEach((asset, idx) => {
      this.szDecimals.set(asset.name, asset.szDecimals);
      this.assetIndices.set(asset.name, idx);
    });

    // XYZ builder-deployed perps - offset 110000 (first builder dex)
    // From Python SDK info.py: perp_dex_to_offset = 110000 + i * 10000
    try {
      const xyzMeta = await this.infoPost<{
        universe: Array<{ name: string; szDecimals: number }>;
      }>("meta", { dex: "xyz" });
      xyzMeta.universe.forEach((asset, idx) => {
        this.szDecimals.set(asset.name, asset.szDecimals);
        this.xyzTickers.add(asset.name);
        this.assetIndices.set(asset.name, XYZ_OFFSET + idx);
      });
    } catch (e) {
      console.error("[hl] Failed to load XYZ metadata:", e instanceof Error ? e.message : e);
    }
  }

  /** Resolve user-supplied ticker to canonical form. */
  resolveTicker(raw: string): string {
    const stripped = raw.trim();
    let canonical: string;
    if (stripped.includes(":")) {
      const [prefix, name] = stripped.split(":", 2);
      canonical = `${prefix.toLowerCase()}:${name.toUpperCase()}`;
    } else {
      canonical = stripped.toUpperCase();
    }

    if (this.szDecimals.has(canonical)) return canonical;

    // Bare name that matches an XYZ ticker
    if (!canonical.includes(":")) {
      const xyzCandidate = `xyz:${canonical}`;
      if (this.xyzTickers.has(xyzCandidate)) return xyzCandidate;
    }

    return canonical;
  }

  private isXyzTicker(ticker: string): boolean {
    return ticker.startsWith("xyz:") || this.xyzTickers.has(ticker);
  }

  getAvailableAssets(): {
    native: Array<{ ticker: string; szDecimals: number }>;
    xyz: Array<{ ticker: string; szDecimals: number }>;
  } {
    const native: Array<{ ticker: string; szDecimals: number }> = [];
    const xyz: Array<{ ticker: string; szDecimals: number }> = [];
    for (const [name, szDec] of [...this.szDecimals.entries()].sort((a, b) =>
      a[0].localeCompare(b[0])
    )) {
      const entry = { ticker: name, szDecimals: szDec };
      if (this.xyzTickers.has(name)) {
        xyz.push(entry);
      } else {
        native.push(entry);
      }
    }
    return { native, xyz };
  }

  /** Round price to 5 significant figures (Hyperliquid requirement). */
  static roundPrice(price: number): number {
    return parseFloat(price.toPrecision(5));
  }

  /** Convert USD notional to contract size, rounded to szDecimals. */
  usdToContracts(ticker: string, price: number, sizeUsd: number): number {
    if (price <= 0) return 0;
    const raw = sizeUsd / price;
    const decimals = this.szDecimals.get(ticker) ?? 3;
    const factor = Math.pow(10, decimals);
    return Math.floor(raw * factor) / factor;
  }

  private async infoPost<T>(type: string, extraPayload?: Record<string, unknown>): Promise<T> {
    const payload: Record<string, unknown> = { type, ...extraPayload };
    const { data } = await this.http.post("/info", payload);
    return data as T;
  }

  private async exchangePost(action: JsonObject): Promise<ExchangeResponse> {
    const nonce = Date.now();
    const payload = {
      action,
      nonce,
      signature: await this.signAction(action, nonce),
      vaultAddress: null,
    };
    const { data } = await this.http.post("/exchange", payload);
    return data;
  }

  /**
   * Sign an exchange action using the phantom agent pattern.
   * Port of Python SDK's sign_l1_action(): hash action → phantom agent → EIP-712.
   */
  private async signAction(
    action: JsonObject,
    nonce: number
  ): Promise<{ r: string; s: string; v: number }> {
    const hash = actionHash(action, null, nonce);
    const isMainnet = !this.baseUrl.includes("testnet");
    const phantomAgent = {
      source: isMainnet ? "a" : "b",
      connectionId: hash,
    };

    const sig = await this.wallet.signTypedData(PHANTOM_DOMAIN, AGENT_TYPES, phantomAgent);
    const { r, s, v } = ethers.Signature.from(sig);
    return { r, s, v };
  }

  async getMidPrice(coin: string): Promise<number | null> {
    const ticker = this.resolveTicker(coin);
    const cached = this.midCache.get(ticker);
    if (cached && Date.now() - cached.ts < HyperliquidClient.MID_CACHE_TTL) {
      return cached.price;
    }

    try {
      const mids = await this.infoPost<Record<string, string>>("allMids");
      const midStr = mids[ticker];
      if (!midStr) return null;
      const price = parseFloat(midStr);
      this.midCache.set(ticker, { price, ts: Date.now() });
      return price;
    } catch (e) {
      console.error(`[hl] getMidPrice failed for ${ticker}:`, e instanceof Error ? e.message : e);
      return null;
    }
  }

  async getCandles(coin: string, interval = "5m", count = 20): Promise<Candle[]> {
    const ticker = this.resolveTicker(coin);
    const intervalMs = HyperliquidClient.intervalToMs(interval);
    const nowMs = Date.now();
    const startMs = nowMs - (count + 2) * intervalMs;

    try {
      const raw = await this.infoPost<
        Array<{ o: string; h: string; l: string; c: string; v: string; t: number; T: number }>
      >("candleSnapshot", { coin: ticker, interval, startTime: startMs, endTime: nowMs });
      if (!raw || !raw.length) return [];

      const candles: Candle[] = [];
      for (const c of raw) {
        const timeMs = c.t || c.T || 0;
        if (timeMs + intervalMs <= nowMs) {
          candles.push({
            open: parseFloat(c.o),
            high: parseFloat(c.h),
            low: parseFloat(c.l),
            close: parseFloat(c.c),
            volume: parseFloat(c.v),
            timeMs,
          });
        }
      }
      return candles.slice(-count);
    } catch (e) {
      console.error(`[hl] getCandles failed for ${ticker}:`, e instanceof Error ? e.message : e);
      return [];
    }
  }

  static intervalToMs(interval: string): number {
    const units: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };
    for (const [suffix, multiplier] of Object.entries(units)) {
      if (interval.endsWith(suffix)) {
        return parseInt(interval.slice(0, -suffix.length), 10) * multiplier;
      }
    }
    throw new Error(`Unknown interval format: ${interval}`);
  }

  async placeLimitOrder(
    coin: string,
    isBuy: boolean,
    price: number,
    sizeUsd: number,
    reduceOnly = false
  ): Promise<OrderResult> {
    const ticker = this.resolveTicker(coin);
    const sz = this.usdToContracts(ticker, price, sizeUsd);
    if (sz <= 0) return { success: false, error: "Computed contract size is zero" };

    try {
      const result = await this.exchangePost({
        type: "order",
        orders: [
          {
            a: this.assetIndex(ticker),
            b: isBuy,
            p: HyperliquidClient.roundPrice(price).toString(),
            s: sz.toString(),
            r: reduceOnly,
            t: { limit: { tif: "Gtc" } },
          },
        ],
        grouping: "na",
      });
      return this.parseOrderResult(result);
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async placeMarketOrder(coin: string, isBuy: boolean, sizeUsd: number): Promise<OrderResult> {
    const ticker = this.resolveTicker(coin);
    const mid = await this.getMidPrice(ticker);
    if (!mid) return { success: false, error: `No mid price found for ${ticker}` };

    const slippage = 0.01;
    const limitPrice = isBuy ? mid * (1 + slippage) : mid * (1 - slippage);
    const sz = this.usdToContracts(ticker, mid, sizeUsd);
    if (sz <= 0) return { success: false, error: "Computed contract size is zero" };

    try {
      const result = await this.exchangePost({
        type: "order",
        orders: [
          {
            a: this.assetIndex(ticker),
            b: isBuy,
            p: HyperliquidClient.roundPrice(limitPrice).toString(),
            s: sz.toString(),
            r: false,
            t: { limit: { tif: "Ioc" } },
          },
        ],
        grouping: "na",
      });
      return this.parseOrderResult(result);
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async placePostOnlyOrder(
    coin: string,
    isBuy: boolean,
    price: number,
    sizeUsd: number,
    reduceOnly = false
  ): Promise<OrderResult> {
    const ticker = this.resolveTicker(coin);
    const sz = this.usdToContracts(ticker, price, sizeUsd);
    if (sz <= 0) return { success: false, error: "Computed contract size is zero" };

    try {
      const result = await this.exchangePost({
        type: "order",
        orders: [
          {
            a: this.assetIndex(ticker),
            b: isBuy,
            p: HyperliquidClient.roundPrice(price).toString(),
            s: sz.toString(),
            r: reduceOnly,
            t: { limit: { tif: "Alo" } },
          },
        ],
        grouping: "na",
      });
      return this.parseOrderResult(result);
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async placeBracketOrder(params: BracketOrderParams): Promise<BracketOrderResult> {
    const { coin, isBuy, sizeUsd, entryPrice, entryType = "limit", tpPrice, slPrice } = params;
    const ticker = this.resolveTicker(coin);
    const sz = this.usdToContracts(ticker, entryPrice, sizeUsd);
    if (sz <= 0) return { success: false, error: "Computed contract size is zero" };

    const orders: JsonObject[] = [];

    // Parent: entry order
    if (entryType === "market") {
      const mid = await this.getMidPrice(ticker);
      const slippage = 0.01;
      const limitPx = isBuy
        ? (mid ?? entryPrice) * (1 + slippage)
        : (mid ?? entryPrice) * (1 - slippage);
      orders.push({
        a: this.assetIndex(ticker),
        b: isBuy,
        p: HyperliquidClient.roundPrice(limitPx).toString(),
        s: sz.toString(),
        r: false,
        t: { limit: { tif: "Ioc" } },
      });
    } else if (entryType === "alo") {
      orders.push({
        a: this.assetIndex(ticker),
        b: isBuy,
        p: HyperliquidClient.roundPrice(entryPrice).toString(),
        s: sz.toString(),
        r: false,
        t: { limit: { tif: "Alo" } },
      });
    } else {
      orders.push({
        a: this.assetIndex(ticker),
        b: isBuy,
        p: HyperliquidClient.roundPrice(entryPrice).toString(),
        s: sz.toString(),
        r: false,
        t: { limit: { tif: "Gtc" } },
      });
    }

    // Oversize TP/SL by 1 szDecimal unit for full close
    const decimals = this.szDecimals.get(ticker) ?? 3;
    const closeSz = sz + Math.pow(10, -decimals);

    // Child: TP
    if (tpPrice) {
      const tpPx = HyperliquidClient.roundPrice(tpPrice);
      orders.push({
        a: this.assetIndex(ticker),
        b: !isBuy,
        p: tpPx.toString(),
        s: closeSz.toString(),
        r: true,
        t: { trigger: { triggerPx: tpPx.toString(), isMarket: true, tpsl: "tp" } },
      });
    }

    // Child: SL
    if (slPrice) {
      const slPx = HyperliquidClient.roundPrice(slPrice);
      orders.push({
        a: this.assetIndex(ticker),
        b: !isBuy,
        p: slPx.toString(),
        s: closeSz.toString(),
        r: true,
        t: { trigger: { triggerPx: slPx.toString(), isMarket: true, tpsl: "sl" } },
      });
    }

    const grouping = orders.length > 1 ? "normalTpsl" : "na";

    try {
      const result = await this.exchangePost({ type: "order", orders, grouping });

      if (result?.status === "err") {
        return { success: false, error: this.exchangeError(result, "Order rejected") };
      }

      const statuses = this.exchangeStatuses(result);
      const out: BracketOrderResult = { success: true };

      // Parse entry
      if (statuses[0]) {
        const s = statuses[0];
        if (typeof s === "object") {
          if (s.resting) out.entryOid = String(s.resting.oid);
          else if (s.filled) out.entryOid = String(s.filled.oid);
          else if (s.error) return { success: false, error: `Entry rejected: ${s.error}` };
        }
      }

      // Parse children
      let childIdx = 1;
      if (tpPrice && childIdx < statuses.length) {
        const s = statuses[childIdx];
        if (typeof s === "object" && s.resting) out.tpOid = String(s.resting.oid);
        else if (s === "waitingForFill" && out.entryOid)
          out.tpOid = String(parseInt(out.entryOid) + childIdx);
        childIdx++;
      }
      if (slPrice && childIdx < statuses.length) {
        const s = statuses[childIdx];
        if (typeof s === "object" && s.resting) out.slOid = String(s.resting.oid);
        else if (s === "waitingForFill" && out.entryOid)
          out.slOid = String(parseInt(out.entryOid) + childIdx);
      }

      return out;
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async cancelOrder(coin: string, orderId: string | number): Promise<OrderResult> {
    const ticker = this.resolveTicker(coin);
    const oid = typeof orderId === "string" ? parseInt(orderId, 10) : orderId;
    try {
      const result = await this.exchangePost({
        type: "cancel",
        cancels: [{ a: this.assetIndex(ticker), o: oid }],
      });
      if (result?.status === "ok") return { success: true };
      return { success: false, error: this.exchangeError(result, "Cancel failed") };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async cancelAllOrders(coin: string): Promise<{ cancelled: number; errors: string[] }> {
    const ticker = this.resolveTicker(coin);
    const errors: string[] = [];

    try {
      const openOrders = await this.infoPost<Array<{ coin: string; oid: number }>>("openOrders", {
        user: this.address,
      });
      const matching = openOrders.filter((o) => o.coin === ticker);
      if (!matching.length) return { cancelled: 0, errors: [] };

      const cancels = matching.map((o) => ({ a: this.assetIndex(ticker), o: o.oid }));
      const result = await this.exchangePost({ type: "cancel", cancels });

      const statuses = this.exchangeStatuses(result);
      let cancelled = 0;
      for (let i = 0; i < statuses.length; i++) {
        if (statuses[i] === "success") cancelled++;
        else errors.push(`oid ${matching[i].oid}: ${JSON.stringify(statuses[i])}`);
      }
      return { cancelled, errors };
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
      return { cancelled: 0, errors };
    }
  }

  async modifyOrder(
    orderId: string | number,
    coin: string,
    isBuy: boolean,
    sizeUsd?: number,
    price?: number
  ): Promise<OrderResult> {
    const ticker = this.resolveTicker(coin);
    if (!price) return { success: false, error: "Price required for modify" };
    const oid = typeof orderId === "string" ? parseInt(orderId, 10) : orderId;

    const sz = sizeUsd ? this.usdToContracts(ticker, price, sizeUsd) : undefined;

    try {
      const result = await this.exchangePost({
        type: "batchModify",
        modifies: [
          {
            oid,
            order: {
              a: this.assetIndex(ticker),
              b: isBuy,
              p: HyperliquidClient.roundPrice(price).toString(),
              s: sz?.toString(),
              r: false,
              t: { limit: { tif: "Gtc" } },
            },
          },
        ],
      });
      return this.parseOrderResult(result);
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async closePosition(coin: string): Promise<OrderResult> {
    const ticker = this.resolveTicker(coin);
    const positions = await this.getOpenPositions();
    const pos = positions.find((p) => p.ticker === ticker);
    if (!pos) return { success: false, error: `No open position for ${ticker}` };

    // Market close: order in opposite direction
    const isBuy = pos.direction === "short";
    const mid = await this.getMidPrice(ticker);
    if (!mid) return { success: false, error: `No mid price for ${ticker}` };

    const slippage = 0.01;
    const limitPrice = isBuy ? mid * (1 + slippage) : mid * (1 - slippage);

    try {
      const result = await this.exchangePost({
        type: "order",
        orders: [
          {
            a: this.assetIndex(ticker),
            b: isBuy,
            p: HyperliquidClient.roundPrice(limitPrice).toString(),
            s: pos.size.toString(),
            r: true,
            t: { limit: { tif: "Ioc" } },
          },
        ],
        grouping: "na",
      });
      return this.parseOrderResult(result);
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async getOpenPositions(): Promise<Position[]> {
    const positions: Position[] = [];

    // Native positions
    const state = await this.infoPost<{ assetPositions: Array<{ position: PositionPayload }> }>(
      "clearinghouseState",
      { user: this.address }
    );
    positions.push(...this.parsePositions(state));

    // XYZ positions
    try {
      const xyzState = await this.infoPost<{
        assetPositions: Array<{ position: PositionPayload }>;
      }>("clearinghouseState", { user: this.address, dex: "xyz" });
      positions.push(...this.parsePositions(xyzState));
    } catch {
      // XYZ may not be available
    }

    return positions;
  }

  private parsePositions(state: {
    assetPositions: Array<{ position: PositionPayload }>;
  }): Position[] {
    const positions: Position[] = [];
    for (const posData of state.assetPositions ?? []) {
      const item = posData.position;
      const szi = parseFloat(item.szi);
      if (szi === 0) continue;

      positions.push({
        ticker: item.coin,
        direction: szi > 0 ? "long" : "short",
        size: Math.abs(szi),
        entryPrice: parseFloat(item.entryPx),
        unrealizedPnl: parseFloat(item.unrealizedPnl),
        liquidationPrice: item.liquidationPx ? parseFloat(item.liquidationPx) : null,
      });
    }
    return positions;
  }

  async getAccountBalance(): Promise<{ equity: number; availableBalance: number } | null> {
    try {
      const state = await this.infoPost<{
        marginSummary: { accountValue: string; totalRawUsd: string };
      }>("clearinghouseState", { user: this.address });
      const margin = state.marginSummary;
      return {
        equity: parseFloat(margin.accountValue),
        availableBalance: parseFloat(margin.totalRawUsd),
      };
    } catch (e) {
      console.error("[hl] getAccountBalance failed:", e instanceof Error ? e.message : e);
      return null;
    }
  }

  async getFills(hoursBack = 24): Promise<unknown[]> {
    const startTime = Date.now() - hoursBack * 3600_000;
    try {
      return await this.infoPost<unknown[]>("userFills", { user: this.address, startTime });
    } catch (e) {
      console.error("[hl] getFills failed:", e instanceof Error ? e.message : e);
      return [];
    }
  }

  /** Get the integer asset index for a ticker. Throws if ticker is unknown. */
  private assetIndex(ticker: string): number {
    const idx = this.assetIndices.get(ticker);
    if (idx === undefined) {
      throw new Error(`Unknown asset: ${ticker}. Call initialize() first or check ticker.`);
    }
    return idx;
  }

  private exchangeError(result: ExchangeResponse, defaultMessage: string): string {
    if (typeof result.response === "string") return result.response;
    return defaultMessage;
  }

  private exchangeStatuses(result: ExchangeResponse): ExchangeStatus[] {
    return typeof result.response === "object" && Array.isArray(result.response.data?.statuses)
      ? result.response.data.statuses
      : [];
  }

  private parseOrderResult(result: ExchangeResponse): OrderResult {
    if (result?.status === "err") {
      return { success: false, error: this.exchangeError(result, "Order rejected") };
    }

    const statuses = this.exchangeStatuses(result);
    if (!statuses.length) return { success: false, error: "No status returned" };

    const s = statuses[0];
    if (typeof s === "object") {
      if (s.resting) return { success: true, orderId: String(s.resting.oid), status: "resting" };
      if (s.filled) return { success: true, orderId: String(s.filled.oid), status: "filled" };
      if (s.error) return { success: false, error: s.error };
    }
    if (typeof s === "string" && CANCEL_STATUSES.has(s)) {
      return { success: false, error: s, status: s };
    }

    return { success: true, status: String(s) };
  }
}
