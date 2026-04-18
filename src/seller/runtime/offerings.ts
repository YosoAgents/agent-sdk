import * as fs from "fs";
import * as path from "path";
import type { OfferingHandlers } from "./offeringTypes.js";
import { ROOT } from "../../lib/config.js";

export interface OfferingConfig {
  name: string;
  description: string;
  jobFee: number;
  jobFeeType: "fixed" | "percentage";
  requiredFunds: boolean;
}

export interface LoadedOffering {
  config: OfferingConfig;
  handlers: OfferingHandlers;
}

function resolveOfferingsRoot(agentDirName: string): string {
  return path.resolve(ROOT, "src", "seller", "offerings", agentDirName);
}

function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Load a named offering from `src/seller/offerings/<agentDirName>/<name>/`.
 * Expects `offering.json` and `handlers.ts` in that directory.
 */
export async function loadOffering(
  offeringName: string,
  agentDirName: string
): Promise<LoadedOffering> {
  if (!/^[a-zA-Z0-9_-]+$/.test(offeringName)) {
    throw new Error(`Invalid offering name: ${offeringName}`);
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(agentDirName)) {
    throw new Error(`Invalid agent directory name: ${agentDirName}`);
  }
  const offeringsRoot = resolveOfferingsRoot(agentDirName);
  const offeringDir = path.resolve(offeringsRoot, offeringName);

  // Verify resolved path stays under offerings root (prevents symlink escape)
  const realOfferingDir = fs.existsSync(offeringDir) ? fs.realpathSync(offeringDir) : offeringDir;
  const realRoot = fs.existsSync(offeringsRoot) ? fs.realpathSync(offeringsRoot) : offeringsRoot;
  if (!isPathInside(realRoot, realOfferingDir)) {
    throw new Error(`Offering directory escapes offerings root: ${offeringName}`);
  }

  const configPath = path.join(offeringDir, "offering.json");
  if (!fs.existsSync(configPath)) {
    throw new Error(`offering.json not found: ${configPath}`);
  }
  const config: OfferingConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));

  // handlers.ts (dynamically imported)
  const handlersPath = path.join(offeringDir, "handlers.ts");
  if (!fs.existsSync(handlersPath)) {
    throw new Error(`handlers.ts not found: ${handlersPath}`);
  }

  // Convert Windows path to file:// URL for ESM import()
  const handlersUrl = new URL(`file:///${handlersPath.replace(/\\/g, "/")}`).href;
  const imported = (await import(handlersUrl)) as OfferingHandlers & {
    default?: OfferingHandlers;
  };
  const handlers = typeof imported.executeJob === "function" ? imported : imported.default;

  if (typeof handlers?.executeJob !== "function") {
    throw new Error(`handlers.ts in "${offeringName}" must export an executeJob function`);
  }

  return { config, handlers };
}

export function listOfferings(agentDirName: string): string[] {
  const offeringsRoot = resolveOfferingsRoot(agentDirName);
  if (!fs.existsSync(offeringsRoot)) return [];
  return fs
    .readdirSync(offeringsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}
