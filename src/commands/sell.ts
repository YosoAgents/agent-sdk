import * as fs from "fs";
import * as path from "path";
import * as output from "../lib/output.js";
import {
  createJobOffering,
  deleteJobOffering,
  type JobOfferingData,
  type PriceV2,
  type Resource,
} from "../lib/api.js";
import { getMyAgentInfo } from "../lib/wallet.js";
import { formatPrice, getActiveAgent, sanitizeAgentName, ROOT } from "../lib/config.js";
import type { JsonObject } from "../lib/types.js";
import { checkForLegacyOfferings } from "./legacy-offerings.js";
import { nudgeIfNoDescription } from "../lib/profile-nudge.js";

const OFFERINGS_BASE = path.resolve(ROOT, "src", "seller", "offerings");

function getOfferingsRoot(): string {
  const agent = getActiveAgent();
  if (!agent) {
    console.error("Error: No active agent. Run `yoso-agent setup` first.");
    process.exit(1);
  }
  return path.resolve(OFFERINGS_BASE, sanitizeAgentName(agent.name));
}

interface OfferingJson {
  name: string;
  description: string;
  jobFee: number;
  jobFeeType: "fixed" | "percentage";
  priceV2?: PriceV2;
  slaMinutes?: number;
  requiredFunds: boolean;
  requirement?: JsonObject;
  deliverable?: string;
  resources?: Resource[];
}

interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

function resolveOfferingDir(offeringName: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(offeringName)) {
    output.fatal("Offering name may only contain letters, numbers, underscores, and hyphens.");
  }
  const root = getOfferingsRoot();
  const dir = path.resolve(root, offeringName);
  const rel = path.relative(root, dir);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    output.fatal("Offering path must stay inside the active agent's offerings directory.");
  }
  return dir;
}

function validateOfferingJson(filePath: string): ValidationResult {
  const result: ValidationResult = { valid: true, errors: [], warnings: [] };

  if (!fs.existsSync(filePath)) {
    result.valid = false;
    result.errors.push(`offering.json not found at ${filePath}`);
    return result;
  }

  let json: unknown;
  try {
    json = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    result.valid = false;
    result.errors.push(`Invalid JSON in offering.json: ${err}`);
    return result;
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    result.valid = false;
    result.errors.push("offering.json must be a JSON object");
    return result;
  }
  const offering = json as Record<string, unknown>;

  if (!offering.name || typeof offering.name !== "string" || offering.name.trim() === "") {
    result.valid = false;
    result.errors.push(
      'offering.json: "name" is required - set to a non-empty string matching the directory name'
    );
  }
  if (
    !offering.description ||
    typeof offering.description !== "string" ||
    offering.description.trim() === ""
  ) {
    result.valid = false;
    result.errors.push(
      'offering.json: "description" is required - describe what this service does for buyers'
    );
  }
  if (offering.jobFee === undefined || offering.jobFee === null) {
    result.valid = false;
    result.errors.push(
      'offering.json: "jobFee" is required - set to a number (see "jobFeeType" docs)'
    );
  } else if (typeof offering.jobFee !== "number") {
    result.valid = false;
    result.errors.push('offering.json: "jobFee" must be a number');
  }

  if (offering.jobFeeType === undefined || offering.jobFeeType === null) {
    result.valid = false;
    result.errors.push('offering.json: "jobFeeType" is required ("fixed" or "percentage")');
  } else if (offering.jobFeeType !== "fixed" && offering.jobFeeType !== "percentage") {
    result.valid = false;
    result.errors.push('offering.json: "jobFeeType" must be either "fixed" or "percentage"');
  }

  if (typeof offering.jobFee === "number" && offering.jobFeeType) {
    if (offering.jobFeeType === "fixed") {
      if (offering.jobFee < 0) {
        result.valid = false;
        result.errors.push(
          'offering.json: "jobFee" must be a non-negative number (fee in USDC per job) for fixed fee type'
        );
      }
      if (offering.jobFee === 0) {
        result.warnings.push('offering.json: "jobFee" is 0; jobs will pay no fee to seller');
      }
    } else if (offering.jobFeeType === "percentage") {
      if (offering.jobFee < 0.001 || offering.jobFee > 0.99) {
        result.valid = false;
        result.errors.push(
          'offering.json: "jobFee" must be >= 0.001 and <= 0.99 (value in decimals, eg. 50% = 0.5) for percentage fee type'
        );
      }
    }
  }
  if (offering.requiredFunds === undefined || offering.requiredFunds === null) {
    result.valid = false;
    result.errors.push(
      'offering.json: "requiredFunds" is required - set to true if the job needs additional token transfer beyond the fee, false otherwise'
    );
  } else if (typeof offering.requiredFunds !== "boolean") {
    result.valid = false;
    result.errors.push('offering.json: "requiredFunds" must be true or false');
  }

  if (offering.subscriptionTiers !== undefined) {
    result.valid = false;
    result.errors.push(
      'offering.json: "subscriptionTiers" is not supported by the public YOSO backend yet; remove it and use standard per-job pricing'
    );
  }

  if (offering.resources !== undefined) {
    if (!Array.isArray(offering.resources)) {
      result.valid = false;
      result.errors.push('offering.json: "resources" must be an array of resource objects');
    } else {
      for (let i = 0; i < offering.resources.length; i++) {
        const resource = offering.resources[i];
        if (typeof resource !== "object" || resource === null) {
          result.valid = false;
          result.errors.push(
            `offering.json: resources[${i}] must be an object with {name, description, url}`
          );
          continue;
        }
        if (!resource.name || typeof resource.name !== "string" || resource.name.trim() === "") {
          result.valid = false;
          result.errors.push(`offering.json: resources[${i}].name is required`);
        }
        if (
          !resource.description ||
          typeof resource.description !== "string" ||
          resource.description.trim() === ""
        ) {
          result.valid = false;
          result.errors.push(`offering.json: resources[${i}].description is required`);
        }
        if (!resource.url || typeof resource.url !== "string" || resource.url.trim() === "") {
          result.valid = false;
          result.errors.push(`offering.json: resources[${i}].url is required`);
        } else {
          try {
            const parsed = new URL(resource.url);
            if (parsed.protocol !== "https:") {
              result.valid = false;
              result.errors.push(`offering.json: resources[${i}].url must use HTTPS`);
            }
          } catch {
            result.valid = false;
            result.errors.push(`offering.json: resources[${i}].url must be a valid URL`);
          }
        }
        if (
          resource.params !== undefined &&
          (typeof resource.params !== "object" ||
            resource.params === null ||
            Array.isArray(resource.params))
        ) {
          result.valid = false;
          result.errors.push(`offering.json: resources[${i}].params must be an object if provided`);
        }
      }
      const names = offering.resources
        .filter(
          (resource): resource is { name: string } =>
            typeof resource === "object" &&
            resource !== null &&
            "name" in resource &&
            typeof resource.name === "string"
        )
        .map((resource) => resource.name);
      const dupes = names.filter((n: string, i: number) => names.indexOf(n) !== i);
      if (dupes.length > 0) {
        result.valid = false;
        result.errors.push(
          `offering.json: duplicate resource names: ${[...new Set(dupes)].join(", ")}`
        );
      }
    }
  }

  return result;
}

function validateHandlers(filePath: string, requiredFunds?: boolean): ValidationResult {
  const result: ValidationResult = { valid: true, errors: [], warnings: [] };

  if (!fs.existsSync(filePath)) {
    result.valid = false;
    result.errors.push(`handlers.ts not found at ${filePath}`);
    return result;
  }

  const content = fs.readFileSync(filePath, "utf-8");

  const executeJobPatterns = [
    /export\s+(async\s+)?function\s+executeJob\s*\(/,
    /export\s+const\s+executeJob\s*=\s*(async\s*)?\(/,
    /export\s+const\s+executeJob\s*=\s*(async\s*)?function/,
    /export\s*\{\s*[^}]*executeJob[^}]*\}/,
  ];

  if (!executeJobPatterns.some((p) => p.test(content))) {
    result.valid = false;
    result.errors.push(
      'handlers.ts: must export an "executeJob" function - this is the required handler that runs your service logic'
    );
  }

  const hasValidate = [
    /export\s+(async\s+)?function\s+validateRequirements\s*\(/,
    /export\s+const\s+validateRequirements\s*=/,
    /export\s*\{\s*[^}]*validateRequirements[^}]*\}/,
  ].some((p) => p.test(content));

  const hasFunds = [
    /export\s+(async\s+)?function\s+requestAdditionalFunds\s*\(/,
    /export\s+const\s+requestAdditionalFunds\s*=/,
    /export\s*\{\s*[^}]*requestAdditionalFunds[^}]*\}/,
  ].some((p) => p.test(content));

  if (!hasValidate) {
    result.warnings.push(
      'handlers.ts: optional "validateRequirements" handler not found - requests will be accepted without validation'
    );
  }
  if (requiredFunds === true && !hasFunds) {
    result.valid = false;
    result.errors.push(
      'handlers.ts: "requiredFunds" is true in offering.json - must export "requestAdditionalFunds" to specify the token transfer details'
    );
  }
  if (requiredFunds === false && hasFunds) {
    result.valid = false;
    result.errors.push(
      'handlers.ts: "requiredFunds" is false in offering.json - must NOT export "requestAdditionalFunds" (remove it, or set requiredFunds to true)'
    );
  }

  return result;
}

function buildOfferingPayload(json: OfferingJson): JobOfferingData {
  return {
    name: json.name,
    description: json.description,
    priceV2: json.priceV2 ?? { type: json.jobFeeType, value: json.jobFee },
    slaMinutes: json.slaMinutes ?? 5,
    requiredFunds: json.requiredFunds,
    requirement: json.requirement ?? {},
    deliverable: json.deliverable ?? "string",
    ...(json.resources?.length && { resources: json.resources }),
  };
}

export async function init(offeringName: string): Promise<void> {
  await checkForLegacyOfferings();
  if (!offeringName) {
    output.fatal("Usage: yoso-agent sell init <offering_name>");
  }

  const dir = resolveOfferingDir(offeringName);
  if (fs.existsSync(dir)) {
    output.fatal(`Offering directory already exists: ${dir}`);
  }

  fs.mkdirSync(dir, { recursive: true });

  const offeringJson: Record<string, unknown> = {
    name: offeringName,
    description: "",
    jobFee: null,
    jobFeeType: null,
    requiredFunds: false,
    requirement: {},
  };

  fs.writeFileSync(path.join(dir, "offering.json"), JSON.stringify(offeringJson, null, 2) + "\n");

  const handlersTemplate = `import type { ExecuteJobResult, ValidationResult } from "yoso-agent";

export async function executeJob(request: Record<string, unknown>): Promise<ExecuteJobResult> {
  throw new Error("Implement this offering before listing it on the marketplace.");
}

export function validateRequirements(request: Record<string, unknown>): ValidationResult {
  return { valid: true };
}

export function requestPayment(request: Record<string, unknown>): string {
  return "Request accepted";
}
`;

  fs.writeFileSync(path.join(dir, "handlers.ts"), handlersTemplate);

  const agent = getActiveAgent();
  const agentDir = agent ? sanitizeAgentName(agent.name) : "unknown";
  output.output({ created: dir }, () => {
    output.heading("Offering Scaffolded");
    output.log(`  Created: src/seller/offerings/${agentDir}/${offeringName}/`);
    output.log(`    - offering.json  (edit name, description, fee, feeType, requirements)`);
    output.log(`    - handlers.ts    (implement executeJob)`);
    output.log(
      `\n  Note: "description" is a one-sentence buyer-facing pitch (what the buyer gets).`
    );
    output.log(
      `        The input/output contract is rendered from "requirement" separately on the`
    );
    output.log(`        marketplace — don't duplicate I/O shape in the description.`);
    output.log(`\n  Next: edit the files, then run: yoso-agent sell create ${offeringName}\n`);
  });
}

export async function create(offeringName: string): Promise<void> {
  await checkForLegacyOfferings();
  if (!offeringName) {
    output.fatal("Usage: yoso-agent sell create <offering_name>");
  }

  const dir = resolveOfferingDir(offeringName);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    output.fatal(
      `Offering directory not found: ${dir}\n  Create it with: yoso-agent sell init ${offeringName}`
    );
  }

  output.log(`\nValidating offering: "${offeringName}"\n`);

  const allErrors: string[] = [];
  const allWarnings: string[] = [];

  // Validate offering.json
  output.log("  Checking offering.json...");
  const jsonPath = path.join(dir, "offering.json");
  const jsonResult = validateOfferingJson(jsonPath);
  allErrors.push(...jsonResult.errors);
  allWarnings.push(...jsonResult.warnings);

  let parsedOffering: OfferingJson | null = null;
  if (jsonResult.valid) {
    parsedOffering = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    output.log(`    Valid - Name: "${parsedOffering!.name}"`);
    output.log(`             Fee: ${parsedOffering!.jobFee} USDC`);
    output.log(`             Funds required: ${parsedOffering!.requiredFunds}`);
    if (parsedOffering!.resources?.length) {
      output.log(
        `             Resources: ${parsedOffering!.resources.map((resource) => resource.name).join(", ")}`
      );
    }
  } else {
    output.log("    Invalid");
  }

  // Validate handlers.ts
  output.log("\n  Checking handlers.ts...");
  const handlersPath = path.join(dir, "handlers.ts");
  const handlersResult = validateHandlers(handlersPath, parsedOffering?.requiredFunds);
  allErrors.push(...handlersResult.errors);
  allWarnings.push(...handlersResult.warnings);

  if (handlersResult.valid) {
    output.log("    Valid - executeJob handler found");
  } else {
    output.log("    Invalid");
  }

  output.log("\n" + "-".repeat(50));

  if (allWarnings.length > 0) {
    output.log("\n  Warnings:");
    allWarnings.forEach((w) => output.log(`    - ${w}`));
  }

  if (allErrors.length > 0) {
    output.log("\n  Errors:");
    allErrors.forEach((e) => output.log(`    - ${e}`));
    output.fatal("\n  Validation failed. Fix the errors above.");
  }

  output.log("\n  Validation passed!\n");

  // Register with marketplace
  const json: OfferingJson = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
  const payload = buildOfferingPayload(json);

  output.log("  Registering offering on marketplace...");
  const result = await createJobOffering(payload);

  if (result.success) {
    output.log("    Offering registered successfully.\n");
  } else {
    output.fatal("  Failed to register offering on marketplace.");
  }

  // Start seller if not running
  output.log("  Tip: Run `yoso-agent serve start` to begin accepting jobs.\n");

  // Best-effort nudge if the agent still has no marketplace description.
  await nudgeIfNoDescription();
}

export async function del(offeringName: string): Promise<void> {
  if (!offeringName) {
    output.fatal("Usage: yoso-agent sell delete <offering_name>");
  }

  output.log(`\n  Delisting offering: "${offeringName}"...\n`);

  const result = await deleteJobOffering(offeringName);

  if (result.success) {
    output.log("  Offering delisted from marketplace. Local files remain.\n");
  } else {
    output.fatal("  Failed to delist offering from marketplace.");
  }
}

interface LocalOffering {
  dirName: string;
  name: string;
  description: string;
  jobFee: number;
  jobFeeType: "fixed" | "percentage";
  requiredFunds: boolean;
  resources?: Resource[];
}

function listLocalOfferings(): LocalOffering[] {
  const offeringsRoot = getOfferingsRoot();
  if (!fs.existsSync(offeringsRoot)) return [];

  return fs
    .readdirSync(offeringsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const configPath = path.join(offeringsRoot, d.name, "offering.json");
      if (!fs.existsSync(configPath)) return null;
      try {
        const json = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        return {
          dirName: d.name,
          name: json.name ?? d.name,
          description: json.description ?? "",
          jobFee: json.jobFee ?? 0,
          jobFeeType: json.jobFeeType ?? "fixed",
          requiredFunds: json.requiredFunds ?? false,
          ...(json.resources && { resources: json.resources }),
        } as LocalOffering;
      } catch {
        return null;
      }
    })
    .filter((o): o is LocalOffering => o !== null);
}

interface RemoteOffering {
  name: string;
  priceV2?: { type: string; value: number };
  slaMinutes?: number;
  requiredFunds?: boolean;
}

async function fetchRemoteOfferings(): Promise<RemoteOffering[]> {
  try {
    const agentInfo = await getMyAgentInfo();
    return agentInfo.jobs ?? [];
  } catch {
    // API error - can't determine listing status
    return [];
  }
}

function remoteOfferingNames(remoteOfferings: RemoteOffering[]): Set<string> {
  return new Set(remoteOfferings.map((o) => o.name));
}

export async function list(): Promise<void> {
  await checkForLegacyOfferings();
  const remoteOfferings = await fetchRemoteOfferings();
  const remoteNames = remoteOfferingNames(remoteOfferings);
  const localOfferings = listLocalOfferings();
  const localNames = new Set(localOfferings.map((o) => o.name));

  const localData = localOfferings.map((o) => ({
    ...o,
    listed: remoteNames.has(o.name),
    remoteOnly: false as const,
  }));

  // Remote-only offerings: listed on marketplace but no local directory
  const remoteOnlyData = remoteOfferings
    .filter((o) => !localNames.has(o.name))
    .map((o) => ({
      dirName: "",
      name: o.name,
      description: "",
      jobFee: o.priceV2?.value ?? 0,
      jobFeeType: o.priceV2?.type ?? "fixed",
      requiredFunds: o.requiredFunds ?? false,
      resources: undefined,
      listed: true,
      remoteOnly: true as const,
    }));

  const data = [...localData, ...remoteOnlyData];

  output.output(data, (offerings) => {
    output.heading("Job Offerings");

    if (offerings.length === 0) {
      output.log("  No offerings found. Run `yoso-agent sell init <name>` to create one.\n");
      return;
    }

    for (const o of offerings) {
      const status = o.remoteOnly
        ? "Listed on marketplace (no local files)"
        : o.listed
          ? "Listed"
          : "Local only";
      output.log(`\n  ${o.name}`);
      if (!o.remoteOnly) {
        output.field("    Description", o.description);
      }
      output.field("    Fee", `${formatPrice(o.jobFee, o.jobFeeType)}`);
      output.field("    Funds required", String(o.requiredFunds));
      if (o.resources?.length) {
        output.field(
          "    Resources",
          o.resources.map((resource: Resource) => resource.name).join(", ")
        );
      }
      output.field("    Status", status);
      if (o.remoteOnly) {
        output.log(
          "    Tip: Run `yoso-agent sell delete " + o.name + "` to delist from marketplace"
        );
      }
    }
    output.log("");
  });
}

function detectHandlers(offeringDir: string): string[] {
  const handlersPath = path.join(getOfferingsRoot(), offeringDir, "handlers.ts");
  if (!fs.existsSync(handlersPath)) return [];

  const content = fs.readFileSync(handlersPath, "utf-8");
  const found: string[] = [];

  if (/export\s+(async\s+)?function\s+executeJob\s*\(/.test(content)) {
    found.push("executeJob");
  }
  if (/export\s+(async\s+)?function\s+validateRequirements\s*\(/.test(content)) {
    found.push("validateRequirements");
  }
  if (/export\s+(async\s+)?function\s+requestPayment\s*\(/.test(content)) {
    found.push("requestPayment");
  }
  if (/export\s+(async\s+)?function\s+requestAdditionalFunds\s*\(/.test(content)) {
    found.push("requestAdditionalFunds");
  }

  return found;
}

export async function inspect(offeringName: string): Promise<void> {
  if (!offeringName) {
    output.fatal("Usage: yoso-agent sell inspect <offering_name>");
  }

  const dir = resolveOfferingDir(offeringName);
  const configPath = path.join(dir, "offering.json");

  if (!fs.existsSync(configPath)) {
    output.fatal(`Offering not found: ${offeringName}`);
  }

  const json = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  const remoteOfferings = await fetchRemoteOfferings();
  const isListed = remoteOfferingNames(remoteOfferings).has(json.name);
  const handlers = detectHandlers(offeringName);

  const data = {
    ...json,
    listed: isListed,
    handlers,
  };

  output.output(data, (d) => {
    output.heading(`Offering: ${d.name}`);
    output.field("Description", d.description);
    output.field("Fee", `${d.jobFee} USDC`);
    output.field("Funds required", String(d.requiredFunds));
    output.field("Status", d.listed ? "Listed on marketplace" : "Local only");
    output.field("Handlers", d.handlers.join(", ") || "(none)");
    if (d.resources?.length) {
      output.log("\n  Resources:");
      for (const resource of d.resources as Resource[]) {
        output.log(`    - ${resource.name}: ${resource.url}`);
        if (resource.description) {
          output.log(`      ${resource.description}`);
        }
      }
    }
    if (d.requirement) {
      output.log("\n  Requirement Schema:");
      output.log(
        JSON.stringify(d.requirement, null, 4)
          .split("\n")
          .map((line: string) => `    ${line}`)
          .join("\n")
      );
    }
    output.log("");
  });
}
