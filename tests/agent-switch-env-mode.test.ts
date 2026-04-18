import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tempRoot: string;
let previousRoot: string | undefined;

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yoso-switch-env-"));
  previousRoot = process.env.YOSO_AGENT_ROOT;
  process.env.YOSO_AGENT_ROOT = tempRoot;

  vi.resetModules();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);

  vi.doMock("../src/lib/auth.js", () => ({
    createAgentApi: vi.fn(),
    ensureSessionIfAvailable: vi.fn(async () => null),
    fetchAgents: vi.fn(async () => []),
    getValidSessionToken: vi.fn(() => null),
    interactiveLogin: vi.fn(async () => undefined),
    isAgentApiKeyValid: vi.fn(async () => true),
    regenerateApiKey: vi.fn(async () => ({ apiKey: "yoso_new" })),
    syncAgentsToConfig: vi.fn((agents) => agents),
  }));
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.YOSO_AGENT_ROOT;
  else process.env.YOSO_AGENT_ROOT = previousRoot;

  fs.rmSync(tempRoot, { recursive: true, force: true });
  vi.doUnmock("../src/lib/auth.js");
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("agent switch in env mode", () => {
  it("errors when a managed block exists in .env", async () => {
    // Simulate env-mode state: managed block in .env + two agents in config.json
    fs.writeFileSync(
      path.join(tempRoot, ".env"),
      "# === yoso-agent: managed — do not edit by hand ===\n" +
        "AGENT_PRIVATE_KEY=0xactive\n" +
        "# === end yoso-agent ===\n"
    );
    fs.writeFileSync(
      path.join(tempRoot, "config.json"),
      JSON.stringify({
        YOSO_AGENT_API_KEY: "yoso_active",
        agents: [
          {
            id: "a",
            name: "active",
            walletAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            apiKey: "yoso_active",
            active: true,
          },
          {
            id: "b",
            name: "other",
            walletAddress: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            apiKey: "yoso_other",
            active: false,
          },
        ],
      })
    );

    vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit:${code}`);
    }) as never);

    const agent = await import("../src/commands/agent.js");
    await expect(agent.switchAgent("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")).rejects.toThrow(
      "process.exit:1"
    );
  });
});
