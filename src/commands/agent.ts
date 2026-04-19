import readline from "readline";
import * as output from "../lib/output.js";
import {
  readConfig,
  writeConfig,
  getActiveAgent,
  findAgentByName,
  activateAgent,
  findSellerPid,
  isProcessRunning,
  removePidFromConfig,
  type AgentEntry,
  findAgentByWalletAddress,
} from "../lib/config.js";
import { createAgentApi, regenerateApiKey, isAgentApiKeyValid } from "../lib/auth.js";
import { hasEnvModeAgent } from "../lib/env-file.js";
import { assertSecretsNotTracked } from "../lib/git-guard.js";
import { storeAgentKey, preflightStorage } from "../lib/wallet-storage.js";
import { ROOT } from "../lib/paths.js";

function redactApiKey(key: string | undefined): string {
  if (!key || key.length < 8) return "(not available)";
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

function confirmPrompt(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      resolve(a === "y" || a === "yes" || a === "");
    });
  });
}

async function killSellerProcess(pid: number): Promise<boolean> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return false;
  }
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (!isProcessRunning(pid)) {
      removePidFromConfig();
      return true;
    }
  }
  return false;
}

/**
 * Check if seller runtime is running. If so, warn the user and ask for
 * confirmation to stop it. Returns true if it's safe to proceed (no seller
 * running, or seller was stopped). Returns false if the user cancelled.
 * Calls output.fatal (exits) if the seller could not be killed.
 */
export async function stopSellerIfRunning(): Promise<boolean> {
  const sellerPid = findSellerPid();
  if (sellerPid === undefined) return true;

  const active = getActiveAgent();
  const activeName = active ? `"${active.name}"` : "the current agent";

  let offeringNames: string[] = [];
  try {
    const { getMyAgentInfo } = await import("../lib/wallet.js");
    const info = await getMyAgentInfo();
    offeringNames = (info.jobs ?? []).map((job) => job.name);
  } catch {
    // Non-fatal - just won't show offering names
  }

  const offeringsLine =
    offeringNames.length > 0
      ? `\n  Active Job Offerings being served: ${offeringNames.join(", ")}\n`
      : "";
  output.warn(
    `Seller runtime process is running (PID ${sellerPid}) for ${activeName}. ` +
      `It must be stopped before switching agents, because the runtime ` +
      `is tied to the current agent's API key.${offeringsLine}\n`
  );
  const ok = await confirmPrompt("  Stop the seller runtime process and continue? (Y/n): ");
  if (!ok) {
    return false;
  }
  output.log(`  Stopping seller runtime (PID ${sellerPid})...`);
  const stopped = await killSellerProcess(sellerPid);
  if (stopped) {
    output.log(`  Seller runtime stopped.\n`);
    return true;
  }
  output.fatal(`Could not stop seller process (PID ${sellerPid}). Try: kill -9 ${sellerPid}`);
  return false; // unreachable (fatal exits), but satisfies TS
}

function displayAgents(agents: AgentEntry[]): void {
  output.heading("Agents");
  for (const a of agents) {
    const marker = a.active ? output.colors.green(" (active)") : "";
    output.log(`  ${output.colors.bold(a.name)}${marker}`);
    output.log(`    ${output.colors.dim("Wallet")}  ${a.walletAddress}`);
    if (a.apiKey) {
      output.log(`    ${output.colors.dim("API Key")} ${redactApiKey(a.apiKey)}`);
    }
    output.log("");
  }
}

export async function list(): Promise<void> {
  // Local config is authoritative — no server-side agent list endpoint.
  const agents: AgentEntry[] = readConfig().agents ?? [];

  if (agents.length === 0) {
    output.output({ agents: [] }, () => {
      output.log("  No agents found. Run `yoso-agent agent create <name>` to create one.\n");
    });
    return;
  }

  output.output(
    agents.map((a) => ({
      name: a.name,
      id: a.id,
      walletAddress: a.walletAddress,
      active: a.active,
    })),
    () => displayAgents(agents)
  );
}

export async function switchAgentByName(name: string): Promise<void> {
  const target = findAgentByName(name);
  if (!target) {
    output.fatal(`Agent "${name}" not found. Run \`yoso-agent agent list\` first.`);
  }

  const agents = readConfig().agents ?? [];
  const matchingAgents = agents.filter((a) => a.name.toLowerCase() === name.toLowerCase());
  if (matchingAgents.length > 1) {
    output.fatal(
      `Multiple agents with name "${name}".\nAvailable: ${matchingAgents
        .map((a) => `${a.name} (${a.walletAddress})`)
        .join(
          ", "
        )}.\nRun \`yoso-agent agent switch --wallet <walletAddress>\` to switch to one of them.`
    );
  }

  return await switchAgent(target.walletAddress);
}

export async function switchAgent(walletAddress: string): Promise<void> {
  if (!walletAddress) {
    output.fatal("Usage: yoso-agent agent switch <walletAddress>");
  }

  if (hasEnvModeAgent(ROOT)) {
    output.fatal(
      "`agent switch` is not supported in env mode. Switching would overwrite " +
        "AGENT_PRIVATE_KEY and make the current agent unrecoverable. " +
        "Use --keystore mode for multi-agent storage in one directory, or cd to " +
        "each agent's original directory."
    );
  }

  const target = findAgentByWalletAddress(walletAddress);
  if (!target) {
    const config = readConfig();
    const agentList = (config.agents ?? []).map((a) => `${a.name} (${a.walletAddress})`).join(", ");
    output.fatal(
      `Agent "${walletAddress}" not found. Run \`yoso-agent agent list\` first. Available: ${
        agentList || "(none)"
      }`
    );
  }

  if (target.active) {
    output.log(`  Agent ${target.name} is already active.\n`);
    return;
  }

  // Stop seller runtime if running (API key will change)
  const proceed = await stopSellerIfRunning();
  if (!proceed) {
    output.log("  Agent switch cancelled.\n");
    throw new Error("Agent switch cancelled");
  }

  output.log(`  Switching to ${target.name}...\n`);
  try {
    let apiKey: string = "";
    let valid = false;

    if (target.apiKey) {
      valid = await isAgentApiKeyValid(target.apiKey);
      if (valid) {
        apiKey = target.apiKey;
      }
    }

    if (!valid) {
      const result = await regenerateApiKey(target.walletAddress);
      apiKey = result.apiKey;
    }

    if (!apiKey) {
      output.fatal("Failed to switch agent - no API key returned.");
    }

    activateAgent(target.id, apiKey);

    output.output(
      {
        switched: true,
        name: target.name,
        walletAddress: target.walletAddress,
      },
      () => {
        output.success(`Switched to agent: ${target.name}`);
        output.log(`    Wallet:  ${target.walletAddress}`);
      }
    );
  } catch (e) {
    output.fatal(`Failed to switch agent: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export interface CreateOptions {
  useKeystore?: boolean;
}

export async function create(name: string, options: CreateOptions = {}): Promise<void> {
  if (!name) {
    output.fatal("Usage: yoso-agent agent create <name>");
  }

  const useKeystore = options.useKeystore ?? false;

  if (!useKeystore) {
    try {
      assertSecretsNotTracked(ROOT, [".env", "config.json"]);
      if (hasEnvModeAgent(ROOT)) {
        throw new Error(
          "This directory already has an env-mode agent. `agent create` here would " +
            "overwrite AGENT_PRIVATE_KEY and make the current agent unrecoverable. " +
            "Create the new agent in a separate directory, or use --keystore mode " +
            "for multi-agent storage here."
        );
      }
    } catch (e) {
      output.fatal(e instanceof Error ? e.message : String(e));
    }
  }

  try {
    preflightStorage(ROOT);
  } catch (e) {
    output.fatal(e instanceof Error ? e.message : String(e));
  }

  // Stop seller runtime if running (API key will change)
  const proceed = await stopSellerIfRunning();
  if (!proceed) {
    output.log("  Agent creation cancelled.\n");
    return;
  }

  try {
    const result = await createAgentApi(name);
    if (!result?.apiKey) {
      output.fatal("Create agent failed - no API key returned.");
    }

    const stored = await storeAgentKey({
      root: ROOT,
      privateKey: result.walletPrivateKey,
      walletAddress: result.walletAddress,
      apiKey: result.apiKey,
      useKeystore,
      warn: (msg) => output.warn(msg),
    });

    // Add to local config and activate
    const config = readConfig();
    const updatedAgents = (config.agents ?? []).map((a) => ({
      ...a,
      active: false,
      apiKey: undefined, // clear other agents' keys
    })) as AgentEntry[];

    const newAgent: AgentEntry = {
      id: result.id,
      name: result.name || name,
      walletAddress: result.walletAddress,
      apiKey: result.apiKey,
      active: true,
    };
    updatedAgents.push(newAgent);

    writeConfig({
      ...config,
      YOSO_AGENT_API_KEY: result.apiKey,
      agents: updatedAgents,
    });

    output.output(
      {
        created: true,
        name: newAgent.name,
        id: newAgent.id,
        walletAddress: newAgent.walletAddress,
        keystorePath: stored.mode === "keystore" ? stored.metadata.path : undefined,
        envPath: stored.mode === "env" ? stored.envPath : undefined,
        signingKey: stored.mode === "env" ? "AGENT_PRIVATE_KEY" : undefined,
      },
      () => {
        output.success(`Agent created: ${newAgent.name}`);
        output.log(`    Wallet:  ${newAgent.walletAddress}`);
        output.log(`    API Key: ${redactApiKey(newAgent.apiKey)}`);
        if (stored.mode === "keystore") {
          output.log(`    Keystore: ${stored.metadata.path}`);
          output.log(
            "    Wallet key encrypted locally. Losing the keystore password means the encrypted key cannot be recovered."
          );
        } else {
          output.log(`    Env file: ${stored.envPath}`);
          output.log(
            "    AGENT_PRIVATE_KEY saved to .env (gitignored). Keep the file off version control and out of logs."
          );
        }
      }
    );
  } catch (e) {
    output.fatal(`Create agent failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
