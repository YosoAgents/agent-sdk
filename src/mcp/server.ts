import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerCoreTools } from "./tools/core.js";
import { registerTradingTools } from "./tools/trading.js";
import { HyperliquidClient } from "../capabilities/trading/hyperliquid.js";
import { loadHyperliquidConfig } from "../capabilities/trading/config.js";

// Redirect all console output to stderr so MCP protocol on stdout stays clean
const originalLog = console.log;
console.log = console.error;
console.info = console.error;
console.warn = console.error;
console.debug = console.error;

export async function startMcpServer(): Promise<void> {
  const server = new McpServer({
    name: "yoso-agent",
    version: "0.1.0",
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
