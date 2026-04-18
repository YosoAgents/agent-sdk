import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isGitRepo,
  checkSecretFile,
  assertSecretsNotTracked,
  ensureGitignored,
} from "../src/lib/git-guard.js";

let tempRoot: string;

function gitInit(root: string): void {
  const r = spawnSync("git", ["init", "--quiet"], { cwd: root, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git init failed: ${r.stderr}`);
  // Minimal git config so commits work without complaining in CI environments.
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: root });
  spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd: root });
}

function gitAddAndCommit(root: string, file: string, content: string): void {
  fs.writeFileSync(path.join(root, file), content);
  const r1 = spawnSync("git", ["add", file], { cwd: root, encoding: "utf-8" });
  if (r1.status !== 0) throw new Error(`git add failed: ${r1.stderr}`);
  const r2 = spawnSync("git", ["commit", "--quiet", "--no-verify", "-m", "add " + file], {
    cwd: root,
    encoding: "utf-8",
  });
  if (r2.status !== 0) throw new Error(`git commit failed: ${r2.stderr}`);
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yoso-git-guard-"));
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("git-guard", () => {
  it("isGitRepo returns false in a non-git directory", () => {
    expect(isGitRepo(tempRoot)).toBe(false);
  });

  it("isGitRepo returns true after git init", () => {
    gitInit(tempRoot);
    expect(isGitRepo(tempRoot)).toBe(true);
  });

  it("checkSecretFile reports untracked status correctly", () => {
    gitInit(tempRoot);
    fs.writeFileSync(path.join(tempRoot, ".gitignore"), ".env\n");
    gitAddAndCommit(tempRoot, ".gitignore", ".env\n");
    const status = checkSecretFile(tempRoot, ".env");
    expect(status.isGitRepo).toBe(true);
    expect(status.isTracked).toBe(false);
    expect(status.isIgnored).toBe(true);
  });

  it("checkSecretFile detects a tracked file", () => {
    gitInit(tempRoot);
    gitAddAndCommit(tempRoot, ".env", "SOMETHING=1\n");
    const status = checkSecretFile(tempRoot, ".env");
    expect(status.isTracked).toBe(true);
  });

  it("assertSecretsNotTracked is a no-op outside a git repo", () => {
    expect(() => assertSecretsNotTracked(tempRoot, [".env", "config.json"])).not.toThrow();
  });

  it("assertSecretsNotTracked throws when a file is tracked", () => {
    gitInit(tempRoot);
    gitAddAndCommit(tempRoot, ".env", "KEY=leaked\n");
    expect(() => assertSecretsNotTracked(tempRoot, [".env", "config.json"])).toThrow(
      /tracked by git/
    );
  });

  it("assertSecretsNotTracked passes when none of the given files are tracked", () => {
    gitInit(tempRoot);
    // Only .gitignore is tracked; .env and config.json are not.
    fs.writeFileSync(path.join(tempRoot, ".gitignore"), ".env\nconfig.json\n");
    gitAddAndCommit(tempRoot, ".gitignore", ".env\nconfig.json\n");
    expect(() => assertSecretsNotTracked(tempRoot, [".env", "config.json"])).not.toThrow();
  });

  it("ensureGitignored is a no-op outside a git repo", () => {
    ensureGitignored(tempRoot, [".env"]);
    expect(fs.existsSync(path.join(tempRoot, ".gitignore"))).toBe(false);
  });

  it("ensureGitignored creates .gitignore when absent and ignores the entries", () => {
    gitInit(tempRoot);
    ensureGitignored(tempRoot, [".env", "keystores/", "logs/"]);
    const gi = fs.readFileSync(path.join(tempRoot, ".gitignore"), "utf-8");
    expect(gi).toContain("# yoso-agent");
    expect(gi).toContain(".env");
    expect(gi).toContain("keystores/");
    expect(gi).toContain("logs/");
    // Verify git actually ignores them
    expect(checkSecretFile(tempRoot, ".env").isIgnored).toBe(true);
  });

  it("ensureGitignored skips entries that are already ignored", () => {
    gitInit(tempRoot);
    fs.writeFileSync(path.join(tempRoot, ".gitignore"), ".env\n");
    ensureGitignored(tempRoot, [".env"]);
    const gi = fs.readFileSync(path.join(tempRoot, ".gitignore"), "utf-8");
    // No yoso-agent header added, no duplicate .env line
    expect(gi).toBe(".env\n");
  });

  it("ensureGitignored refuses when entry is explicitly negated", () => {
    gitInit(tempRoot);
    fs.writeFileSync(path.join(tempRoot, ".gitignore"), "*.env\n!.env\n");
    expect(() => ensureGitignored(tempRoot, [".env"])).toThrow(/negation/);
  });

  it("ensureGitignored appends to an existing .gitignore", () => {
    gitInit(tempRoot);
    fs.writeFileSync(path.join(tempRoot, ".gitignore"), "node_modules/\n");
    ensureGitignored(tempRoot, [".env"]);
    const gi = fs.readFileSync(path.join(tempRoot, ".gitignore"), "utf-8");
    expect(gi).toContain("node_modules/");
    expect(gi).toContain("# yoso-agent");
    expect(gi).toContain(".env");
  });
});
