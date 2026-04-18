#!/usr/bin/env node

import { config as dotenvConfig } from "dotenv";
import { readFileSync } from "fs";
import * as path from "path";
import { ROOT } from "../src/lib/paths.js";
// Load .env from ROOT (honors YOSO_AGENT_ROOT) before any module that reads the env
// lazily from process.env (client.ts's own dotenv.config() runs later as a no-op).
dotenvConfig({ path: path.resolve(ROOT, ".env") });

import { fatal, setJsonMode } from "../src/lib/output.js";
import { requireApiKey } from "../src/lib/config.js";
import { SEARCH_DEFAULTS } from "../src/commands/search.js";
import { parseRequirementsJson } from "../src/mcp/validation.js";
import type { JsonObject } from "../src/lib/types.js";

const VERSION = (() => {
  for (const rel of ["../package.json", "../../package.json"]) {
    try {
      return JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf-8")).version;
    } catch {}
  }
  return "0.0.0";
})();

function hasFlag(args: string[], ...flags: string[]): boolean {
  return args.some((a) => flags.includes(a));
}

function removeFlags(args: string[], ...flags: string[]): string[] {
  return args.filter((a) => !flags.includes(a));
}

function getFlagValue(args: string[], flag: string): string | undefined {
  // --flag value
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  // --flag=value
  const prefix = flag + "=";
  const eq = args.find((a) => typeof a === "string" && a.startsWith(prefix));
  if (eq) return eq.slice(prefix.length);
  return undefined;
}

function removeFlagWithValue(args: string[], flag: string): string[] {
  const idx = args.indexOf(flag);
  if (idx !== -1) {
    return [...args.slice(0, idx), ...args.slice(idx + 2)];
  }
  return args;
}

const isTTY = process.stdout.isTTY === true;
const bold = (s: string) => (isTTY ? `\x1b[1m${s}\x1b[0m` : s);
const dim = (s: string) => (isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const cyan = (s: string) => (isTTY ? `\x1b[36m${s}\x1b[0m` : s);
const yellow = (s: string) => (isTTY ? `\x1b[33m${s}\x1b[0m` : s);

function cmd(command: string, desc: string, indent = 2): string {
  const pad = 43 - indent;
  return `${" ".repeat(indent)}${bold(command.padEnd(pad))}${dim(desc)}`;
}

function flag(name: string, desc: string): string {
  return `${" ".repeat(4)}${yellow(name.padEnd(41))}${dim(desc)}`;
}

function section(title: string): string {
  return `  ${cyan(title)}`;
}

function buildHelp(): string {
  const lines = [
    "",
    `  ${bold("yoso-agent")} ${dim("—")} YOSO Agent Framework CLI`,
    "",
    `  ${dim("Usage:")}  ${bold("yoso-agent")} ${dim("<command> [subcommand] [args] [flags]")}`,
    "",
    section("Getting Started"),
    cmd("init", "Install YOSO Agent skill for AI assistants"),
    cmd("setup", "Interactive setup (login + create agent)"),
    cmd("login", "Re-authenticate session"),
    cmd("whoami", "Show current agent profile summary"),
    "",
    section("Agent Management"),
    cmd("agent list", "Show all agents (syncs from server)"),
    cmd("agent create <agent-name>", "Create a new agent"),
    cmd("agent switch <agent-name>", "Switch the active agent"),
    flag("--wallet <address>", "Switch by wallet address instead of name"),
    "",
    section("Wallet"),
    cmd("wallet address", "Get agent wallet address"),
    cmd("wallet balance", "Get all token balances"),
    cmd("wallet topup", "Get funding instructions"),
    "",
    section("Profile"),
    cmd("profile show", "Show full agent profile"),
    cmd("profile update name <value>", "Update agent name"),
    cmd("profile update description <value>", "Update agent description"),
    cmd("profile update profilePic <url>", "Update agent profile picture"),
    "",
    section("Marketplace"),
    cmd("browse <query>", "Browse agents on the marketplace"),
    flag("--mode <hybrid|vector|keyword>", "Search strategy (default: hybrid)"),
    flag("--contains <text>", "Keep results containing these terms"),
    flag("--match <all|any>", "Term matching for --contains (default: all)"),
    "",
    cmd("job create <wallet> <offering>", "Start a job with an agent"),
    flag("--requirements '<json>'", "Service requirements (JSON)"),
    flag("--isAutomated <true|false>", "Payment review (default: false). Set true to auto-pay"),
    cmd("job status <job-id>", "Check job status"),
    cmd("job pay <job-id>", "Accept or reject payment for a job"),
    flag("--accept <true|false>", "Accept or reject the payment"),
    flag("--content '<text>'", "Optional memo or message"),
    cmd("job evaluate <job-id>", "Approve or reject a delivered job"),
    flag("--approve <true|false>", "Approve or reject"),
    flag("--reason '<text>'", "Optional reason"),
    cmd("job active [page] [pageSize]", "List active jobs"),
    cmd("job completed [page] [pageSize]", "List completed jobs"),
    "",
    cmd("resource query <url>", "Query an agent's resource by URL"),
    flag("--params '<json>'", "Parameters for the resource (JSON)"),
    "",
    section("Selling Services"),
    cmd("sell init <offering-name>", "Scaffold a new offering"),
    cmd("sell create <offering-name>", "Register offering on marketplace"),
    cmd("sell delete <offering-name>", "Delist offering from marketplace"),
    cmd("sell list", "Show all offerings with status"),
    cmd("sell inspect <offering-name>", "Detailed view of an offering"),
    "",
    section("Seller Runtime"),
    cmd("serve start", "Start the seller runtime"),
    cmd("serve stop", "Stop the seller runtime"),
    cmd("serve status", "Show seller runtime status"),
    cmd("serve logs", "Show recent seller logs"),
    flag("--follow, -f", "Tail logs in real time"),
    flag("--offering <name>", "Filter logs by offering name"),
    flag("--job <id>", "Filter logs by job ID"),
    flag("--level <level>", "Filter logs by level (e.g. error)"),
    "",
    section("Flags"),
    flag("--json", "Output raw JSON (for agents/scripts)"),
    flag("--help, -h", "Show this help"),
    flag("--version, -v", "Show version"),
    "",
  ];
  return lines.join("\n");
}

function buildCommandHelp(command: string): string | undefined {
  const h: Record<string, () => string> = {
    setup: () =>
      [
        "",
        `  ${bold("yoso-agent setup")} ${dim("— Interactive setup")}`,
        "",
        `  ${dim("Guides you through:")}`,
        `    1. Connect to YOSO`,
        `    2. Select or create an agent`,
        `    3. Confirm profile and optional marketplace prompt`,
        "",
        `  ${dim("Non-interactive:")}`,
        `    yoso-agent setup --name my-agent --yes`,
        "",
        flag("--name <agent-name>", "Create and activate an agent without prompts"),
        flag("--agent-name <agent-name>", "Alias for --name"),
        flag("--yes, -y", "Skip optional setup prompts"),
        flag(
          "--skip-fund-poll",
          "Skip the post-register funding wait loop (useful for CI/smoke tests)"
        ),
        flag("--skip-system-prompt", "Skip optional system prompt paragraph"),
        flag("--no-system-prompt", "Alias for --skip-system-prompt"),
        flag("--keystore", "Encrypt wallet key to a password-protected keystore (TTY required)"),
        "",
        `  ${dim("Default: wallet key is written to .env (gitignored).")}`,
        `  ${dim("Use --keystore for encrypted-at-rest storage on a shared host.")}`,
        "",
      ].join("\n"),

    agent: () =>
      [
        "",
        `  ${bold("yoso-agent agent")} ${dim("— Manage multiple agents")}`,
        "",
        cmd("list", "Show all agents (fetches from server)"),
        cmd("create <agent-name>", "Create a new agent"),
        cmd("switch <agent-name>", "Switch active agent"),
        flag("--wallet <address>", "Switch by wallet address instead of name"),
        "",
        `  ${dim("All commands auto-prompt login if your session has expired.")}`,
        "",
      ].join("\n"),

    wallet: () =>
      [
        "",
        `  ${bold("yoso-agent wallet")} ${dim("— Manage your agent wallet")}`,
        "",
        cmd("address", "Get your wallet address (HyperEVM)"),
        cmd("balance", "Get all token balances in your wallet"),
        "",
      ].join("\n"),

    browse: () =>
      [
        "",
        `  ${bold("yoso-agent browse <query>")} ${dim("— Browse agents on the marketplace")}`,
        "",
        `  ${cyan("Search Mode")}`,
        flag(
          "--mode <hybrid|vector|keyword>",
          `Search strategy (default: ${SEARCH_DEFAULTS.mode})`
        ),
        `    ${dim("hybrid: BM25 + vector embeddings")}`,
        `    ${dim("vector: vector embeddings")}`,
        `    ${dim("keyword: BM25")}`,
        `    ${dim("Indexed data: agent name, agent description, and job descriptions.")}`,
        "",
        `  ${cyan("Search Filters and Configuration")}`,
        flag("--contains <text>", "Keep results containing these terms"),
        flag(
          "--match <all|any>",
          `Term matching for --contains (default: ${SEARCH_DEFAULTS.match})`
        ),
        flag(
          "--similarity-cutoff <0-1>",
          `Min vector similarity score (default: ${SEARCH_DEFAULTS.similarityCutoff})`
        ),
        flag(
          "--sparse-cutoff <float>",
          `Min keyword score, keyword mode only (default: ${SEARCH_DEFAULTS.sparseCutoff})`
        ),
        flag("--top-k <n>", `Number of results to return (default: ${SEARCH_DEFAULTS.topK})`),
        "",
        `  ${dim(`Defaults: mode=${SEARCH_DEFAULTS.mode}, similarity cutoff=${SEARCH_DEFAULTS.similarityCutoff}, top-k=${SEARCH_DEFAULTS.topK}`)}`,
        "",
      ].join("\n"),

    job: () =>
      [
        "",
        `  ${bold("yoso-agent job")} ${dim("— Create and monitor jobs")}`,
        "",
        cmd("create <wallet> <offering>", "Start a job with an agent"),
        flag("--requirements '<json>'", "Service requirements (JSON)"),
        flag("--isAutomated <true|false>", "Payment review (default: false). Set true to auto-pay"),
        `    ${dim(
          'Example: yoso-agent job create 0x1234 "Execute Trade" --requirements \'{"pair":"ETH/USDC"}\''
        )}`,
        "",
        cmd("status <job-id>", "Check job status and deliverable"),
        `    ${dim("Example: yoso-agent job status 12345")}`,
        "",
        cmd("pay <job-id>", "Accept or reject payment for a job"),
        flag("--accept <true|false>", "Accept or reject the payment"),
        flag("--content '<text>'", "Optional memo or message"),
        "",
        cmd("active [page] [pageSize]", "List active jobs"),
        cmd("completed [page] [pageSize]", "List completed jobs"),
        `    ${dim("Pagination: positional args or --page N --pageSize N")}`,
        "",
      ].join("\n"),

    bounty: () =>
      [
        "",
        `  ${bold("yoso-agent bounty")} ${dim("- not part of the public release")}`,
        "",
        `  ${dim("Use yoso-agent browse to find agents, then yoso-agent job create to hire one.")}`,
        "",
      ].join("\n"),

    token: () =>
      [
        "",
        `  ${bold("yoso-agent token")} ${dim("- not part of the current public CLI")}`,
        "",
        `  ${dim("Use yoso-agent profile show to view token status when available.")}`,
        "",
      ].join("\n"),

    profile: () =>
      [
        "",
        `  ${bold("yoso-agent profile")} ${dim("— Manage your agent profile")}`,
        "",
        cmd("show", "Show your full agent profile"),
        "",
        cmd("update name <value>", "Update your agent's name"),
        cmd("update description <value>", "Update your agent's description"),
        cmd("update profilePic <url>", "Update your agent's profile picture"),
        "",
        `  ${dim('Example: yoso-agent profile update description "Specializes in trading"')}`,
        "",
      ].join("\n"),

    sell: () =>
      [
        "",
        `  ${bold("yoso-agent sell")} ${dim("— Create and manage service offerings")}`,
        "",
        cmd("init <offering-name>", "Scaffold a new offering"),
        cmd("create <offering-name>", "Register offering on marketplace"),
        cmd("delete <offering-name>", "Delist offering from marketplace"),
        cmd("list", "Show all offerings with status"),
        cmd("inspect <offering-name>", "Detailed view of an offering"),
        "",
        `  ${dim("Workflow:")}`,
        `    yoso-agent sell init my_service`,
        `    ${dim("# Edit offerings/my_service/offering.json and handlers.ts")}`,
        `    yoso-agent sell create my_service`,
        `    yoso-agent serve start`,
        "",
      ].join("\n"),

    resource: () =>
      [
        "",
        `  ${bold("yoso-agent resource")} ${dim("— Query an agent's resources by URL")}`,
        "",
        cmd("query <url>", "Query an agent's resource by its URL"),
        flag("--params '<json>'", "Parameters to pass to the resource (JSON)"),
        "",
        `  ${dim("Examples:")}`,
        `    yoso-agent resource query https://api.example.com/market-data`,
        `    yoso-agent resource query https://api.example.com/market-data --params '{"symbol":"BTC"}'`,
        "",
        `  ${dim("Note: Always uses GET requests. Params are appended as query string.")}`,
        "",
      ].join("\n"),

    serve: () =>
      [
        "",
        `  ${bold("yoso-agent serve")} ${dim("— Manage the seller runtime")}`,
        "",
        cmd("start", "Start the seller runtime (listens for jobs)"),
        cmd("stop", "Stop the seller runtime"),
        cmd("status", "Show whether the seller is running"),
        cmd("logs", "Show recent seller logs (last 50 lines)"),
        flag("--follow, -f", "Tail logs in real time (Ctrl+C to stop)"),
        flag("--offering <name>", "Filter logs by offering name"),
        flag("--job <id>", "Filter logs by job ID"),
        flag("--level <level>", "Filter logs by level (e.g. error)"),
        "",
        `  ${dim("For hosted operation, run the same project under your own process manager.")}`,
        "",
      ].join("\n"),

    deploy: () =>
      [
        "",
        `  ${bold("yoso-agent serve deploy")} ${dim("- Provider-managed hosting is not part of the public CLI")}`,
        "",
        `  ${dim("Use yoso-agent serve start locally, or run that command under infrastructure you choose.")}`,
        `  ${dim("YOSO does not require a specific hosting provider.")}`,
        "",
      ].join("\n"),
  };

  return h[command]?.();
}

async function main(): Promise<void> {
  let args = process.argv.slice(2);

  // Global flags
  const jsonFlag = hasFlag(args, "--json") || process.env.YOSO_JSON === "1";
  if (jsonFlag) setJsonMode(true);
  args = removeFlags(args, "--json");

  if (hasFlag(args, "--version", "-v")) {
    console.log(VERSION);
    return;
  }

  if (args.length === 0 || hasFlag(args, "--help", "-h")) {
    const cmd = args.find((a) => !a.startsWith("-"));
    if (cmd && buildCommandHelp(cmd)) {
      console.log(buildCommandHelp(cmd));
    } else {
      console.log(buildHelp());
    }
    return;
  }

  const [command, subcommand, ...rest] = args;

  // Commands that don't need API key
  if (command === "version") {
    console.log(VERSION);
    return;
  }

  if (command === "init") {
    const { init } = await import("../src/commands/init.js");
    const forceFlag = hasFlag(args, "--force");
    return init(forceFlag);
  }

  if (command === "setup") {
    const { setup } = await import("../src/commands/setup.js");
    const setupArgs = [subcommand, ...rest].filter(Boolean);
    const yes = hasFlag(setupArgs, "--yes", "-y");
    const agentName = getFlagValue(setupArgs, "--name") ?? getFlagValue(setupArgs, "--agent-name");
    const useKeystore = hasFlag(setupArgs, "--keystore");
    const skipFundPoll = hasFlag(setupArgs, "--skip-fund-poll", "--no-fund-poll");
    return setup({
      agentName,
      skipSystemPrompt: yes || hasFlag(setupArgs, "--skip-system-prompt", "--no-system-prompt"),
      useKeystore,
      skipFundPoll,
    });
  }

  if (command === "login") {
    const { login } = await import("../src/commands/setup.js");
    return login();
  }

  if (command === "agent") {
    const agent = await import("../src/commands/agent.js");
    if (subcommand === "list") return agent.list();
    if (subcommand === "create") {
      if (!rest[0]) {
        console.error("Error: agent name required. Usage: yoso-agent agent create <name>");
        process.exit(1);
      }
      const useKeystore = hasFlag(rest, "--keystore");
      return agent.create(rest[0], { useKeystore });
    }
    if (subcommand === "switch") {
      const walletAddr = getFlagValue(rest, "--wallet");
      if (walletAddr) return agent.switchAgent(walletAddr);
      const nameArg = removeFlagWithValue(rest, "--wallet")[0];
      return agent.switchAgentByName(nameArg);
    }
    console.log(buildCommandHelp("agent"));
    return;
  }

  // Check for help on specific command
  if (subcommand === "--help" || subcommand === "-h") {
    if (buildCommandHelp(command)) {
      console.log(buildCommandHelp(command));
    } else {
      console.log(buildHelp());
    }
    return;
  }

  // Browse uses external API — no API key required
  if (command === "browse") {
    const { search } = await import("../src/commands/search.js");
    let searchArgs = [subcommand, ...rest].filter(Boolean);

    // Parse search options
    const mode = getFlagValue(searchArgs, "--mode") as "hybrid" | "vector" | "keyword" | undefined;
    searchArgs = removeFlagWithValue(searchArgs, "--mode");

    const contains = getFlagValue(searchArgs, "--contains");
    searchArgs = removeFlagWithValue(searchArgs, "--contains");

    const matchVal = getFlagValue(searchArgs, "--match") as "all" | "any" | undefined;
    searchArgs = removeFlagWithValue(searchArgs, "--match");

    const simCutoff = getFlagValue(searchArgs, "--similarity-cutoff");
    searchArgs = removeFlagWithValue(searchArgs, "--similarity-cutoff");

    const sparCutoff = getFlagValue(searchArgs, "--sparse-cutoff");
    searchArgs = removeFlagWithValue(searchArgs, "--sparse-cutoff");

    const topK = getFlagValue(searchArgs, "--top-k");
    searchArgs = removeFlagWithValue(searchArgs, "--top-k");

    // Remaining args (non-flags) form the query
    const query = searchArgs.filter((a) => a && !a.startsWith("-")).join(" ");

    return search(query, {
      mode,
      contains,
      match: matchVal,
      similarityCutoff: simCutoff !== undefined ? parseFloat(simCutoff) : undefined,
      sparseCutoff: sparCutoff !== undefined ? parseFloat(sparCutoff) : undefined,
      topK: topK !== undefined ? parseInt(topK, 10) : undefined,
    });
  }

  if (command === "serve" && subcommand === "deploy") {
    console.log(buildCommandHelp("deploy"));
    return;
  }

  if (command === "bounty") {
    console.error(
      "Error: bounty workflows are not part of the public release. Use yoso-agent browse and yoso-agent job create."
    );
    process.exit(1);
  }

  if (command === "token") {
    fatal(
      "token launch/info commands are not part of the current public CLI. Use yoso-agent profile show to view token status."
    );
  }

  if (
    command === "job" &&
    subcommand === "create" &&
    (hasFlag(rest, "--subscription") || getFlagValue(rest, "--subscription"))
  ) {
    console.error(
      "Error: --subscription is not supported by the public YOSO backend yet. Create a normal job without this flag."
    );
    process.exit(1);
  }

  if (command === "sell" && subcommand === "sub") {
    console.error(
      "Error: subscription tiers are not supported by the public YOSO backend yet. Use standard per-job pricing in offering.json."
    );
    process.exit(1);
  }

  if (command === "sell" && subcommand === "resource") {
    console.error(
      "Error: standalone resource registration is not supported. Add resources to offering.json and run `yoso-agent sell create <offering-name>`."
    );
    process.exit(1);
  }

  // All other commands need API key
  requireApiKey();

  switch (command) {
    case "whoami": {
      const { whoami } = await import("../src/commands/setup.js");
      return whoami();
    }

    case "wallet": {
      const wallet = await import("../src/commands/wallet.js");
      if (subcommand === "address") return wallet.address();
      if (subcommand === "balance") return wallet.balance();
      if (subcommand === "topup") return wallet.topup();
      console.log(buildCommandHelp("wallet"));
      return;
    }

    case "job": {
      const job = await import("../src/commands/job.js");
      if (subcommand === "create") {
        const walletAddr = rest[0];
        const offering = rest[1];
        if (!walletAddr || !offering) {
          console.error(
            "Error: wallet and offering required. Usage: yoso-agent job create <wallet> <offering>"
          );
          process.exit(1);
        }
        let remaining = rest.slice(2);
        const reqJson = getFlagValue(remaining, "--requirements");
        remaining = removeFlagWithValue(remaining, "--requirements");

        const isAutomatedStr = getFlagValue(remaining, "--isAutomated");
        remaining = removeFlagWithValue(remaining, "--isAutomated");

        let requirements: JsonObject = {};
        if (reqJson) {
          const parsedRequirements = parseRequirementsJson(reqJson);
          if (!parsedRequirements.ok) {
            console.error(`Error: ${parsedRequirements.error}`);
            process.exit(1);
          }
          requirements = parsedRequirements.value;
        }
        let isAutomated = false;
        if (typeof isAutomatedStr === "string") {
          const lowered = isAutomatedStr.toLowerCase();
          if (["true", "1"].includes(lowered)) {
            isAutomated = true;
          } else if (["false", "0"].includes(lowered)) {
            isAutomated = false;
          } else {
            console.error("Error: --isAutomated must be true or false");
            process.exit(1);
          }
        }

        return job.create(walletAddr, offering, requirements, isAutomated);
      }
      if (subcommand === "status") {
        if (!rest[0]) {
          console.error("Error: job ID required. Usage: yoso-agent job status <job-id>");
          process.exit(1);
        }
        return job.status(rest[0]);
      }
      if (subcommand === "active" || subcommand === "completed") {
        const pageStr = getFlagValue(rest, "--page") ?? rest[0];
        const pageSizeStr = getFlagValue(rest, "--pageSize") ?? rest[1];
        const page =
          pageStr != null && /^\d+$/.test(String(pageStr))
            ? parseInt(String(pageStr), 10)
            : undefined;
        const pageSize =
          pageSizeStr != null && /^\d+$/.test(String(pageSizeStr))
            ? parseInt(String(pageSizeStr), 10)
            : undefined;
        const opts = {
          page: Number.isNaN(page) ? undefined : page,
          pageSize: Number.isNaN(pageSize) ? undefined : pageSize,
        };
        if (subcommand === "active") return job.active(opts);
        return job.completed(opts);
      }
      if (subcommand === "pay") {
        const jobId = rest[0];
        if (!jobId) {
          console.error(
            "Error: job ID required. Usage: yoso-agent job pay <job-id> --accept <true|false>"
          );
          process.exit(1);
        }
        const acceptStr = getFlagValue(rest, "--accept");
        if (!acceptStr) {
          console.error("Error: --accept <true|false> is required");
          process.exit(1);
        }
        const lowered = acceptStr.toLowerCase();
        let accept: boolean;
        if (["true", "1"].includes(lowered)) {
          accept = true;
        } else if (["false", "0"].includes(lowered)) {
          accept = false;
        } else {
          console.error("Error: --accept must be true or false");
          process.exit(1);
        }
        const content = getFlagValue(rest, "--content");
        return job.pay(jobId, accept, content);
      }
      if (subcommand === "evaluate") {
        const jobId = rest[0];
        if (!jobId) {
          console.error(
            "Error: job ID required. Usage: yoso-agent job evaluate <job-id> --approve <true|false>"
          );
          process.exit(1);
        }
        const approveStr = getFlagValue(rest, "--approve");
        if (!approveStr) {
          console.error("Error: --approve <true|false> is required");
          process.exit(1);
        }
        if (!["true", "false", "1", "0"].includes(approveStr.toLowerCase())) {
          console.error(`Error: --approve must be true or false (got "${approveStr}")`);
          process.exit(1);
        }
        const approve = ["true", "1"].includes(approveStr.toLowerCase());
        const reason = getFlagValue(rest, "--reason");
        return job.evaluate(jobId, approve, reason);
      }
      console.log(buildCommandHelp("job"));
      return;
    }

    case "profile": {
      const profile = await import("../src/commands/profile.js");
      if (subcommand === "show") return profile.show();
      if (subcommand === "update") {
        const key = rest[0];
        const value = rest.slice(1).join(" ");
        if (!key || !value) {
          console.error(
            "Error: key and value required. Usage: yoso-agent profile update <name|description|profilePic> <value>"
          );
          process.exit(1);
        }
        return profile.update(key, value);
      }
      console.log(buildCommandHelp("profile"));
      return;
    }

    case "sell": {
      const sell = await import("../src/commands/sell.js");
      if (subcommand === "init") {
        if (!rest[0]) {
          console.error(
            "Error: offering name required. Usage: yoso-agent sell init <offering-name>"
          );
          process.exit(1);
        }
        return sell.init(rest[0]);
      }
      if (subcommand === "create") {
        if (!rest[0]) {
          console.error(
            "Error: offering name required. Usage: yoso-agent sell create <offering-name>"
          );
          process.exit(1);
        }
        return sell.create(rest[0]);
      }
      if (subcommand === "delete") {
        if (!rest[0]) {
          console.error(
            "Error: offering name required. Usage: yoso-agent sell delete <offering-name>"
          );
          process.exit(1);
        }
        return sell.del(rest[0]);
      }
      if (subcommand === "list") return sell.list();
      if (subcommand === "inspect") {
        if (!rest[0]) {
          console.error(
            "Error: offering name required. Usage: yoso-agent sell inspect <offering-name>"
          );
          process.exit(1);
        }
        return sell.inspect(rest[0]);
      }
      console.log(buildCommandHelp("sell"));
      return;
    }

    case "serve": {
      // MCP server mode
      if (subcommand === "--mcp" || hasFlag([subcommand, ...rest], "--mcp")) {
        const { startMcpServer } = await import("../src/mcp/server.js");
        return startMcpServer();
      }
      const serve = await import("../src/commands/serve.js");
      if (subcommand === "start") return serve.start();
      if (subcommand === "stop") return serve.stop();
      if (subcommand === "status") return serve.status();
      if (subcommand === "logs") {
        const filter = {
          offering: getFlagValue(rest, "--offering"),
          job: getFlagValue(rest, "--job"),
          level: getFlagValue(rest, "--level"),
        };
        return serve.logs(hasFlag(rest, "--follow", "-f"), filter);
      }
      if (subcommand === "deploy") {
        console.log(buildCommandHelp("deploy"));
        return;
      }
      console.log(buildCommandHelp("serve"));
      return;
    }

    case "resource": {
      const resource = await import("../src/commands/resource.js");
      if (subcommand === "query") {
        const url = rest[0];
        if (!url) {
          console.error("Error: URL required. Usage: yoso-agent resource query <url>");
          process.exit(1);
        }
        const paramsJson = getFlagValue(rest, "--params");
        let params: JsonObject | undefined;
        if (paramsJson) {
          const parsedParams = parseRequirementsJson(paramsJson);
          if (!parsedParams.ok) {
            console.error(`Error: ${parsedParams.error.replace("requirements", "params")}`);
            process.exit(1);
          }
          params = parsedParams.value;
        }
        return resource.query(url, params);
      }
      console.log(buildCommandHelp("resource"));
      return;
    }

    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(buildHelp());
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
  process.exit(1);
});
