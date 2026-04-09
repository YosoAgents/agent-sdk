import type {
  OfferingHandlers,
  ExecuteJobResult,
  ValidationResult,
} from "../../seller/runtime/offeringTypes.js";
import type { HyperliquidClient } from "./hyperliquid.js";

const VALID_ACTIONS = [
  "place_limit_order",
  "place_market_order",
  "place_post_only_order",
  "place_bracket_order",
  "cancel_order",
  "cancel_all_orders",
  "close_position",
  "get_positions",
  "get_balance",
  "get_fills",
  "get_market_data",
  "list_markets",
] as const;

export function createTradingHandlers(client: HyperliquidClient): OfferingHandlers {
  return {
    validateRequirements: (request: Record<string, any>): ValidationResult => {
      const action = request.action;
      if (!action || !VALID_ACTIONS.includes(action)) {
        return {
          valid: false,
          reason: `Unknown action: ${action}. Valid: ${VALID_ACTIONS.join(", ")}`,
        };
      }
      return true;
    },

    executeJob: async (request: Record<string, any>): Promise<ExecuteJobResult> => {
      const { action, params = {} } = request;

      switch (action) {
        case "place_limit_order": {
          const result = await client.placeLimitOrder(
            params.coin,
            params.isBuy,
            params.price,
            params.sizeUsd,
            params.reduceOnly
          );
          return { deliverable: { type: "order", value: result } };
        }
        case "place_market_order": {
          const result = await client.placeMarketOrder(params.coin, params.isBuy, params.sizeUsd);
          return { deliverable: { type: "order", value: result } };
        }
        case "place_post_only_order": {
          const result = await client.placePostOnlyOrder(
            params.coin,
            params.isBuy,
            params.price,
            params.sizeUsd,
            params.reduceOnly
          );
          return { deliverable: { type: "order", value: result } };
        }
        case "place_bracket_order": {
          const result = await client.placeBracketOrder(params);
          return { deliverable: { type: "bracket_order", value: result } };
        }
        case "cancel_order": {
          const result = await client.cancelOrder(params.coin, params.orderId);
          return { deliverable: { type: "cancel", value: result } };
        }
        case "cancel_all_orders": {
          const result = await client.cancelAllOrders(params.coin);
          return { deliverable: { type: "cancel_all", value: result } };
        }
        case "close_position": {
          const result = await client.closePosition(params.coin);
          return { deliverable: { type: "close", value: result } };
        }
        case "get_positions": {
          const positions = await client.getOpenPositions();
          return { deliverable: { type: "positions", value: positions } };
        }
        case "get_balance": {
          const balance = await client.getAccountBalance();
          return { deliverable: { type: "balance", value: balance } };
        }
        case "get_fills": {
          const fills = await client.getFills(params.hoursBack);
          return { deliverable: { type: "fills", value: fills } };
        }
        case "get_market_data": {
          const [mid, candles] = await Promise.all([
            client.getMidPrice(params.coin),
            client.getCandles(params.coin, params.interval, params.count),
          ]);
          return { deliverable: { type: "market_data", value: { midPrice: mid, candles } } };
        }
        case "list_markets": {
          const assets = client.getAvailableAssets();
          return { deliverable: { type: "markets", value: assets } };
        }
        default:
          return { deliverable: `Unknown action: ${action}` };
      }
    },
  };
}
