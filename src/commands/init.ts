import * as fs from "fs";
import * as path from "path";
import { isJsonMode, json, log, success, warn, colors } from "../lib/output.js";
import { SDK_ROOT } from "../lib/config.js";

export async function init(force = false): Promise<void> {
  const skillDir = path.join(process.cwd(), ".claude", "skills", "yoso-agent");
  const skillPath = path.join(skillDir, "SKILL.md");
  const refsSourceDir = path.join(SDK_ROOT, "references");
  const refsTargetDir = path.join(skillDir, "references");

  // Read SKILL.md from SDK package
  const skillSource = path.join(SDK_ROOT, "SKILL.md");
  if (!fs.existsSync(skillSource)) {
    if (isJsonMode()) {
      json({ error: "SKILL.md not found in SDK package" });
    } else {
      console.error(colors.red("Error: SKILL.md not found in SDK package."));
    }
    process.exit(1);
  }

  // Check for existing installation
  if (fs.existsSync(skillPath) && !force) {
    if (isJsonMode()) {
      json({ error: "already_exists", path: skillPath });
    } else {
      warn(`Skill already installed at ${skillPath}`);
      log(`  Run with --force to overwrite.`);
    }
    process.exit(1);
  }

  // Write SKILL.md
  fs.mkdirSync(skillDir, { recursive: true });
  fs.copyFileSync(skillSource, skillPath);

  // Copy references/ directory
  let refsCopied = 0;
  if (fs.existsSync(refsSourceDir)) {
    fs.mkdirSync(refsTargetDir, { recursive: true });
    for (const file of fs.readdirSync(refsSourceDir)) {
      if (file.endsWith(".md")) {
        fs.copyFileSync(path.join(refsSourceDir, file), path.join(refsTargetDir, file));
        refsCopied++;
      }
    }
  }

  if (isJsonMode()) {
    json({
      installed: true,
      skillPath,
      referencesPath: refsTargetDir,
      referencesCopied: refsCopied,
    });
  } else {
    log("");
    success("YOSO Agent skill installed to .claude/skills/yoso-agent/");
    log("");
    log(`  ${colors.dim("Your AI assistant will auto-discover this skill on the next prompt.")}`);
    log(
      `  ${colors.dim("To deploy an agent, tell your assistant:")} ${colors.bold('"Set up a YOSO agent"')}`
    );
    log("");
    log(`  ${colors.dim("Or run manually:")}`);
    log(`    npx yoso-agent setup`);
    log("");
  }
}
