import * as fs from "fs";
import * as path from "path";
import * as output from "../lib/output.js";
import { ROOT, getActiveAgent } from "../lib/config.js";

const OFFERINGS_BASE = path.resolve(ROOT, "src", "seller", "offerings");

// Copy offering folders from the legacy name-based layout
// (`src/seller/offerings/<anything>/<offering>/`) to the wallet-based layout
// (`src/seller/offerings/<walletAddress>/<offering>/`). Scans every sibling
// directory rather than deriving the legacy name from `agent.name` — after a
// rename, `config.json` holds the NEW name, so the old folder is otherwise
// undiscoverable. Leaves old files in place so failed migrations are fully
// recoverable.
export async function offerings(): Promise<void> {
  const agent = getActiveAgent();
  if (!agent) {
    output.fatal("No active agent. Run `yoso-agent setup` first.");
  }

  const walletDir = agent.walletAddress.toLowerCase();
  const walletPath = path.resolve(OFFERINGS_BASE, walletDir);

  if (!fs.existsSync(OFFERINGS_BASE)) {
    output.log(`\n  ${OFFERINGS_BASE} does not exist yet. Nothing to migrate.\n`);
    return;
  }

  const legacyDirs = fs
    .readdirSync(OFFERINGS_BASE, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== walletDir)
    .map((d) => d.name);

  type LegacySource = { legacyName: string; legacyPath: string; offerings: string[] };
  const sources: LegacySource[] = [];
  for (const legacyName of legacyDirs) {
    const legacyPath = path.resolve(OFFERINGS_BASE, legacyName);
    const offeringEntries = fs
      .readdirSync(legacyPath, { withFileTypes: true })
      .filter(
        (d) => d.isDirectory() && fs.existsSync(path.join(legacyPath, d.name, "offering.json"))
      )
      .map((d) => d.name);

    if (offeringEntries.length > 0) {
      sources.push({ legacyName, legacyPath, offerings: offeringEntries });
    }
  }

  if (sources.length === 0) {
    output.log(
      `\n  No legacy offerings folders found under src/seller/offerings/.\n  Nothing to migrate.\n`
    );
    return;
  }

  fs.mkdirSync(walletPath, { recursive: true });

  let migrated = 0;
  let skipped = 0;

  for (const { legacyName, legacyPath, offerings: entries } of sources) {
    output.log(`\n  From src/seller/offerings/${legacyName}/:`);
    for (const entry of entries) {
      const src = path.join(legacyPath, entry);
      const dest = path.join(walletPath, entry);
      if (fs.existsSync(dest)) {
        output.log(`    skip  ${entry}  (already migrated)`);
        skipped += 1;
        continue;
      }
      copyRecursive(src, dest);
      output.log(`    copy  ${entry}  ->  ${walletDir}/`);
      migrated += 1;
    }

    const readmePath = path.join(legacyPath, "README.MIGRATED.md");
    if (migrated > 0 && !fs.existsSync(readmePath)) {
      const readme =
        `# Offerings migrated\n\n` +
        `These offerings have been copied to \`src/seller/offerings/${walletDir}/\`.\n` +
        `The new path is wallet-based and survives agent renames.\n\n` +
        `Once you have confirmed the seller runtime reads from the new path (run \`yoso-agent serve start\`),\n` +
        `it is safe to delete this directory.\n`;
      fs.writeFileSync(readmePath, readme, "utf-8");
    }
  }

  output.heading("Migration Complete");
  output.log(`  migrated: ${migrated}`);
  output.log(`  skipped:  ${skipped}`);
  output.log(`  new path: src/seller/offerings/${walletDir}/\n`);
  if (migrated > 0) {
    output.log(
      `  Old files remain under ${sources.map((s) => `src/seller/offerings/${s.legacyName}/`).join(", ")} for rollback safety.\n` +
        `  After verifying the seller starts cleanly, delete the old dirs manually.\n`
    );
  }
}

function copyRecursive(src: string, dest: string): void {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}
