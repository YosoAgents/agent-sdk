import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Wallet } from "ethers";

let tempRoot: string;
let previousRoot: string | undefined;
let previousAgentPrivateKey: string | undefined;
let previousApiKey: string | undefined;
let createAgentApiMock: ReturnType<typeof vi.fn>;

function mockWallet() {
  const w = Wallet.createRandom();
  return { privateKey: w.privateKey, walletAddress: w.address };
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yoso-keystore-migration-"));
  previousRoot = process.env.YOSO_AGENT_ROOT;
  previousAgentPrivateKey = process.env.AGENT_PRIVATE_KEY;
  previousApiKey = process.env.YOSO_AGENT_API_KEY;
  process.env.YOSO_AGENT_ROOT = tempRoot;
  delete process.env.AGENT_PRIVATE_KEY;
  delete process.env.YOSO_AGENT_API_KEY;

  vi.resetModules();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);

  createAgentApiMock = vi.fn();

  vi.doMock("../src/lib/auth.js", () => ({
    createAgentApi: createAgentApiMock,
    ensureSessionIfAvailable: vi.fn(async () => "session-token"),
    fetchAgents: vi.fn(async () => []),
    getValidSessionToken: vi.fn(() => "session-token"),
    interactiveLogin: vi.fn(async () => undefined),
    isAgentApiKeyValid: vi.fn(async () => false),
    regenerateApiKey: vi.fn(async () => ({ apiKey: "yoso_regen" })),
    syncAgentsToConfig: vi.fn((agents) => agents),
  }));

  vi.doMock("../src/commands/agent.js", async () => {
    const actual = await vi.importActual<typeof import("../src/commands/agent.js")>(
      "../src/commands/agent.js"
    );
    return {
      ...actual,
      stopSellerIfRunning: vi.fn(async () => true),
    };
  });

  // Stub the keystore saver — it tries to prompt for a password, which blocks non-TTY tests.
  vi.doMock("../src/lib/keystore.js", async () => {
    const actual =
      await vi.importActual<typeof import("../src/lib/keystore.js")>("../src/lib/keystore.js");
    return {
      ...actual,
      saveEncryptedWallet: vi.fn(async (_pk: string, address: string) => ({
        walletAddress: address,
        path: path.resolve(tempRoot, "keystores", `${address.toLowerCase()}.json`),
      })),
    };
  });
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.YOSO_AGENT_ROOT;
  else process.env.YOSO_AGENT_ROOT = previousRoot;
  if (previousAgentPrivateKey === undefined) delete process.env.AGENT_PRIVATE_KEY;
  else process.env.AGENT_PRIVATE_KEY = previousAgentPrivateKey;
  if (previousApiKey === undefined) delete process.env.YOSO_AGENT_API_KEY;
  else process.env.YOSO_AGENT_API_KEY = previousApiKey;

  fs.rmSync(tempRoot, { recursive: true, force: true });
  vi.doUnmock("../src/lib/auth.js");
  vi.doUnmock("../src/commands/agent.js");
  vi.doUnmock("../src/lib/keystore.js");
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("setup --keystore after env-mode setup", () => {
  it("removes the env managed block when switching to keystore mode", async () => {
    const setup = await import("../src/commands/setup.js");

    // Create agent A in env mode.
    const agentA = mockWallet();
    createAgentApiMock.mockResolvedValueOnce({
      id: "id-a",
      name: "agent-a",
      apiKey: "yoso_a",
      walletAddress: agentA.walletAddress,
      walletPrivateKey: agentA.privateKey,
    });
    await setup.setup({
      agentName: "agent-a",
      skipSystemPrompt: true,
      useKeystore: false,
    });

    // Sanity: .env has managed block with A's key.
    const envBefore = fs.readFileSync(path.join(tempRoot, ".env"), "utf-8");
    expect(envBefore).toContain("# === yoso-agent: managed");
    expect(envBefore).toContain(agentA.privateKey);

    // Now create agent B via --keystore.
    const agentB = mockWallet();
    createAgentApiMock.mockResolvedValueOnce({
      id: "id-b",
      name: "agent-b",
      apiKey: "yoso_b",
      walletAddress: agentB.walletAddress,
      walletPrivateKey: agentB.privateKey,
    });
    await setup.setup({
      agentName: "agent-b",
      skipSystemPrompt: true,
      useKeystore: true,
    });

    // Env block removed; A's key is no longer in .env.
    const envAfter = fs.existsSync(path.join(tempRoot, ".env"))
      ? fs.readFileSync(path.join(tempRoot, ".env"), "utf-8")
      : "";
    expect(envAfter).not.toContain("# === yoso-agent: managed");
    expect(envAfter).not.toContain(agentA.privateKey);
    expect(envAfter).not.toContain(agentB.privateKey);

    // process.env has B's API key, not A's; AGENT_PRIVATE_KEY cleared.
    expect(process.env.YOSO_AGENT_API_KEY).toBe("yoso_b");
    expect(process.env.AGENT_PRIVATE_KEY).toBeUndefined();
  });
});

describe("agent create --keystore after env-mode setup", () => {
  it("does not fail on AGENT_PRIVATE_KEY mismatch and clears env block", async () => {
    const setup = await import("../src/commands/setup.js");

    // Create agent A in env mode. dotenv-at-startup would load A's key into env.
    const agentA = mockWallet();
    createAgentApiMock.mockResolvedValueOnce({
      id: "id-a",
      name: "agent-a",
      apiKey: "yoso_a",
      walletAddress: agentA.walletAddress,
      walletPrivateKey: agentA.privateKey,
    });
    await setup.setup({
      agentName: "agent-a",
      skipSystemPrompt: true,
      useKeystore: false,
    });

    // Simulate the dotenv auto-load at CLI startup.
    process.env.AGENT_PRIVATE_KEY = agentA.privateKey;

    // Now add agent B via keystore in the same directory.
    const agentB = mockWallet();
    createAgentApiMock.mockResolvedValueOnce({
      id: "id-b",
      name: "agent-b",
      apiKey: "yoso_b",
      walletAddress: agentB.walletAddress,
      walletPrivateKey: agentB.privateKey,
    });

    const agent = await import("../src/commands/agent.js");
    await agent.create("agent-b", { useKeystore: true });

    // API was called (preflight didn't block multi-agent-via-keystore flow).
    expect(createAgentApiMock).toHaveBeenCalledTimes(2);

    // Env managed block removed.
    const envAfter = fs.readFileSync(path.join(tempRoot, ".env"), "utf-8");
    expect(envAfter).not.toContain("# === yoso-agent: managed");

    // process.env.AGENT_PRIVATE_KEY cleared (B now active via keystore).
    expect(process.env.AGENT_PRIVATE_KEY).toBeUndefined();
    expect(process.env.YOSO_AGENT_API_KEY).toBe("yoso_b");

    // Config has both agents, B active.
    const config = JSON.parse(fs.readFileSync(path.join(tempRoot, "config.json"), "utf-8"));
    expect(config.agents).toHaveLength(2);
    const activeAgent = config.agents.find((a: { active: boolean }) => a.active);
    expect(activeAgent.id).toBe("id-b");
  });
});
