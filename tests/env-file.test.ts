import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  envFilePath,
  readYosoBlock,
  hasEnvModeAgent,
  hasConflictingKeyOutsideBlock,
  writeYosoBlock,
  removeYosoBlock,
} from "../src/lib/env-file.js";

let tempRoot: string;

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yoso-env-file-"));
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("env-file", () => {
  it("reports no block when .env does not exist", () => {
    expect(hasEnvModeAgent(tempRoot)).toBe(false);
    expect(readYosoBlock(tempRoot)).toEqual({ found: false, entries: {} });
  });

  it("writes a new .env with the managed block when file is absent", () => {
    writeYosoBlock(tempRoot, { AGENT_PRIVATE_KEY: "0xdeadbeef" });

    const content = fs.readFileSync(envFilePath(tempRoot), "utf-8");
    expect(content).toContain("# === yoso-agent: managed");
    expect(content).toContain("AGENT_PRIVATE_KEY=0xdeadbeef");
    expect(content).toContain("# === end yoso-agent ===");
    expect(hasEnvModeAgent(tempRoot)).toBe(true);
    expect(readYosoBlock(tempRoot).entries).toEqual({ AGENT_PRIVATE_KEY: "0xdeadbeef" });
  });

  it("preserves existing content when appending the block", () => {
    fs.writeFileSync(envFilePath(tempRoot), "# user comment\nSOME_OTHER_VAR=42\nANOTHER=hello\n");
    writeYosoBlock(tempRoot, { AGENT_PRIVATE_KEY: "0xabc" });

    const content = fs.readFileSync(envFilePath(tempRoot), "utf-8");
    expect(content).toContain("SOME_OTHER_VAR=42");
    expect(content).toContain("ANOTHER=hello");
    expect(content).toContain("AGENT_PRIVATE_KEY=0xabc");
  });

  it("replaces an existing managed block in-place without touching outside content", () => {
    const initial =
      "TOP=one\n# === yoso-agent: managed — do not edit by hand ===\nAGENT_PRIVATE_KEY=0xold\n# === end yoso-agent ===\nBOTTOM=two\n";
    fs.writeFileSync(envFilePath(tempRoot), initial);

    writeYosoBlock(tempRoot, { AGENT_PRIVATE_KEY: "0xnew" });

    const content = fs.readFileSync(envFilePath(tempRoot), "utf-8");
    expect(content).toContain("TOP=one");
    expect(content).toContain("BOTTOM=two");
    expect(content).toContain("AGENT_PRIVATE_KEY=0xnew");
    expect(content).not.toContain("AGENT_PRIVATE_KEY=0xold");
  });

  it("preserves CRLF line endings when the file uses them", () => {
    const crlf = "FIRST=1\r\nSECOND=2\r\n";
    fs.writeFileSync(envFilePath(tempRoot), crlf);
    writeYosoBlock(tempRoot, { AGENT_PRIVATE_KEY: "0xcrlf" });

    const content = fs.readFileSync(envFilePath(tempRoot), "utf-8");
    expect(content).toContain("\r\n");
    // Any LFs present must be part of a CRLF pair
    const bareLF = /(?<!\r)\n/.test(content);
    expect(bareLF).toBe(false);
  });

  it("detects conflicting key outside the managed block", () => {
    fs.writeFileSync(envFilePath(tempRoot), "AGENT_PRIVATE_KEY=0xzzz\n");
    const result = hasConflictingKeyOutsideBlock(tempRoot, "AGENT_PRIVATE_KEY", "0xnew");
    expect(result.conflict).toBe(true);
    expect(result.existingValue).toBe("0xzzz");
  });

  it("does not flag the same key inside the managed block as a conflict", () => {
    writeYosoBlock(tempRoot, { AGENT_PRIVATE_KEY: "0xnew" });
    const result = hasConflictingKeyOutsideBlock(tempRoot, "AGENT_PRIVATE_KEY", "0xnew");
    expect(result.conflict).toBe(false);
  });

  it("handles `export KEY=` prefix in conflict detection", () => {
    fs.writeFileSync(envFilePath(tempRoot), "export AGENT_PRIVATE_KEY=0xshell\n");
    const result = hasConflictingKeyOutsideBlock(tempRoot, "AGENT_PRIVATE_KEY", "0xnew");
    expect(result.conflict).toBe(true);
  });

  it("ignores quoted values when checking conflict", () => {
    fs.writeFileSync(envFilePath(tempRoot), `AGENT_PRIVATE_KEY="0xsame"\n`);
    const result = hasConflictingKeyOutsideBlock(tempRoot, "AGENT_PRIVATE_KEY", "0xsame");
    expect(result.conflict).toBe(false);
  });

  it("removes the managed block without touching outside content", () => {
    const initial =
      "TOP=one\n# === yoso-agent: managed — do not edit by hand ===\nAGENT_PRIVATE_KEY=0x\n# === end yoso-agent ===\nBOTTOM=two\n";
    fs.writeFileSync(envFilePath(tempRoot), initial);

    removeYosoBlock(tempRoot);

    const content = fs.readFileSync(envFilePath(tempRoot), "utf-8");
    expect(content).not.toContain("yoso-agent: managed");
    expect(content).toContain("TOP=one");
    expect(content).toContain("BOTTOM=two");
    expect(hasEnvModeAgent(tempRoot)).toBe(false);
  });

  it("writes .env with 0o600 permissions where supported", () => {
    writeYosoBlock(tempRoot, { AGENT_PRIVATE_KEY: "0x" });
    const stat = fs.statSync(envFilePath(tempRoot));
    // Windows reports 0666/0444 regardless; only assert on Unix.
    if (process.platform !== "win32") {
      expect(stat.mode & 0o777).toBe(0o600);
    } else {
      expect(stat.isFile()).toBe(true);
    }
  });
});
