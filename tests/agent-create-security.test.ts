import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpawnSyncReturns } from "child_process";

type SpawnSyncFn = typeof import("child_process").spawnSync;

function makeResult(status: number): SpawnSyncReturns<string> {
  return {
    pid: 1,
    output: [null, "", ""],
    stdout: "",
    stderr: "",
    status,
    signal: null,
  };
}

let tempRoot: string;
let previousRoot: string | undefined;
let previousAgentPrivateKey: string | undefined;
let createAgentApiMock: ReturnType<typeof vi.fn>;
let spawnSyncMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yoso-agent-create-security-"));
  previousRoot = process.env.YOSO_AGENT_ROOT;
  previousAgentPrivateKey = process.env.AGENT_PRIVATE_KEY;
  process.env.YOSO_AGENT_ROOT = tempRoot;
  delete process.env.AGENT_PRIVATE_KEY;

  vi.resetModules();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);

  createAgentApiMock = vi.fn();
  vi.doMock("../src/lib/auth.js", () => ({
    createAgentApi: createAgentApiMock,
    ensureSessionIfAvailable: vi.fn(async () => null),
    fetchAgents: vi.fn(async () => []),
    getValidSessionToken: vi.fn(() => null),
    interactiveLogin: vi.fn(async () => undefined),
    isAgentApiKeyValid: vi.fn(async () => false),
    regenerateApiKey: vi.fn(async () => ({ apiKey: "yoso_regenerated" })),
    syncAgentsToConfig: vi.fn((agents) => agents),
  }));

  spawnSyncMock = vi.fn();
  vi.doMock("child_process", async () => {
    const actual = await vi.importActual<typeof import("child_process")>("child_process");
    return {
      ...actual,
      spawnSync: spawnSyncMock as unknown as SpawnSyncFn,
    };
  });
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.YOSO_AGENT_ROOT;
  else process.env.YOSO_AGENT_ROOT = previousRoot;

  if (previousAgentPrivateKey === undefined) delete process.env.AGENT_PRIVATE_KEY;
  else process.env.AGENT_PRIVATE_KEY = previousAgentPrivateKey;

  fs.rmSync(tempRoot, { recursive: true, force: true });
  vi.doUnmock("../src/lib/auth.js");
  vi.doUnmock("child_process");
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("agent create env-mode preflight", () => {
  it("refuses and does not call the API when .env is tracked by git", async () => {
    spawnSyncMock.mockImplementation((cmd: string, args: readonly string[]) => {
      if (cmd === "git" && args[0] === "rev-parse") return makeResult(0);
      if (cmd === "git" && args[0] === "ls-files" && args.includes(".env")) return makeResult(0); // tracked
      return makeResult(1);
    });

    vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit:${code}`);
    }) as never);

    const agent = await import("../src/commands/agent.js");
    await expect(agent.create("headless-agent", { useKeystore: false })).rejects.toThrow(
      "process.exit:1"
    );
    expect(createAgentApiMock).not.toHaveBeenCalled();
  });

  it("refuses and does not call the API when an env-mode agent already exists", async () => {
    // Pre-populate an env-mode agent in tempRoot
    fs.writeFileSync(
      path.join(tempRoot, ".env"),
      "# === yoso-agent: managed — do not edit by hand ===\n" +
        "AGENT_PRIVATE_KEY=0xexisting\n" +
        "# === end yoso-agent ===\n"
    );
    spawnSyncMock.mockImplementation((cmd: string, args: readonly string[]) => {
      if (cmd === "git" && args[0] === "rev-parse") return makeResult(1); // not a git repo
      return makeResult(1);
    });

    vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit:${code}`);
    }) as never);

    const agent = await import("../src/commands/agent.js");
    await expect(agent.create("second-agent", { useKeystore: false })).rejects.toThrow(
      "process.exit:1"
    );
    expect(createAgentApiMock).not.toHaveBeenCalled();
  });
});

describe("config.json invariant", () => {
  it("refuses to read a config that carries walletPrivateKey", async () => {
    fs.writeFileSync(
      path.join(tempRoot, "config.json"),
      JSON.stringify({
        YOSO_AGENT_API_KEY: "yoso_x",
        agents: [
          {
            id: "a",
            name: "rogue",
            walletAddress: "0x",
            apiKey: "yoso_x",
            walletPrivateKey: "0xplaintext",
            active: true,
          },
        ],
      })
    );

    const { readConfig } = await import("../src/lib/config.js");
    expect(() => readConfig()).toThrow(/Plaintext wallet keys are forbidden/);
  });
});
