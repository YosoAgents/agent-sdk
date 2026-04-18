import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Wallet } from "ethers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tempRoot: string;
let previousRoot: string | undefined;
let previousAgentPrivateKey: string | undefined;

function passwordProvider(password: string) {
  return () => password;
}

async function importConfig() {
  return await import("../src/lib/config.js");
}

async function importKeystore() {
  return await import("../src/lib/keystore.js");
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yoso-keystore-test-"));
  previousRoot = process.env.YOSO_AGENT_ROOT;
  previousAgentPrivateKey = process.env.AGENT_PRIVATE_KEY;
  process.env.YOSO_AGENT_ROOT = tempRoot;
  delete process.env.AGENT_PRIVATE_KEY;
  vi.resetModules();
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.YOSO_AGENT_ROOT;
  else process.env.YOSO_AGENT_ROOT = previousRoot;

  if (previousAgentPrivateKey === undefined) delete process.env.AGENT_PRIVATE_KEY;
  else process.env.AGENT_PRIVATE_KEY = previousAgentPrivateKey;

  fs.rmSync(tempRoot, { recursive: true, force: true });
  vi.resetModules();
});

describe("config plaintext wallet key rejection", () => {
  it("rejects writes containing walletPrivateKey anywhere", async () => {
    const { writeConfig } = await importConfig();

    expect(() =>
      writeConfig({
        agents: [
          {
            id: "agent-1",
            name: "legacy",
            walletAddress: "0x0000000000000000000000000000000000000001",
            apiKey: "yoso_test",
            active: true,
            walletPrivateKey: "0xplaintext",
          },
        ],
      } as never)
    ).toThrow(/Plaintext wallet keys are forbidden/);
  });

  it("rejects legacy config containing walletPrivateKey", async () => {
    const { readConfig } = await importConfig();
    fs.writeFileSync(
      path.join(tempRoot, "config.json"),
      JSON.stringify({
        agents: [
          {
            id: "agent-1",
            name: "legacy",
            walletAddress: "0x0000000000000000000000000000000000000001",
            apiKey: "yoso_test",
            active: true,
            walletPrivateKey: "0xplaintext",
          },
        ],
      })
    );

    expect(() => readConfig()).toThrow(/Plaintext wallet keys are forbidden/);
  });

  it("syncAgentsToConfig preserves only allowed local agent fields", async () => {
    const { writeConfig } = await importConfig();
    const { syncAgentsToConfig } = await import("../src/lib/auth.js");

    writeConfig({
      agents: [
        {
          id: "agent-1",
          name: "local-name",
          walletAddress: "0x0000000000000000000000000000000000000001",
          apiKey: "yoso_local",
          active: true,
        },
      ],
    });

    const merged = syncAgentsToConfig([
      {
        id: "agent-1",
        name: "server-name",
        walletAddress: "0x0000000000000000000000000000000000000001",
      },
    ]);

    expect(merged).toEqual([
      {
        id: "agent-1",
        name: "server-name",
        walletAddress: "0x0000000000000000000000000000000000000001",
        apiKey: "yoso_local",
        active: true,
      },
    ]);
    expect(fs.readFileSync(path.join(tempRoot, "config.json"), "utf-8")).not.toContain(
      "walletPrivateKey"
    );
  });
});

describe("encrypted wallet keystore", () => {
  it("saves encrypted JSON without raw private key material", async () => {
    const { saveEncryptedWallet } = await importKeystore();
    const wallet = Wallet.createRandom();

    const saved = await saveEncryptedWallet(wallet.privateKey, wallet.address, {
      passwordProvider: passwordProvider("correct horse battery staple"),
    });

    const encryptedJson = fs.readFileSync(saved.path, "utf-8");
    expect(saved.walletAddress).toBe(wallet.address);
    expect(saved.path).toBe(
      path.join(tempRoot, "keystores", `${wallet.address.toLowerCase()}.json`)
    );
    expect(JSON.parse(encryptedJson)).toHaveProperty("address");
    expect(encryptedJson).not.toContain(wallet.privateKey);
    expect(encryptedJson).not.toContain(wallet.privateKey.slice(2));
  });

  it("loads a signing wallet from an encrypted keystore with the correct password", async () => {
    const { loadSigningWallet, saveEncryptedWallet } = await importKeystore();
    const wallet = Wallet.createRandom();
    const password = "keystore-password";

    await saveEncryptedWallet(wallet.privateKey, wallet.address, {
      passwordProvider: passwordProvider(password),
    });

    const loaded = await loadSigningWallet(wallet.address, {
      passwordProvider: passwordProvider(password),
    });

    expect(loaded.address).toBe(wallet.address);
    expect(loaded.privateKey).toBe(wallet.privateKey);
  });

  it("fails when the keystore password is wrong", async () => {
    const { loadSigningWallet, saveEncryptedWallet } = await importKeystore();
    const wallet = Wallet.createRandom();

    await saveEncryptedWallet(wallet.privateKey, wallet.address, {
      passwordProvider: passwordProvider("right-password"),
    });

    await expect(
      loadSigningWallet(wallet.address, {
        passwordProvider: passwordProvider("wrong-password"),
      })
    ).rejects.toThrow(/Failed to decrypt wallet keystore/);
  });

  it("loads AGENT_PRIVATE_KEY and validates the expected address", async () => {
    const { loadSigningWallet } = await importKeystore();
    const wallet = Wallet.createRandom();
    process.env.AGENT_PRIVATE_KEY = wallet.privateKey;

    const loaded = await loadSigningWallet(wallet.address, {
      passwordProvider: () => {
        throw new Error("keystore should not be read");
      },
    });

    expect(loaded.address).toBe(wallet.address);
    expect(loaded.privateKey).toBe(wallet.privateKey);
  });

  it("rejects AGENT_PRIVATE_KEY when it derives a different address", async () => {
    const { loadSigningWallet } = await importKeystore();
    const expected = Wallet.createRandom();
    const other = Wallet.createRandom();
    process.env.AGENT_PRIVATE_KEY = other.privateKey;

    await expect(loadSigningWallet(expected.address)).rejects.toThrow(
      /AGENT_PRIVATE_KEY derives wallet/
    );
  });
});
