import * as fs from "fs";
import * as path from "path";
import * as output from "../lib/output.js";
import { ROOT, getActiveAgent, sanitizeAgentName } from "../lib/config.js";
import { getMyAgentInfo } from "../lib/wallet.js";

interface OfferingJson {
  name?: unknown;
}

const OFFERINGS_BASE = path.resolve(ROOT, "src", "seller", "offerings");

export async function checkForLegacyOfferings(): Promise<void> {
  if (!fs.existsSync(OFFERINGS_BASE)) return;

  const agent = getActiveAgent();
  if (!agent) return;
  const agentDir = sanitizeAgentName(agent.name);

  const entries = fs.readdirSync(OFFERINGS_BASE, { withFileTypes: true });
  const legacyOfferings = entries.filter((entry) => {
    if (!entry.isDirectory()) return false;
    const subPath = path.join(OFFERINGS_BASE, entry.name);
    return (
      fs.existsSync(path.join(subPath, "offering.json")) &&
      fs.existsSync(path.join(subPath, "handlers.ts"))
    );
  });

  if (legacyOfferings.length === 0) return;

  const agentInfo = await getMyAgentInfo();
  const registeredOfferingNames = new Set(agentInfo.jobs?.map((job) => job.name) ?? []);

  const agentLegacyOfferings = legacyOfferings.filter((entry) => {
    if (registeredOfferingNames.has(entry.name)) return true;

    try {
      const offeringJsonPath = path.join(OFFERINGS_BASE, entry.name, "offering.json");
      if (!fs.existsSync(offeringJsonPath)) return false;
      const offeringJson: OfferingJson = JSON.parse(fs.readFileSync(offeringJsonPath, "utf-8"));
      return (
        typeof offeringJson.name === "string" && registeredOfferingNames.has(offeringJson.name)
      );
    } catch {
      return false;
    }
  });

  if (agentLegacyOfferings.length === 0) return;

  const names = agentLegacyOfferings.map((entry) => entry.name);
  output.warn(
    `Found ${names.length} offering(s) in the legacy directory structure:\n` +
      names.map((name) => `    - src/seller/offerings/${name}/`).join("\n") +
      "\n\n" +
      `  Job offerings should be placed by agent name in src/seller/offerings/${agentDir}/\n` +
      `  Move them with:\n\n` +
      names
        .map(
          (name) => `    mv src/seller/offerings/${name} src/seller/offerings/${agentDir}/${name}`
        )
        .join("\n") +
      "\n"
  );
}
