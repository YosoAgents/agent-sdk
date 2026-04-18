import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

export interface SecretFileStatus {
  isGitRepo: boolean;
  isTracked: boolean;
  isIgnored: boolean;
}

function runGit(root: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  try {
    const result = spawnSync("git", args, {
      cwd: root,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return {
      ok: result.status === 0,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  } catch {
    return { ok: false, stdout: "", stderr: "" };
  }
}

export function isGitRepo(root: string): boolean {
  return runGit(root, ["rev-parse", "--is-inside-work-tree"]).ok;
}

export function checkSecretFile(root: string, relPath: string): SecretFileStatus {
  if (!isGitRepo(root)) {
    return { isGitRepo: false, isTracked: false, isIgnored: false };
  }
  const isTracked = runGit(root, ["ls-files", "--error-unmatch", relPath]).ok;
  const isIgnored = runGit(root, ["check-ignore", "-q", relPath]).ok;
  return { isGitRepo: true, isTracked, isIgnored };
}

/**
 * Refuses to proceed if a secret-bearing file is tracked by git. No-op outside git.
 * Throws with actionable remediation instructions.
 */
export function assertSecretsNotTracked(root: string, relPaths: string[]): void {
  if (!isGitRepo(root)) return;
  const tracked = relPaths.filter((rel) => runGit(root, ["ls-files", "--error-unmatch", rel]).ok);
  if (tracked.length === 0) return;
  const list = tracked.join(" ");
  throw new Error(
    `The following files are tracked by git and would leak secrets if written: ${list}. ` +
      `Untrack with "git rm --cached ${list}" and commit, then add them to .gitignore and re-run.`
  );
}

/**
 * Ensure entries are effectively ignored at `root`. No-op outside git.
 *
 * - Creates .gitignore if absent.
 * - Appends entries that aren't already ignored.
 * - Refuses if an entry is explicitly un-ignored (e.g. `!.env`) — caller must fix manually.
 * - Verifies with `git check-ignore` after appending and fails if still not ignored.
 */
export function ensureGitignored(root: string, entries: string[]): void {
  if (!isGitRepo(root)) return;

  const gitignorePath = path.resolve(root, ".gitignore");
  const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf-8") : "";
  const existingLines = existing.split(/\r?\n/);

  const toAppend: string[] = [];
  for (const entry of entries) {
    const ignored = runGit(root, ["check-ignore", "-q", entry]).ok;
    if (ignored) continue;

    const escaped = entry.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    const negationPattern = new RegExp(`^\\s*!${escaped}\\s*$`);
    const hasNegation = existingLines.some((l) => negationPattern.test(l));
    if (hasNegation) {
      throw new Error(
        `.gitignore contains "!${entry}" which prevents ignoring. ` +
          `Remove the negation line and re-run, or use --keystore mode.`
      );
    }

    toAppend.push(entry);
  }

  if (toAppend.length === 0) return;

  const le = existing.includes("\r\n") ? "\r\n" : "\n";
  const header = "# yoso-agent";
  const hasHeader = existingLines.some((l) => l.trim() === header);

  let addition = "";
  if (existing && !existing.endsWith(le)) addition = le;
  if (!hasHeader) addition += header + le;
  addition += toAppend.join(le) + le;

  fs.writeFileSync(gitignorePath, existing + addition);

  for (const entry of toAppend) {
    const verified = runGit(root, ["check-ignore", "-q", entry]).ok;
    if (!verified) {
      throw new Error(
        `Added "${entry}" to .gitignore but git still does not ignore it. ` +
          `Check for overriding patterns in parent .gitignore or gitignore files.`
      );
    }
  }
}
