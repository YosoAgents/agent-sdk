import * as fs from "fs";
import * as path from "path";
import { SDK_ROOT } from "./paths.js";
import { sanitizeAgentName } from "./config.js";
import { ensureGitignored } from "./git-guard.js";
import { warn } from "./output.js";

export interface ScaffoldResult {
  created: string[];
  skipped: string[];
}

const NPM_NAME_MAX = 214;
const DEFAULT_NAME = "yoso-agent-project";

function readSdkVersion(): string | null {
  try {
    const pkgPath = path.join(SDK_ROOT, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { version?: unknown };
    if (typeof pkg.version === "string" && pkg.version.trim()) return pkg.version.trim();
  } catch {
    /* fall through */
  }
  return null;
}

function resolveName(agentName: string): string {
  const sanitized = sanitizeAgentName(agentName);
  const base = sanitized || DEFAULT_NAME;
  return base.length > NPM_NAME_MAX ? base.slice(0, NPM_NAME_MAX) : base;
}

function writeIfAbsent(
  filePath: string,
  contents: string,
  result: ScaffoldResult,
  rel: string
): void {
  try {
    fs.writeFileSync(filePath, contents, { flag: "wx" });
    result.created.push(rel);
  } catch (e: unknown) {
    if (
      e &&
      typeof e === "object" &&
      "code" in e &&
      (e as NodeJS.ErrnoException).code === "EEXIST"
    ) {
      result.skipped.push(rel);
      return;
    }
    throw e;
  }
}

export function scaffoldProjectFiles(root: string, agentName: string): ScaffoldResult {
  const result: ScaffoldResult = { created: [], skipped: [] };

  const sdkVersion = readSdkVersion();
  if (!sdkVersion) {
    warn("Could not read yoso-agent SDK version; scaffolded package.json will pin `latest`.");
  }
  const dep = sdkVersion ? `^${sdkVersion}` : "latest";

  const pkg = {
    name: resolveName(agentName),
    private: true,
    type: "module" as const,
    scripts: {
      serve: "yoso-agent serve start",
    },
    dependencies: {
      "yoso-agent": dep,
    },
  };

  const tsconfig = {
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      resolveJsonModule: true,
    },
    include: ["src/**/*.ts"],
  };

  writeIfAbsent(
    path.join(root, "package.json"),
    JSON.stringify(pkg, null, 2) + "\n",
    result,
    "package.json"
  );

  writeIfAbsent(
    path.join(root, "tsconfig.json"),
    JSON.stringify(tsconfig, null, 2) + "\n",
    result,
    "tsconfig.json"
  );

  // ensureGitignored is a no-op outside git repos; safe to always call.
  try {
    ensureGitignored(root, ["node_modules/"]);
  } catch (e) {
    warn(`Could not update .gitignore: ${e instanceof Error ? e.message : String(e)}`);
  }

  return result;
}
