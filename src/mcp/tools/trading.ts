import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { HyperliquidClient } from "../../capabilities/trading/hyperliquid.js";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ success: true, data }) }] };
}

function err(error: string): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ success: false, error }) }] };
}

const NOT_CONFIGURED =
  "Hyperliquid not configured. Set HYPERLIQUID_PRIVATE_KEY and HYPERLIQUID_WALLET_ADDRESS in .env";

export function registerTradingTools(server: McpServer, client: HyperliquidClient | null): void {
  server.tool(
    "hl_place_order",
    "Place an order on Hyperliquid (limit, market, ALO, or bracket with TP/SL)",
    {
      coin: z.string().min(1).max(20).describe("Ticker (e.g. BTC, ETH, xyz:NVDA)"),
      side: z.enum(["buy", "sell"]).describe("Order side"),
      size_usd: z.number().positive().max(100_000).describe("Order size in USD (max 100k)"),
      price: z.number().positive().optional().describe("Limit price (omit for market order)"),
      order_type: z
        .enum(["limit", "market", "alo"])
        .optional()
        .default("limit")
        .describe("Order type"),
      reduce_only: z.boolean().optional().default(false).describe("Reduce-only order"),
      tp_price: z.number().optional().describe("Take-profit trigger price (creates bracket)"),
      sl_price: z.number().optional().describe("Stop-loss trigger price (creates bracket)"),
    },
    async (params) => {
      if (!client) return err(NOT_CONFIGURED);
      try {
        const isBuy = params.side === "buy";
        // Bracket order if TP or SL provided
        if (params.tp_price || params.sl_price) {
          const entryPrice = params.price ?? (await client.getMidPrice(params.coin));
          if (!entryPrice) return err(`No price available for ${params.coin}`);
          const result = await client.placeBracketOrder({
            coin: params.coin,
            isBuy,
            sizeUsd: params.size_usd,
            entryPrice,
            entryType: params.order_type ?? "limit",
            tpPrice: params.tp_price,
            slPrice: params.sl_price,
          });
          return ok(result);
        }
        // Market order
        if (!params.price || params.order_type === "market") {
          const result = await client.placeMarketOrder(params.coin, isBuy, params.size_usd);
          return ok(result);
        }
        // ALO order
        if (params.order_type === "alo") {
          const result = await client.placePostOnlyOrder(
            params.coin,
            isBuy,
            params.price,
            params.size_usd,
            params.reduce_only
          );
          return ok(result);
        }
        // Limit order (default)
        const result = await client.placeLimitOrder(
          params.coin,
          isBuy,
          params.price,
          params.size_usd,
          params.reduce_only
        );
        return ok(result);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    }
  );

  server.tool(
    "hl_cancel_order",
    "Cancel an open order on Hyperliquid",
    {
      coin: z.string().min(1).max(20).describe("Ticker"),
      order_id: z.number().int().positive().describe("Order ID"),
    },
    async (params) => {
      if (!client) return err(NOT_CONFIGURED);
      try {
        const result = await client.cancelOrder(params.coin, params.order_id);
        return ok(result);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    }
  );

  server.tool(
    "hl_modify_order",
    "Modify an existing order on Hyperliquid",
    {
      order_id: z.number().int().positive().describe("Order ID"),
      coin: z.string().min(1).max(20).describe("Ticker"),
      side: z.enum(["buy", "sell"]).describe("Order side"),
      size_usd: z
        .number()
        .positive()
        .max(100_000)
        .optional()
        .describe("New size in USD (max 100k)"),
      price: z.number().positive().optional().describe("New limit price"),
    },
    async (params) => {
      if (!client) return err(NOT_CONFIGURED);
      try {
        const result = await client.modifyOrder(
          params.order_id,
          params.coin,
          params.side === "buy",
          params.size_usd,
          params.price
        );
        return ok(result);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    }
  );

  server.tool(
    "hl_close_position",
    "Market-close a position on Hyperliquid",
    { coin: z.string().min(1).max(20).describe("Ticker to close") },
    async (params) => {
      if (!client) return err(NOT_CONFIGURED);
      try {
        const result = await client.closePosition(params.coin);
        return ok(result);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    }
  );

  server.tool("hl_get_positions", "Get all open positions on Hyperliquid", {}, async () => {
    if (!client) return err(NOT_CONFIGURED);
    try {
      const positions = await client.getOpenPositions();
      return ok(positions);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  });

  server.tool(
    "hl_get_fills",
    "Get recent fills on Hyperliquid",
    {
      hours_back: z
        .number()
        .positive()
        .max(720)
        .optional()
        .default(24)
        .describe("Hours of fill history (max 30 days)"),
    },
    async (params) => {
      if (!client) return err(NOT_CONFIGURED);
      try {
        const fills = await client.getFills(params.hours_back);
        return ok(fills);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    }
  );

  server.tool("hl_get_balance", "Get account equity on Hyperliquid", {}, async () => {
    if (!client) return err(NOT_CONFIGURED);
    try {
      const balance = await client.getAccountBalance();
      return ok(balance);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  });

  server.tool("hl_list_markets", "List all tradeable assets on Hyperliquid", {}, async () => {
    if (!client) return err(NOT_CONFIGURED);
    try {
      const assets = client.getAvailableAssets();
      return ok(assets);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  });

  server.tool(
    "hl_get_market_data",
    "Get market data for an asset (mid price, candles)",
    {
      coin: z.string().min(1).max(20).describe("Ticker"),
      interval: z.string().max(10).optional().default("5m").describe("Candle interval"),
      candle_count: z
        .number()
        .positive()
        .max(500)
        .optional()
        .default(20)
        .describe("Number of candles (max 500)"),
    },
    async (params) => {
      if (!client) return err(NOT_CONFIGURED);
      try {
        const [mid, candles] = await Promise.all([
          client.getMidPrice(params.coin),
          client.getCandles(params.coin, params.interval, params.candle_count),
        ]);
        return ok({ coin: params.coin, midPrice: mid, candles });
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    }
  );
}
