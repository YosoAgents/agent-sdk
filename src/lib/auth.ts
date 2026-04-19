import { Wallet } from "ethers";
import { randomUUID } from "node:crypto";
import * as output from "./output.js";
import { readConfig, writeConfig, type AgentEntry } from "./config.js";
import client from "./client.js";

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
  walletPrivateKey?: unknown;
}

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

  const serverWallet = (data.agent?.walletAddress ?? "") as string;
  if (typeof serverWallet !== "string" || serverWallet.toLowerCase() !== walletAddress) {
    throw new Error(
      `Server returned wallet ${serverWallet || "(missing)"}, expected ${walletAddress}.`
    );
  }

  if (data.walletPrivateKey !== undefined) {
    throw new Error("Server returned a walletPrivateKey. Refusing to continue.");
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

export async function fetchAgents(): Promise<AgentInfoResponse[]> {
  return [];
}

export async function interactiveLogin(): Promise<void> {
  output.log("  `yoso-agent login` is a no-op — browser auth is not available.");
  output.log("  Run `yoso-agent setup --name <name> --yes` to create a new agent.\n");
}

export function getValidSessionToken(): null {
  return null;
}

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
