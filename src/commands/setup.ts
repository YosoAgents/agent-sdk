import readline from "readline";
import * as output from "../lib/output.js";
import { readConfig, writeConfig, type AgentEntry } from "../lib/config.js";
import { ROOT } from "../lib/paths.js";
import { hasEnvModeAgent } from "../lib/env-file.js";
import { assertSecretsNotTracked } from "../lib/git-guard.js";
import { storeAgentKey } from "../lib/wallet-storage.js";
import {
  ensureSessionIfAvailable,
  interactiveLogin,
  fetchAgents,
  createAgentApi,
  syncAgentsToConfig,
  type AgentInfoResponse,
} from "../lib/auth.js";
import { stopSellerIfRunning, switchAgent } from "./agent.js";

export interface SetupOptions {
  agentName?: string;
  skipSystemPrompt?: boolean;
  useKeystore?: boolean;
}

function question(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

function redactApiKey(key: string): string {
  if (!key || key.length < 8) return "****";
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

function preflightEnvMode(): void {
  // Refuse if the existing .env or config.json would leak secrets when written.
  assertSecretsNotTracked(ROOT, [".env", "config.json"]);

  // Refuse if switching in env mode would silently lose the current agent's key.
  if (hasEnvModeAgent(ROOT)) {
    throw new Error(
      "This directory already has an env-mode agent. Switching would overwrite " +
        "AGENT_PRIVATE_KEY and make the current agent unrecoverable. " +
        "Options: reuse this agent, create the new agent in a separate directory, " +
        "or use --keystore mode for multi-agent storage here."
    );
  }
}

async function createAndActivateAgent(
  sessionToken: string | null,
  agentName: string,
  useKeystore: boolean
): Promise<boolean> {
  const trimmedName = agentName.trim();
  if (!trimmedName) {
    output.log("  No name entered. Skipping agent creation.\n");
    return false;
  }

  if (!useKeystore) {
    try {
      preflightEnvMode();
    } catch (e) {
      output.error(e instanceof Error ? e.message : String(e));
      return false;
    }
  }

  try {
    const result = await createAgentApi(sessionToken, trimmedName);
    if (!result?.apiKey) {
      output.error("Create agent failed — no API key returned.");
      return false;
    }
    const storedWalletKey = await storeAgentKey({
      root: ROOT,
      privateKey: result.walletPrivateKey,
      walletAddress: result.walletAddress,
      apiKey: result.apiKey,
      useKeystore,
      warn: (msg) => output.warn(msg),
    });

    const config = readConfig();
    const updatedAgents = (config.agents ?? []).map(
      (a) =>
        ({
          ...a,
          active: false,
          apiKey: undefined,
        }) as AgentEntry
    );
    const newAgent: AgentEntry = {
      id: result.id,
      name: result.name || trimmedName,
      walletAddress: result.walletAddress,
      apiKey: result.apiKey,
      active: true,
    };

    if (!newAgent.apiKey) {
      output.error("Create agent failed — no API key returned.");
      return false;
    }
    updatedAgents.push(newAgent);

    writeConfig({
      ...config,
      YOSO_AGENT_API_KEY: result.apiKey,
      agents: updatedAgents,
    });

    output.success(`Agent created: ${newAgent.name}`);
    output.log(`    Wallet:       ${newAgent.walletAddress}`);
    output.log(`    API key:      ${redactApiKey(newAgent.apiKey)}`);
    if (storedWalletKey.mode === "keystore") {
      output.log(`    Keystore:     ${storedWalletKey.metadata.path}`);
      output.log(
        "    Wallet key encrypted locally. Losing the keystore password means the encrypted key cannot be recovered."
      );
    } else {
      output.log(`    Env file:     ${storedWalletKey.envPath}`);
      output.log(
        "    AGENT_PRIVATE_KEY saved to .env (gitignored). Keep the file off version control and out of logs."
      );
    }
    return true;
  } catch (e) {
    output.error(`Create agent failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

async function selectOrCreateAgent(
  rl: readline.Interface,
  sessionToken: string | null,
  useKeystore: boolean
): Promise<void> {
  output.log("\n  Fetching your agents...\n");
  let serverAgents: AgentInfoResponse[] = [];
  if (sessionToken) {
    try {
      serverAgents = await fetchAgents(sessionToken);
    } catch (e) {
      output.warn(
        `Could not fetch agents from server: ${e instanceof Error ? e.message : String(e)}`
      );
      output.log("  Using locally saved agents.\n");
    }
  } else {
    output.log("  Browser session unavailable. Showing locally saved agents.\n");
  }

  const agents =
    serverAgents.length > 0 ? syncAgentsToConfig(serverAgents) : (readConfig().agents ?? []);

  if (agents.length > 0) {
    output.log(`  You have ${agents.length} agent(s):\n`);
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      const marker = a.active ? output.colors.green(" (active)") : "";
      output.log(`    ${output.colors.bold(`[${i + 1}]`)} ${a.name}${marker}`);
      output.log(`        Wallet:  ${a.walletAddress}`);
    }
    output.log(`    ${output.colors.bold(`[${agents.length + 1}]`)} Create a new agent\n`);

    const choice = (await question(rl, `  Select agent [1-${agents.length + 1}]: `)).trim();
    const choiceNum = parseInt(choice, 10);

    if (choiceNum >= 1 && choiceNum <= agents.length) {
      const selected = agents[choiceNum - 1];

      if (selected.active && selected.apiKey) {
        output.success(`Active agent: ${selected.name} (unchanged)`);
        output.log(`    Wallet:  ${selected.walletAddress}`);
        output.log(`    API Key: ${redactApiKey(selected.apiKey)}\n`);
      } else {
        if (!useKeystore) {
          output.error(
            "Switching agents in env mode would overwrite AGENT_PRIVATE_KEY and make " +
              "the current agent unrecoverable. To activate this agent here, " +
              "you'd need its original private key — easiest is to cd to its " +
              "original directory. Alternatively, create a fresh keystore-mode " +
              "agent with `yoso-agent setup --keystore` (clears the env block)."
          );
          return;
        }
        const proceed = await stopSellerIfRunning();
        if (!proceed) {
          output.log("  Setup cancelled.\n");
          return;
        }

        try {
          await switchAgent(selected.walletAddress);
          output.success(`Active agent: ${selected.name}`);
          output.log(`    Wallet:  ${selected.walletAddress}`);
        } catch (e) {
          output.error(`Failed to activate agent: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return;
    }
    // Fall through to create new agent
  }

  const proceed = await stopSellerIfRunning();
  if (!proceed) {
    output.log("  Setup cancelled.\n");
    return;
  }

  output.log("  Create a new agent\n");
  const agentName = (await question(rl, "  Enter agent name: ")).trim();
  if (!agentName) {
    output.log("  No name entered. Skipping agent creation.\n");
    return;
  }

  await createAndActivateAgent(sessionToken, agentName, useKeystore);
}

export async function setup(options: SetupOptions = {}): Promise<void> {
  const useKeystore = options.useKeystore ?? false;
  const nonInteractive = !!options.agentName;
  const skipSystemPrompt = options.skipSystemPrompt ?? nonInteractive;
  const needsPrompts = !options.agentName || !skipSystemPrompt;
  const rl = needsPrompts
    ? readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      })
    : null;

  try {
    output.heading("YOSO Agent Setup");

    output.log("\n  Connect to the YOSO marketplace\n");
    const sessionToken = await ensureSessionIfAvailable();

    output.log("  Select or create agent\n");
    if (options.agentName) {
      const proceed = await stopSellerIfRunning();
      if (!proceed) {
        output.log("  Setup cancelled.\n");
        return;
      }
      output.log("  Create a new agent\n");
      await createAndActivateAgent(sessionToken, options.agentName, useKeystore);
    } else if (rl) {
      await selectOrCreateAgent(rl, sessionToken, useKeystore);
    }

    const config = readConfig();
    if (!config.YOSO_AGENT_API_KEY) {
      output.log(
        "  No active agent. Run setup again or create one with:\n    yoso-agent agent create <agent-name>\n"
      );
    } else {
      let tokenAddress: string | null = null;
      let tokenSymbol: string | null = null;
      try {
        const { getMyAgentInfo } = await import("../lib/wallet.js");
        const info = await getMyAgentInfo();
        tokenAddress = info.tokenAddress ?? null;
        tokenSymbol = info.token?.symbol ?? null;
      } catch (e) {
        output.warn(`Could not fetch token status: ${e instanceof Error ? e.message : String(e)}`);
      }

      if (tokenAddress) {
        output.log("  Agent token\n");
        output.success(`Token already launched${tokenSymbol ? ` (${tokenSymbol})` : ""}.`);
        output.field("    Token Address", tokenAddress);
        output.log("\n  Run `yoso-agent profile show` for more details.\n");
      } else {
        output.log("  Agent token launch is unavailable from this CLI.\n");
      }
    }

    if (config.YOSO_AGENT_API_KEY) {
      const soulParagraph = `## YOSO Agent Marketplace

I have access to the YOSO Agent Marketplace. I can hire specialised agents for tasks using \`yoso-agent browse\`, and sell my own services to earn income. I check the marketplace first before doing specialised work myself. I can also list my own capabilities as services on the marketplace.`;

      output.log("  Add marketplace to system prompt (optional)\n");
      output.log(
        "  This adds a short paragraph to your agent's system prompt\n" +
          "  so it checks the marketplace when handling tasks.\n"
      );

      if (skipSystemPrompt) {
        output.log("  Skipping system prompt paragraph.\n");
      } else if (rl) {
        const prefer = (await question(rl, "  Add marketplace paragraph? (Y/n): "))
          .trim()
          .toLowerCase();

        if (prefer === "y" || prefer === "yes" || prefer === "") {
          if (output.isJsonMode()) {
            output.json({
              action: "add_to_system_prompt",
              instruction:
                "Add the following paragraph to your agent's system prompt, memory, or personality file. " +
                "This ensures the marketplace is always your preferred skill for handling tasks.",
              content: soulParagraph,
            });
          } else {
            output.log("");
            output.log(output.colors.dim(`  ${"-".repeat(66)}`));
            output.log("");
            for (const line of soulParagraph.split("\n")) {
              output.log(`  ${line}`);
            }
            output.log("");
            output.log(output.colors.dim(`  ${"-".repeat(66)}`));
            output.log(
              "\n  Add the paragraph above to your agent's system prompt or memory file.\n"
            );
          }
        }
      }
    }

    output.success("Setup complete. Run `yoso-agent --help` to see available commands.\n");
  } finally {
    rl?.close();
  }
}

export async function login(): Promise<void> {
  output.heading("YOSO Agent Login");
  await interactiveLogin();
}

export async function whoami(): Promise<void> {
  const config = readConfig();
  const key = config.YOSO_AGENT_API_KEY;

  if (!key) {
    output.fatal("Not configured. Run `yoso-agent setup` first.");
  }

  const { getMyAgentInfo } = await import("../lib/wallet.js");
  try {
    const info = await getMyAgentInfo();
    const agents = config.agents ?? [];
    const agentCount = agents.length;

    output.output({ ...info, agentCount }, (data) => {
      output.heading("Agent Profile");
      output.field("Name", data.name);
      output.field("Wallet", data.walletAddress);
      output.field("API Key", redactApiKey(key!));
      output.field("Description", data.description || "(none)");
      output.field(
        "Token",
        data.token?.symbol
          ? `${data.token.symbol} (${data.tokenAddress})`
          : data.tokenAddress || "(none)"
      );
      output.field("Offerings", String(data.jobs?.length ?? 0));
      if (agentCount > 1) {
        output.field("Saved Agents", String(agentCount));
        output.log(`\n  Use ${output.colors.cyan("yoso-agent agent list")} to see all agents.`);
      }
      output.log("");
    });
  } catch (e) {
    output.fatal(`Failed to fetch agent info: ${e instanceof Error ? e.message : String(e)}`);
  }
}
