import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tempRoot: string;
let previousRoot: string | undefined;
let previousAgentPrivateKey: string | undefined;
let previousApiKey: string | undefined;
let createAgentApiMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yoso-setup-env-"));
  previousRoot = process.env.YOSO_AGENT_ROOT;
  previousAgentPrivateKey = process.env.AGENT_PRIVATE_KEY;
  previousApiKey = process.env.YOSO_AGENT_API_KEY;
  process.env.YOSO_AGENT_ROOT = tempRoot;
  delete process.env.AGENT_PRIVATE_KEY;
  delete process.env.YOSO_AGENT_API_KEY;

  vi.resetModules();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);

  createAgentApiMock = vi.fn(async () => ({
    id: "agent-123",
    name: "test-agent",
    apiKey: "yoso_testkey",
    walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
    walletPrivateKey: "0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
  }));

  vi.doMock("../src/lib/auth.js", () => ({
    createAgentApi: createAgentApiMock,
    ensureSessionIfAvailable: vi.fn(async () => "session-token"),
    fetchAgents: vi.fn(async () => []),
    getValidSessionToken: vi.fn(() => "session-token"),
    interactiveLogin: vi.fn(async () => undefined),
    isAgentApiKeyValid: vi.fn(async () => false),
    regenerateApiKey: vi.fn(async () => ({ apiKey: "yoso_regenerated" })),
    syncAgentsToConfig: vi.fn((agents) => agents),
  }));

  // Short-circuit seller-runtime check and avoid readline opening.
  vi.doMock("../src/commands/agent.js", async () => {
    const actual = await vi.importActual<typeof import("../src/commands/agent.js")>(
      "../src/commands/agent.js"
    );
    return {
      ...actual,
      stopSellerIfRunning: vi.fn(async () => true),
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
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("setup --name --yes (env-mode default)", () => {
  it("writes AGENT_PRIVATE_KEY to .env and agent metadata to config.json", async () => {
    const setup = await import("../src/commands/setup.js");
    await setup.setup({
      agentName: "test-agent",
      skipSystemPrompt: true,
      useKeystore: false,
    });

    // Agent was created server-side
    expect(createAgentApiMock).toHaveBeenCalledTimes(1);

    // .env contains the managed block with AGENT_PRIVATE_KEY
    const envPath = path.join(tempRoot, ".env");
    expect(fs.existsSync(envPath)).toBe(true);
    const envContent = fs.readFileSync(envPath, "utf-8");
    expect(envContent).toContain("# === yoso-agent: managed");
    expect(envContent).toContain(
      "AGENT_PRIVATE_KEY=0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
    );
    // API key is NOT written to .env (would break switch semantics)
    expect(envContent).not.toContain("YOSO_AGENT_API_KEY");

    // config.json contains API key and agent metadata, not wallet private key
    const configPath = path.join(tempRoot, "config.json");
    expect(fs.existsSync(configPath)).toBe(true);
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(config.YOSO_AGENT_API_KEY).toBe("yoso_testkey");
    expect(config.agents).toHaveLength(1);
    expect(config.agents[0].walletAddress).toBe("0x1234567890abcdef1234567890abcdef12345678");
    expect(JSON.stringify(config)).not.toContain("walletPrivateKey");

    // No keystore directory was created
    expect(fs.existsSync(path.join(tempRoot, "keystores"))).toBe(false);

    // AGENT_PRIVATE_KEY is also exported to process.env for this process
    expect(process.env.AGENT_PRIVATE_KEY).toBe(
      "0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
    );
  });

  it("refuses to create a second env-mode agent in the same directory", async () => {
    const setup = await import("../src/commands/setup.js");

    await setup.setup({
      agentName: "first-agent",
      skipSystemPrompt: true,
      useKeystore: false,
    });

    const firstCalls = createAgentApiMock.mock.calls.length;

    // Second attempt should fail preflight before calling the API
    await setup.setup({
      agentName: "second-agent",
      skipSystemPrompt: true,
      useKeystore: false,
    });

    expect(createAgentApiMock.mock.calls.length).toBe(firstCalls);

    // First agent's key is still intact
    const envContent = fs.readFileSync(path.join(tempRoot, ".env"), "utf-8");
    expect(envContent).toContain(
      "AGENT_PRIVATE_KEY=0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
    );
  });
});

describe("agent create (env-mode default)", () => {
  it("refuses when an env-mode agent already exists in the directory", async () => {
    const setup = await import("../src/commands/setup.js");
    await setup.setup({
      agentName: "first-agent",
      skipSystemPrompt: true,
      useKeystore: false,
    });

    const firstCalls = createAgentApiMock.mock.calls.length;

    vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit:${code}`);
    }) as never);

    const agent = await import("../src/commands/agent.js");
    await expect(agent.create("second", { useKeystore: false })).rejects.toThrow("process.exit:1");
    expect(createAgentApiMock.mock.calls.length).toBe(firstCalls);
  });
});
