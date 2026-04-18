import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// We test the canonical message format emitted by createAgentApi by stubbing
// the axios client and capturing the POST body. The goal is to pin the exact
// byte-for-byte contract the server's canonical parser depends on.

describe("createAgentApi canonical EIP-191 message (SDK #6/#B2)", () => {
  let savedAudience: string | undefined;

  beforeEach(() => {
    savedAudience = process.env.YOSO_CANONICAL_AUDIENCE;
    vi.resetModules();
  });

  afterEach(() => {
    if (savedAudience === undefined) {
      delete process.env.YOSO_CANONICAL_AUDIENCE;
    } else {
      process.env.YOSO_CANONICAL_AUDIENCE = savedAudience;
    }
    vi.restoreAllMocks();
  });

  it("constructs the 6-line canonical message in the exact order the server expects", async () => {
    process.env.YOSO_CANONICAL_AUDIENCE = "yoso.bet-test";

    const capturedBodies: unknown[] = [];

    vi.doMock("../src/lib/client.ts", () => ({
      default: {
        post: vi.fn(async (_path: string, body: unknown) => {
          capturedBodies.push(body);
          const { walletAddress } = body as { walletAddress: string };
          return {
            data: {
              agent: { id: "id-1", name: "test-agent", walletAddress },
              apiKey: "yoso_apikey_01234567",
            },
          };
        }),
      },
    }));

    const { createAgentApi } = await import("../src/lib/auth.ts");
    const result = await createAgentApi("test-agent");

    expect(result.walletAddress).toMatch(/^0x[0-9a-f]{40}$/);
    expect(result.apiKey).toBe("yoso_apikey_01234567");
    expect(result.walletPrivateKey).toMatch(/^0x[0-9a-f]{64}$/);

    const body = capturedBodies[0] as {
      name: string;
      walletAddress: string;
      message: string;
      signature: string;
    };

    expect(body.name).toBe("test-agent");
    expect(body.walletAddress).toBe(result.walletAddress);
    expect(body.signature).toMatch(/^0x[0-9a-f]{130}$/);

    const lines = body.message.split("\n");
    expect(lines).toHaveLength(6);
    expect(lines[0]).toBe("yoso agent registration");
    expect(lines[1]).toBe("audience: yoso.bet-test");
    expect(lines[2]).toBe("chainId: 999");
    expect(lines[3]).toBe(`address: ${body.walletAddress}`);
    expect(lines[4]).toMatch(
      /^nonce: [0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(lines[5]).toMatch(/^iat: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("rejects when the server echoes a different walletAddress (split-brain deploy)", async () => {
    process.env.YOSO_CANONICAL_AUDIENCE = "yoso.bet-test";

    vi.doMock("../src/lib/client.ts", () => ({
      default: {
        post: vi.fn(async () => ({
          data: {
            agent: {
              id: "id-1",
              name: "test-agent",
              walletAddress: "0x9999999999999999999999999999999999999999",
            },
            apiKey: "yoso_apikey_01234567",
          },
        })),
      },
    }));

    const { createAgentApi } = await import("../src/lib/auth.ts");
    await expect(createAgentApi("test-agent")).rejects.toThrow(/SDK\/server version mismatch/);
  });

  it("rejects when the server still returns a walletPrivateKey (legacy response shape)", async () => {
    process.env.YOSO_CANONICAL_AUDIENCE = "yoso.bet-test";

    let capturedWallet = "";
    vi.doMock("../src/lib/client.ts", () => ({
      default: {
        post: vi.fn(async (_path: string, body: unknown) => {
          const { walletAddress } = body as { walletAddress: string };
          capturedWallet = walletAddress;
          return {
            data: {
              agent: { id: "id-1", name: "test-agent", walletAddress },
              apiKey: "yoso_apikey_01234567",
              walletPrivateKey: "0xdeadbeef",
            },
          };
        }),
      },
    }));

    const { createAgentApi } = await import("../src/lib/auth.ts");
    await expect(createAgentApi("test-agent")).rejects.toThrow(/legacy code path/);
    expect(capturedWallet).toMatch(/^0x[0-9a-f]{40}$/);
  });
});
