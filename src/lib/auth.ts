import { Wallet } from "ethers";
import { randomUUID } from "node:crypto";
import * as output from "./output.js";
import { readConfig, writeConfig, type AgentEntry } from "./config.js";
import client from "./client.js";

/**
 * v0.3.0 register flow:
 *   - Wallet generated client-side. Server never sees the private key.
 *   - SDK signs a canonical EIP-191 message proving ownership of the claimed address.
 *   - Server atomically claims the nonce (Redis SET NX EX) and verifies the sig.
 *   - Response includes only `{agent, apiKey}`. The SDK keeps the private key locally.
 *
 * The previous session-based browser-auth flow (`/api/auth/lite/*`, `/api/agents/lite`)
 * was never implemented server-side. Those code paths are removed in 0.3.0.
 */

export interface AgentInfoResponse {
  id: string;
  name: string;
  walletAddress: string;
}

export interface AgentKeyResponse {
  id: string;
  name: string;
  apiKey: string;
  walletAddress: string;
  walletPrivateKey: string;
}

export interface RegenerateKeyResponse {
  apiKey: string;
}

function canonicalAudience(): string {
  return (process.env.YOSO_CANONICAL_AUDIENCE ?? "yoso.bet").trim();
}

function buildCanonicalMessage(walletAddressLower: string, nonce: string, iat: string): string {
  return [
    "yoso agent registration",
    `audience: ${canonicalAudience()}`,
    `chainId: 999`,
    `address: ${walletAddressLower}`,
    `nonce: ${nonce}`,
    `iat: ${iat}`,
  ].join("\n");
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Create agent response did not include ${field}.`);
  }
  return value;
}

interface CreateAgentApiResponse {
  agent?: {
    id?: unknown;
    name?: unknown;
    walletAddress?: unknown;
  };
  apiKey?: unknown;
  // Defense: reject responses that still carry this legacy field.
  walletPrivateKey?: unknown;
}

/**
 * Create a new agent. SDK 0.3.0+ generates the wallet locally, signs the canonical
 * registration message, and posts only the public address + signature to the server.
 */
export async function createAgentApi(agentName: string): Promise<AgentKeyResponse> {
  const trimmedName = agentName.trim();
  if (!trimmedName) {
    throw new Error("Agent name must be a non-empty string.");
  }

  const wallet = Wallet.createRandom();
  const walletAddress = wallet.address.toLowerCase();
  const nonce = randomUUID();
  const iat = new Date().toISOString();
  const message = buildCanonicalMessage(walletAddress, nonce, iat);
  const signature = await wallet.signMessage(message);

  const { data } = await client.post<CreateAgentApiResponse>("/agents/register", {
    name: trimmedName,
    walletAddress,
    message,
    signature,
  });

  // Split-brain defense: server MUST echo the address we claimed.
  const serverWallet = (data.agent?.walletAddress ?? "") as string;
  if (typeof serverWallet !== "string" || serverWallet.toLowerCase() !== walletAddress) {
    throw new Error(
      `Server returned wallet ${serverWallet || "(missing)"}, expected ${walletAddress}. ` +
        `Likely an SDK/server version mismatch — upgrade both or contact support.`
    );
  }

  // Legacy response-shape defense: a 0.2.x-era backend shouldn't echo walletPrivateKey
  // back to us any more. If it does, refuse to continue — something is very wrong.
  if (data.walletPrivateKey !== undefined) {
    throw new Error(
      "Server returned a walletPrivateKey, which is forbidden in the new flow. " +
        "Refusing to continue — server is on an old/legacy code path."
    );
  }

  return {
    id: requireString(data.agent?.id, "agent.id"),
    name: requireString(data.agent?.name, "agent.name"),
    walletAddress,
    apiKey: requireString(data.apiKey, "apiKey"),
    walletPrivateKey: wallet.privateKey,
  };
}

export async function regenerateApiKey(walletAddress: string): Promise<RegenerateKeyResponse> {
  const config = readConfig();
  const agentKey = config.agents?.find(
    (a) => a.walletAddress.toLowerCase() === walletAddress.toLowerCase()
  )?.apiKey;
  const apiKey = agentKey || config.YOSO_AGENT_API_KEY;
  if (!apiKey) {
    throw new Error("No saved API key for this agent. Re-run setup or create a new agent.");
  }

  const { data } = await client.post<{
    data?: RegenerateKeyResponse;
    apiKey?: string;
  }>(
    "/agents/register/regenerate",
    {},
    {
      headers: {
        "x-api-key": apiKey,
      },
    }
  );
  const key = data.data?.apiKey ?? data.apiKey;
  if (!key) {
    throw new Error("Regenerate API key response did not include apiKey.");
  }
  return { apiKey: key };
}

export async function isAgentApiKeyValid(apiKey: string): Promise<boolean> {
  return await client
    .get("/agents/me", {
      headers: {
        "x-api-key": apiKey,
      },
    })
    .then(() => true)
    .catch(() => false);
}

/**
 * Session-based agent list was served by `/api/agents/lite`, an endpoint that was never
 * implemented server-side. In 0.3.0 the SDK is key-based only — no session tokens.
 *
 * Kept as a graceful no-op so `agent list` / `setup` don't crash. Local `config.agents`
 * is authoritative until the server exposes a key-based equivalent in a future release.
 */
export async function fetchAgents(): Promise<AgentInfoResponse[]> {
  return [];
}

/**
 * No-op kept for backward compatibility with `yoso-agent login`. The browser auth
 * endpoints were never implemented. Users should run `yoso-agent setup` instead.
 */
export async function interactiveLogin(): Promise<void> {
  output.log("  `yoso-agent login` is a no-op in 0.3.0.");
  output.log("  Browser-based auth is not available; the SDK is key-based.\n");
  output.log("  Run `yoso-agent setup --name <name> --yes` to create a new agent.\n");
}

/**
 * Always returns null in 0.3.0 (no session tokens). Callers fall back to local
 * config and direct key-based API calls.
 */
export function getValidSessionToken(): null {
  return null;
}

/**
 * Merge server agents into local config. Returns the merged list.
 * In 0.3.0 `fetchAgents` always returns [], so this is effectively a pass-through
 * of local config. Kept to minimize churn in callers until 0.4.0.
 */
export function syncAgentsToConfig(serverAgents: AgentInfoResponse[]): AgentEntry[] {
  const config = readConfig();
  const localAgents = config.agents ?? [];

  if (serverAgents.length === 0) {
    return localAgents;
  }

  const localMap = new Map<string, AgentEntry>();
  for (const a of localAgents) {
    localMap.set(a.id, a);
  }

  const merged: AgentEntry[] = serverAgents.map((s) => {
    const local = localMap.get(s.id);
    return {
      id: s.id,
      name: s.name,
      walletAddress: s.walletAddress,
      apiKey: local?.apiKey,
      active: local?.active ?? false,
    };
  });

  writeConfig({ ...config, agents: merged });
  return merged;
}
