import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import * as output from "../lib/output.js";
import { checkLowBalances, getMyAgentInfo } from "../lib/wallet.js";
import { checkForLegacyOfferings } from "./legacy-offerings.js";
import {
  findSellerPid,
  isProcessRunning,
  removePidFromConfig,
  getActiveAgent,
  sanitizeAgentName,
  ROOT,
  SDK_ROOT,
  LOGS_DIR,
} from "../lib/config.js";

const SELLER_LOG_PATH = path.resolve(LOGS_DIR, "seller.log");

interface SellerCommand {
  command: string;
  args: string[];
  shell: boolean;
}

function resolveTsxLoader(): string | null {
  const candidates = [
    path.resolve(ROOT, "node_modules", "tsx", "dist", "loader.mjs"),
    path.resolve(SDK_ROOT, "node_modules", "tsx", "dist", "loader.mjs"),
    path.resolve(SDK_ROOT, "..", "tsx", "dist", "loader.mjs"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function getOfferingsRoot(): string {
  const agent = getActiveAgent();
  const agentDir = agent ? sanitizeAgentName(agent.name) : "default";
  return path.resolve(ROOT, "src", "seller", "offerings", agentDir);
}

function ensureLogsDir(): void {
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
}

function resolveSellerCommand(): SellerCommand {
  const tsxLoader = resolveTsxLoader();
  if (!tsxLoader) {
    output.fatal(
      "Could not find the tsx runtime required to load offering handlers. " +
        "Install yoso-agent locally or reinstall the package."
    );
  }

  const compiledScript = path.resolve(SDK_ROOT, "dist", "src", "seller", "runtime", "seller.js");
  if (fs.existsSync(compiledScript)) {
    return {
      command: process.execPath,
      args: ["--import", pathToFileURL(tsxLoader).href, compiledScript],
      shell: false,
    };
  }

  const sourceScript = path.resolve(SDK_ROOT, "src", "seller", "runtime", "seller.ts");
  return {
    command: process.execPath,
    args: ["--import", pathToFileURL(tsxLoader).href, sourceScript],
    shell: false,
  };
}

function offeringHasLocalFiles(offeringName: string): boolean {
  const dir = path.join(getOfferingsRoot(), offeringName);
  return (
    fs.existsSync(path.join(dir, "handlers.ts")) && fs.existsSync(path.join(dir, "offering.json"))
  );
}

export async function start(): Promise<void> {
  checkForLegacyOfferings();
  const pid = findSellerPid();
  if (pid !== undefined) {
    output.log(`  Seller already running (PID ${pid}).`);
    return;
  }

  // Warn if no offerings are listed on the marketplace, or if any registered offering is missing local handlers.ts or offering.json
  try {
    const agentInfo = await getMyAgentInfo();
    if (!agentInfo.jobs || agentInfo.jobs.length === 0) {
      output.warn(
        "No offerings registered on the marketplace. Run `yoso-agent sell create <name>` first.\n"
      );
    } else {
      const missing = agentInfo.jobs
        .filter((job) => !offeringHasLocalFiles(job.name))
        .map((job) => job.name);
      if (missing.length > 0) {
        output.warn(
          `No local offering files for ${
            missing.length
          } offering(s) registered on the marketplace: ${missing.join(", ")}. ` +
            `Each needs handlers.ts and offering.json in the agent's offerings directory, or jobs for these offerings will fail at runtime.\n`
        );
      }
    }
  } catch {
    // Non-fatal - proceed with starting anyway
  }

  try {
    const lowBalances = await checkLowBalances();
    if (lowBalances.length > 0) {
      const lines = lowBalances
        .map((b) => `${b.symbol} ${b.amount.toFixed(4)} (min ${b.minimum})`)
        .join(", ");
      output.warn(
        `Low wallet balance: ${lines}. Jobs will fail on first gas/escrow spend. ` +
          `Run \`yoso-agent wallet topup\` before buyers hire.\n`
      );
    }
  } catch {
    // Non-fatal - balance lookup shouldn't block serve start.
  }

  const sellerCommand = resolveSellerCommand();

  ensureLogsDir();
  const logFd = fs.openSync(SELLER_LOG_PATH, "a");

  const sellerProcess = spawn(sellerCommand.command, sellerCommand.args, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    cwd: ROOT,
    shell: sellerCommand.shell,
  });

  if (!sellerProcess.pid) {
    fs.closeSync(logFd);
    output.fatal("Failed to start seller process.");
  }

  sellerProcess.unref();
  fs.closeSync(logFd);

  output.output({ pid: sellerProcess.pid, status: "started" }, () => {
    output.heading("Seller Started");
    output.field("PID", sellerProcess.pid!);
    output.field("Log", SELLER_LOG_PATH);
    output.log("\n  Run `yoso-agent serve status` to verify.");
    output.log("  Run `yoso-agent serve logs` to tail output.\n");
  });
}

export async function stop(): Promise<void> {
  const pid = findSellerPid();

  if (pid === undefined) {
    output.log("  No seller process running.");
    return;
  }

  output.log(`  Stopping seller process (PID ${pid})...`);

  try {
    process.kill(pid, "SIGTERM");
  } catch (err: unknown) {
    output.fatal(
      `Failed to send SIGTERM to PID ${pid}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  let stopped = false;
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (!isProcessRunning(pid)) {
      stopped = true;
      break;
    }
  }

  if (stopped) {
    removePidFromConfig();
    output.output({ pid, status: "stopped" }, () => {
      output.log(`  Seller process (PID ${pid}) stopped.\n`);
    });
  } else {
    output.error(`Process (PID ${pid}) did not stop within 2 seconds. Try: kill -9 ${pid}`);
  }
}

export async function status(): Promise<void> {
  const pid = findSellerPid();
  const running = pid !== undefined;

  output.output({ running, pid: pid ?? null }, () => {
    output.heading("Seller Runtime");
    if (running) {
      output.field("Status", "Running");
      output.field("PID", pid!);
    } else {
      output.field("Status", "Not running");
    }
    output.log("\n  Run `yoso-agent sell list` to see offerings.\n");
  });
}

export interface LogFilter {
  offering?: string;
  job?: string;
  level?: string;
}

function hasActiveFilter(filter: LogFilter): boolean {
  return !!(filter.offering || filter.job || filter.level);
}

export function matchesFilter(line: string, filter: LogFilter): boolean {
  const lower = line.toLowerCase();
  if (filter.offering && !lower.includes(filter.offering.toLowerCase())) return false;
  if (filter.job && !line.includes(filter.job)) return false;
  if (filter.level && !lower.includes(filter.level.toLowerCase())) return false;
  return true;
}

export async function logs(follow: boolean = false, filter: LogFilter = {}): Promise<void> {
  if (!fs.existsSync(SELLER_LOG_PATH)) {
    output.log("  No log file found. Start the seller first: `yoso-agent serve start`\n");
    return;
  }

  const active = hasActiveFilter(filter);

  if (follow) {
    // Cross-platform log following using fs.watch + read stream
    let position = fs.statSync(SELLER_LOG_PATH).size;
    const readNewLines = () => {
      const stat = fs.statSync(SELLER_LOG_PATH);
      if (stat.size <= position) {
        position = stat.size; // handle file truncation
        return;
      }
      const stream = fs.createReadStream(SELLER_LOG_PATH, { start: position, encoding: "utf-8" });
      let buffer = "";
      stream.on("data", (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop()!;
        for (const line of lines) {
          if (!active || matchesFilter(line, filter)) {
            process.stdout.write(line + "\n");
          }
        }
      });
      stream.on("end", () => {
        position = stat.size;
      });
    };

    const watcher = fs.watch(SELLER_LOG_PATH, () => readNewLines());

    await new Promise<void>((resolve) => {
      process.on("SIGINT", () => {
        watcher.close();
        resolve();
      });
    });
  } else {
    const content = fs.readFileSync(SELLER_LOG_PATH, "utf-8");
    const lines = content.split("\n");
    const filtered = active ? lines.filter((l: string) => matchesFilter(l, filter)) : lines;
    const last50 = filtered.slice(-51).join("\n"); // -51 because trailing newline
    if (last50.trim()) {
      output.log(last50);
    } else {
      output.log(active ? "  No log lines matched the filter.\n" : "  Log file is empty.\n");
    }
  }
}
