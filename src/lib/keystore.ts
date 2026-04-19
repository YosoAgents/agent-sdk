import * as fs from "fs";
import * as path from "path";
import { getAddress, Wallet } from "ethers";
import { ROOT } from "./paths.js";

export type KeystorePasswordPurpose = "encrypt" | "encrypt-confirm" | "decrypt";

export type KeystorePasswordProvider = (request: {
  walletAddress: string;
  purpose: KeystorePasswordPurpose;
  prompt: string;
}) => string | Promise<string>;

export interface EncryptedWalletMetadata {
  walletAddress: string;
  path: string;
}

export interface KeystoreOptions {
  passwordProvider?: KeystorePasswordProvider;
  keystorePath?: string;
}

function normalizeWalletAddress(walletAddress: string): string {
  try {
    return getAddress(walletAddress);
  } catch {
    throw new Error(`Invalid wallet address: ${walletAddress}`);
  }
}

function getEncryptedWalletPath(walletAddress: string): string {
  const normalized = normalizeWalletAddress(walletAddress);
  return path.resolve(ROOT, "keystores", `${normalized.toLowerCase()}.json`);
}

function createWalletFromPrivateKey(privateKey: string, source: string): Wallet {
  try {
    return new Wallet(privateKey.trim());
  } catch {
    throw new Error(`${source} is not a valid Ethereum private key.`);
  }
}

function assertWalletMatches(wallet: Wallet, expectedWalletAddress: string, source: string): void {
  const expected = normalizeWalletAddress(expectedWalletAddress);
  if (wallet.address.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`${source} derives wallet ${wallet.address}, but expected ${expected}.`);
  }
}

function assertNonEmptyPassword(password: string): string {
  if (!password) {
    throw new Error("Keystore password cannot be empty.");
  }
  return password;
}

export function isKeystorePasswordPromptAvailable(): boolean {
  return (
    process.stdin.isTTY === true &&
    process.stdout.isTTY === true &&
    typeof process.stdin.setRawMode === "function"
  );
}

export function hasAgentPrivateKeyOverride(): boolean {
  return !!process.env.AGENT_PRIVATE_KEY?.trim();
}

export function canStoreReturnedWalletKey(allowKeystorePrompt: boolean): boolean {
  return (
    hasAgentPrivateKeyOverride() || (allowKeystorePrompt && isKeystorePasswordPromptAvailable())
  );
}

export function assertReturnedWalletKeyCanBeStored(
  allowKeystorePrompt: boolean,
  flow: string
): void {
  if (canStoreReturnedWalletKey(allowKeystorePrompt)) return;
  throw new Error(
    `${flow} requires AGENT_PRIVATE_KEY because hidden password entry requires an interactive terminal. Run \`yoso-agent setup\` interactively, or set AGENT_PRIVATE_KEY for automation/headless use.`
  );
}

async function promptHidden(prompt: string): Promise<string> {
  const input = process.stdin;
  const out = process.stdout;
  if (!isKeystorePasswordPromptAvailable()) {
    throw new Error(
      "Hidden password prompt is unavailable. Run this command in an interactive terminal, or set AGENT_PRIVATE_KEY for automation/headless use."
    );
  }

  return await new Promise<string>((resolve, reject) => {
    let password = "";
    let settled = false;

    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      out.write("\n");
    };

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err);
      else resolve(password);
    };

    const onData = (chunk: Buffer | string) => {
      const text = chunk.toString("utf-8");
      for (const char of text) {
        if (char === "\u0003") {
          finish(new Error("Password prompt cancelled."));
          return;
        }
        if (char === "\r" || char === "\n") {
          finish();
          return;
        }
        if (char === "\u007f" || char === "\b") {
          password = password.slice(0, -1);
          continue;
        }
        if (char >= " ") {
          password += char;
        }
      }
    };

    out.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

async function getPassword(
  walletAddress: string,
  purpose: KeystorePasswordPurpose,
  provider: KeystorePasswordProvider | undefined
): Promise<string> {
  const prompt =
    purpose === "encrypt"
      ? "  Keystore password: "
      : purpose === "encrypt-confirm"
        ? "  Confirm keystore password: "
        : "  Keystore password: ";
  const password = provider
    ? await provider({ walletAddress, purpose, prompt })
    : await promptHidden(prompt);
  if (typeof password !== "string") {
    throw new Error("Keystore password provider must return a string.");
  }
  return assertNonEmptyPassword(password);
}

export function getKeystorePath(walletAddress: string): string {
  return getEncryptedWalletPath(walletAddress);
}

export function hasEncryptedWallet(walletAddress: string): boolean {
  return fs.existsSync(getEncryptedWalletPath(walletAddress));
}

export function validateAgentPrivateKeyOverride(expectedWalletAddress: string): Wallet | null {
  const privateKey = process.env.AGENT_PRIVATE_KEY?.trim();
  if (!privateKey) return null;
  const wallet = createWalletFromPrivateKey(privateKey, "AGENT_PRIVATE_KEY");
  assertWalletMatches(wallet, expectedWalletAddress, "AGENT_PRIVATE_KEY");
  return wallet;
}

export async function saveEncryptedWallet(
  privateKey: string,
  expectedWalletAddress: string,
  options: KeystoreOptions = {}
): Promise<EncryptedWalletMetadata> {
  const wallet = createWalletFromPrivateKey(privateKey, "Wallet private key");
  const walletAddress = normalizeWalletAddress(expectedWalletAddress);
  assertWalletMatches(wallet, walletAddress, "Wallet private key");

  const password = await getPassword(walletAddress, "encrypt", options.passwordProvider);
  const confirmation = await getPassword(
    walletAddress,
    "encrypt-confirm",
    options.passwordProvider
  );
  if (password !== confirmation) {
    throw new Error("Keystore passwords did not match.");
  }

  const keystorePath = options.keystorePath ?? getEncryptedWalletPath(walletAddress);
  fs.mkdirSync(path.dirname(keystorePath), { recursive: true, mode: 0o700 });
  const encryptedJson = await wallet.encrypt(password);
  fs.writeFileSync(keystorePath, encryptedJson + "\n", { mode: 0o600 });
  fs.chmodSync(keystorePath, 0o600);

  return { walletAddress, path: keystorePath };
}

export async function loadSigningWallet(
  expectedWalletAddress: string,
  options: KeystoreOptions = {}
): Promise<Wallet> {
  const walletAddress = normalizeWalletAddress(expectedWalletAddress);
  const overrideWallet = validateAgentPrivateKeyOverride(walletAddress);
  if (overrideWallet) return overrideWallet;

  const keystorePath = options.keystorePath ?? getEncryptedWalletPath(walletAddress);
  if (!fs.existsSync(keystorePath)) {
    throw new Error(
      `No encrypted wallet keystore found for ${walletAddress} at ${keystorePath}. Run yoso-agent setup in an interactive terminal to encrypt the wallet key, or set AGENT_PRIVATE_KEY for automation/headless use.`
    );
  }

  const password = await getPassword(walletAddress, "decrypt", options.passwordProvider);
  const encryptedJson = fs.readFileSync(keystorePath, "utf-8");
  let decrypted: Wallet;
  try {
    const wallet = await Wallet.fromEncryptedJson(encryptedJson, password);
    decrypted = new Wallet(wallet.privateKey);
  } catch {
    throw new Error("Failed to decrypt wallet keystore. Check the keystore password.");
  }
  assertWalletMatches(decrypted, walletAddress, "Encrypted wallet keystore");
  return decrypted;
}

export function assertNoPlaintextPrivateKeys(config: unknown): void {
  const seen = new WeakSet<object>();

  const visit = (value: unknown, pathParts: string[]): void => {
    if (typeof value !== "object" || value === null) return;
    if (seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...pathParts, String(index)]));
      return;
    }

    for (const [key, child] of Object.entries(value)) {
      if (key === "walletPrivateKey") {
        const location = [...pathParts, key].join(".");
        throw new Error(
          `Plaintext wallet keys are forbidden in config.json (${location}). Remove walletPrivateKey and import the key into an encrypted keystore, or set AGENT_PRIVATE_KEY for automation/headless use.`
        );
      }
      visit(child, [...pathParts, key]);
    }
  };

  visit(config, []);
}
