import { readFileSync } from "fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerCoreTools } from "./tools/core.js";
import { registerTradingTools } from "./tools/trading.js";
import { HyperliquidClient } from "../capabilities/trading/hyperliquid.js";
import { loadHyperliquidConfig } from "../capabilities/trading/config.js";

const SERVER_VERSION = (() => {
  for (const rel of ["../../package.json", "../../../package.json"]) {
    try {
      return JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf-8")).version as string;
    } catch {}
  }
  return "0.0.0";
})();

export async function startMcpServer(): Promise<void> {
  // MCP protocol runs on stdout; redirect any stray console.* to stderr so it
  // doesn't corrupt the JSON-RPC stream. Scoped to this function so importing
  // this module (e.g. from a test harness) doesn't mutate global console state.
  console.log = console.error;
  console.info = console.error;
  console.warn = console.error;
  console.debug = console.error;

  const server = new McpServer({
    name: "yoso-agent",
    version: SERVER_VERSION,
  });

  // Initialize Hyperliquid client if configured
  let hlClient: HyperliquidClient | null = null;
  try {
    const hlConfig = loadHyperliquidConfig();
    if (hlConfig) {
      hlClient = new HyperliquidClient(hlConfig);
      await hlClient.initialize();
      console.error("[mcp] Hyperliquid client initialized");
    }
  } catch (e) {
    console.error("[mcp] Hyperliquid not configured:", e instanceof Error ? e.message : e);
  }

  // Register tools
  registerCoreTools(server);
  registerTradingTools(server, hlClient);

  // Connect via stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mcp] YOSO Agent MCP server running on stdio");
}
