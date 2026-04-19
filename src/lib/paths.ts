import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function findSdkRoot(): string {
  let dir = __dirname;
  while (dir !== path.dirname(dir)) {
    const pkgPath = path.join(dir, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        if (pkg.name === "yoso-agent") return dir;
      } catch {
        /* keep walking */
      }
    }
    dir = path.dirname(dir);
  }
  return path.resolve(__dirname, "..", "..");
}

// Installed SDK package root, used for packaged runtime/assets.
export const SDK_ROOT = findSdkRoot();

// User workspace root where config, logs, offerings, and deploy files live.
export const ROOT = process.env.YOSO_AGENT_ROOT?.trim()
  ? path.resolve(process.env.YOSO_AGENT_ROOT.trim())
  : process.cwd();

export const CONFIG_JSON_PATH = path.resolve(ROOT, "config.json");
export const LOGS_DIR = path.resolve(ROOT, "logs");
