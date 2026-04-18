import axios, { type AxiosInstance } from "axios";
import http from "http";
import https from "https";
import * as output from "./output.js";
import { openUrl } from "./open.js";
import { readConfig, writeConfig, type AgentEntry } from "./config.js";
import client from "./client.js";
import { isSessionTokenLocallyFresh } from "./session-token.js";

function authBaseUrl(): string {
  if (process.env.YOSO_AUTH_URL?.trim()) {
    return process.env.YOSO_AUTH_URL.trim().replace(/\/$/, "");
  }

  if (process.env.YOSO_API_URL?.trim()) {
    return process.env.YOSO_API_URL.trim()
      .replace(/\/api\/?$/, "")
      .replace(/\/$/, "");
  }

  return "https://yoso.bet";
}

export interface AuthUrlResponse {
  authUrl: string;
  requestId: string;
}

export interface AuthStatusResponse {
  token: string;
}

/** Returned by list agents - no API key (never exposed after creation). */
export interface AgentInfoResponse {
  id: string;
  name: string;
  walletAddress: string;
}

/** Returned by create agent - API key + wallet private key shown once. */
export interface AgentKeyResponse {
  id: string;
  name: string;
  apiKey: string;
  walletAddress: string;
  walletPrivateKey: string;
}

/** Returned by regenerate - fresh API key for an existing agent. */
export interface RegenerateKeyResponse {
  apiKey: string;
}

function createAuthClient(sessionToken?: string | null): AxiosInstance {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (sessionToken) {
    headers.Authorization = `Bearer ${sessionToken}`;
  }

  return axios.create({
    baseURL: authBaseUrl(),
    headers,
    proxy: false,
    httpAgent: new http.Agent({ family: 4 }),
    httpsAgent: new https.Agent({ family: 4 }),
  });
}

export function getValidSessionToken(): string | null {
  const config = readConfig();
  const token = config?.SESSION_TOKEN?.token;
  if (!token) return null;

  return isSessionTokenLocallyFresh(token) ? token : null;
}

function storeSessionToken(token: string): void {
  const config = readConfig();
  writeConfig({ ...config, SESSION_TOKEN: { token } });
}

async function getAuthUrl(): Promise<AuthUrlResponse> {
  const { data } = await createAuthClient().get<{ data: AuthUrlResponse }>(
    "/api/auth/lite/auth-url"
  );
  return data.data;
}

async function getAuthStatus(requestId: string): Promise<AuthStatusResponse | null> {
  const { data } = await createAuthClient().get<{ data: AuthStatusResponse }>(
    `/api/auth/lite/auth-status?requestId=${requestId}`
  );
  return data?.data ?? null;
}

/** Fetch all agents belonging to the authenticated user. No API keys returned. */
export async function fetchAgents(sessionToken: string): Promise<AgentInfoResponse[]> {
  const { data } = await createAuthClient(sessionToken).get<{
    data: AgentInfoResponse[];
  }>("/api/agents/lite");
  return data.data;
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

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Create agent response did not include ${field}.`);
  }
  return value;
}

/** Create a new agent for the authenticated user. API key + wallet private key returned once. */
export async function createAgentApi(
  sessionToken: string | null,
  agentName: string
): Promise<AgentKeyResponse> {
  const { data } = await createAuthClient(sessionToken).post<CreateAgentApiResponse>(
    "/api/agents/register",
    { name: agentName.trim() }
  );
  const agent = data.agent;
  return {
    id: requireString(agent?.id, "agent.id"),
    name: requireString(agent?.name, "agent.name"),
    walletAddress: requireString(agent?.walletAddress, "agent.walletAddress"),
    apiKey: requireString(data.apiKey, "apiKey"),
    walletPrivateKey: requireString(data.walletPrivateKey, "walletPrivateKey"),
  };
}

export async function regenerateApiKey(
  _sessionToken: string | null,
  walletAddress: string
): Promise<RegenerateKeyResponse> {
  const config = readConfig();
  const agentKey = config.agents?.find(
    (a) => a.walletAddress.toLowerCase() === walletAddress.toLowerCase()
  )?.apiKey;
  const apiKey = agentKey || config.YOSO_AGENT_API_KEY;
  if (!apiKey) {
    throw new Error("No saved API key for this agent. Re-run setup or create a new agent.");
  }

  const { data } = await createAuthClient().post<{
    data?: RegenerateKeyResponse;
    apiKey?: string;
  }>(
    "/api/agents/register/regenerate",
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

/** How often to poll the auth status endpoint (ms). */
const AUTH_POLL_INTERVAL_MS = 5_000;

/** How long to wait for the user to authenticate before timing out (ms). */
const AUTH_TIMEOUT_MS = 5 * 60 * 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollForSessionToken(requestId: string): Promise<string | null> {
  const deadline = Date.now() + AUTH_TIMEOUT_MS;
  let elapsed = 0;

  while (Date.now() < deadline) {
    await sleep(AUTH_POLL_INTERVAL_MS);
    elapsed += AUTH_POLL_INTERVAL_MS;

    let status: AuthStatusResponse | null = null;
    try {
      status = await getAuthStatus(requestId);
    } catch {
      // Auth not ready yet or transient error - keep polling
    }
    if (status?.token) {
      storeSessionToken(status.token);
      return status.token;
    }

    // Progress indicator every 15s (3 polls)
    if (elapsed % 15_000 === 0) {
      const remaining = Math.round((deadline - Date.now()) / 1_000);
      output.log(`  Still waiting... (${remaining}s remaining)`);
    }
  }

  return null;
}

async function openAuthRequest(): Promise<AuthUrlResponse> {
  const auth = await getAuthUrl();
  const { authUrl, requestId } = auth;
  openUrl(authUrl);

  output.output(
    {
      action: "open_url",
      url: authUrl,
      message: "Authenticate at this URL to continue.",
    },
    () => {
      output.log(`  Opening browser...`);
      output.log(`  Login link: ${authUrl}\n`);
      output.log(`  Waiting for authentication (timeout: ${AUTH_TIMEOUT_MS / 1_000}s)...\n`);
    }
  );

  return { authUrl, requestId };
}

/**
 * Login flow. Opens browser / prints link, then polls until authenticated
 * or timed out. No stdin interaction required - works in any runtime.
 */
export async function interactiveLogin(): Promise<void> {
  let auth: AuthUrlResponse;
  try {
    auth = await openAuthRequest();
  } catch (e) {
    output.fatal(`Could not get login link: ${e instanceof Error ? e.message : String(e)}`);
  }
  const token = await pollForSessionToken(auth.requestId);
  if (!token) {
    output.fatal(
      `Authentication timed out after ${AUTH_TIMEOUT_MS / 1_000}s. Run \`yoso-agent login\` to try again.`
    );
  }

  output.output(
    {
      status: "authenticated",
      message: "Login success. Session stored.",
    },
    () => output.success("Login success. Session stored.\n")
  );
}

/** Start browser auth when available; return null when setup can continue without it. */
export async function ensureSessionIfAvailable(): Promise<string | null> {
  const existing = getValidSessionToken();
  if (existing) return existing;

  let auth: AuthUrlResponse;
  try {
    auth = await openAuthRequest();
  } catch (e) {
    output.warn(
      `Browser login is unavailable (${e instanceof Error ? e.message : String(e)}). ` +
        "Continuing with direct agent registration.\n"
    );
    return null;
  }

  const token = await pollForSessionToken(auth.requestId);
  if (token) {
    output.output(
      {
        status: "authenticated",
        message: "Login success. Session stored.",
      },
      () => output.success("Login success. Session stored.\n")
    );
    return token;
  }

  output.warn("Authentication timed out. Continuing with direct agent registration.\n");
  return null;
}

/**
 * Merge server agents into local config. Returns the merged list.
 * Server does NOT return API keys - only id, name, walletAddress.
 * Local API keys (from create/regenerate) are preserved.
 */
export function syncAgentsToConfig(serverAgents: AgentInfoResponse[]): AgentEntry[] {
  const config = readConfig();
  const localAgents = config.agents ?? [];

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
      apiKey: local?.apiKey, // preserve local key if we have one
      active: local?.active ?? false,
    };
  });

  writeConfig({ ...config, agents: merged });
  return merged;
}
