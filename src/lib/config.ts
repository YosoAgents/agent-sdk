import { execSync } from "child_process";
import * as fs from "fs";
import { CONFIG_JSON_PATH, LOGS_DIR, ROOT, SDK_ROOT } from "./paths.js";
import { assertNoPlaintextPrivateKeys } from "./keystore.js";

export { LOGS_DIR, ROOT, SDK_ROOT };

export interface AgentEntry {
  id: string;
  name: string;
  walletAddress: string;
  apiKey: string | undefined; // only present for active/previously-switched agents
  active: boolean;
}

export interface ConfigJson {
  SESSION_TOKEN?: {
    token: string;
  };
  YOSO_AGENT_API_KEY?: string;
  SELLER_PID?: number;
  agents?: AgentEntry[];
}

export function readConfig(): ConfigJson {
  if (!fs.existsSync(CONFIG_JSON_PATH)) {
    return {};
  }
  const content = fs.readFileSync(CONFIG_JSON_PATH, "utf-8");
  let config: unknown;
  try {
    config = JSON.parse(content);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse config.json at ${CONFIG_JSON_PATH}: ${msg}`);
  }
  assertNoPlaintextPrivateKeys(config);
  return config as ConfigJson;
}

export function writeConfig(config: ConfigJson): void {
  assertNoPlaintextPrivateKeys(config);
  fs.writeFileSync(CONFIG_JSON_PATH, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}

export function loadApiKey(): string | undefined {
  if (process.env.YOSO_AGENT_API_KEY?.trim()) {
    return process.env.YOSO_AGENT_API_KEY.trim();
  }
  const config = readConfig();
  const key = config.YOSO_AGENT_API_KEY;
  if (typeof key === "string" && key.trim()) {
    process.env.YOSO_AGENT_API_KEY = key;
    return key;
  }
  return undefined;
}

export function requireApiKey(): string {
  const key = loadApiKey();
  if (!key) {
    console.error("Error: YOSO_AGENT_API_KEY is not set. Run `yoso-agent setup` first.");
    process.exit(1);
  }
  return key;
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return !(err && typeof err === "object" && "code" in err && err.code === "ESRCH");
  }
}

export function writePidToConfig(pid: number): void {
  const config = readConfig();
  config.SELLER_PID = pid;
  writeConfig(config);
}

export function removePidFromConfig(): void {
  const config = readConfig();
  if (config.SELLER_PID !== undefined) {
    delete config.SELLER_PID;
    writeConfig(config);
  }
}

export function checkForExistingProcess(): void {
  const config = readConfig();

  if (config.SELLER_PID !== undefined) {
    if (isProcessRunning(config.SELLER_PID)) {
      console.error(`Seller process already running with PID: ${config.SELLER_PID}`);
      console.error("Please stop the existing process before starting a new one.");
      process.exit(1);
    } else {
      removePidFromConfig();
    }
  }
}

// Find the PID of a running seller process.
export function findSellerPid(): number | undefined {
  const config = readConfig();
  if (config.SELLER_PID !== undefined && isProcessRunning(config.SELLER_PID)) {
    return config.SELLER_PID;
  }
  if (config.SELLER_PID !== undefined) {
    removePidFromConfig();
  }
  try {
    const out = execSync(
      'ps ax -o pid,command | grep -E "seller/runtime/seller\\.(ts|js)" | grep -v grep',
      {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    for (const line of out.trim().split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const pid = parseInt(trimmed.split(/\s+/)[0], 10);
      if (!isNaN(pid) && pid !== process.pid) return pid;
    }
  } catch {
    // grep returns exit code 1 when no matches
  }
  return undefined;
}

export function getActiveAgent(): AgentEntry | undefined {
  const config = readConfig();
  return config.agents?.find((a) => a.active);
}

export function findAgentByName(name: string): AgentEntry | undefined {
  const config = readConfig();
  return config.agents?.find((a) => a.name.toLowerCase() === name.toLowerCase());
}

export function findAgentByWalletAddress(walletAddress: string): AgentEntry | undefined {
  const config = readConfig();
  return config.agents?.find((a) => a.walletAddress.toLowerCase() === walletAddress.toLowerCase());
}

// Activate an agent with a (possibly new) API key. Updates active flags and YOSO_AGENT_API_KEY.
export function activateAgent(agentId: string, apiKey: string): void {
  const config = readConfig();
  const agents = (config.agents ?? []).map((a) => ({
    ...a,
    active: a.id === agentId,
    apiKey: a.id === agentId ? apiKey : a.apiKey,
  }));

  writeConfig({
    ...config,
    agents,
    YOSO_AGENT_API_KEY: apiKey,
  });
}

export function sanitizeAgentName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

export function formatPrice(price: unknown, priceType?: unknown): string {
  const p = price != null ? String(price) : "-";
  const type = String(priceType).toLowerCase();
  if (type === "fixed") {
    return `${p} USDC`;
  } else if (type === "percentage") {
    // Percentage is stored as decimal
    const numPrice = typeof price === "number" ? price : parseFloat(p);
    if (!isNaN(numPrice)) {
      return `${(numPrice * 100).toFixed(2)}%`;
    }
    return `${p}%`;
  } else if (priceType != null) {
    return `${p} ${priceType}`;
  }
  return p;
}
