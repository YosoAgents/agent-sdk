import readline from "readline";
import { findAgentByWalletAddress } from "../lib/config.js";
import { loadSigningWallet } from "../lib/keystore.js";
import * as output from "../lib/output.js";

interface LinkWebOptions {
  yes?: boolean;
}

interface LinkChallengePayload {
  nonce: string;
  message: string;
  privyUserId: string;
  walletAddress: string;
  expiresAt: string;
}

interface LinkWebResult {
  walletAddress: string;
  privyUserId: string;
  nonce: string;
  expiresAt: string;
  agentName: string | null;
  signature: string;
}

const WALLET_RE = /^0x[a-fA-F0-9]{40}$/;
const NONCE_RE = /^[0-9a-f]{32}$/;

export async function linkWeb(
  payloadArg: string | undefined,
  opts: LinkWebOptions = {}
): Promise<void> {
  if (!payloadArg || payloadArg.trim().length === 0) {
    output.fatal("Usage: yoso-agent link-web <payload>");
  }

  const payload = decodePayload(payloadArg.trim());
  validatePayload(payload);
  const walletAddress = payload.walletAddress;

  const agent = findAgentByWalletAddress(walletAddress);

  if (!output.isJsonMode()) {
    output.heading("Link web account");
    output.field("Wallet", walletAddress);
    output.field("Privy user", payload.privyUserId);
    output.field("Agent", agent?.name ?? "not found locally");
    output.field("Expires", payload.expiresAt);
    output.log(
      "\n  This signs a one-time yoso.sh challenge. It does not send your private key."
    );
  }

  if (!opts.yes) {
    const confirmed = await confirmSign(walletAddress);
    if (!confirmed) output.fatal("Cancelled.");
    if (!output.isJsonMode()) output.log("  Signing in 2 seconds...");
    await sleep(2000);
  }

  const wallet = await loadSigningWallet(walletAddress);
  const signature = await wallet.signMessage(payload.message);

  output.output<LinkWebResult>(
    {
      walletAddress,
      privyUserId: payload.privyUserId,
      nonce: payload.nonce,
      expiresAt: payload.expiresAt,
      agentName: agent?.name ?? null,
      signature,
    },
    (data) => {
      output.success("Challenge signed.");
      output.log("\n  Paste this signature back into yoso.sh:\n");
      output.log(data.signature);
      output.log("");
    }
  );
}

function decodePayload(rawPayload: string): LinkChallengePayload {
  let decoded: string;
  try {
    decoded = Buffer.from(rawPayload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
      "utf8"
    );
  } catch {
    output.fatal("Challenge payload is not valid base64.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    output.fatal("Challenge payload is not valid JSON.");
  }

  if (!parsed || typeof parsed !== "object") {
    output.fatal("Challenge payload is invalid.");
  }

  const payload = parsed as Partial<LinkChallengePayload>;
  return {
    nonce: readString(payload, "nonce"),
    message: readString(payload, "message"),
    privyUserId: readString(payload, "privyUserId"),
    walletAddress: readString(payload, "walletAddress"),
    expiresAt: readString(payload, "expiresAt"),
  };
}

function readString(payload: Partial<LinkChallengePayload>, key: keyof LinkChallengePayload): string {
  const value = payload[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    output.fatal(`Challenge payload is missing ${key}.`);
  }
  return value;
}

function validatePayload(payload: LinkChallengePayload): void {
  if (!NONCE_RE.test(payload.nonce)) {
    output.fatal("Challenge payload has an invalid nonce.");
  }
  if (!WALLET_RE.test(payload.walletAddress)) {
    output.fatal("Challenge payload has an invalid wallet address.");
  }

  const expiresAtMs = Date.parse(payload.expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    output.fatal("Challenge payload has an invalid expiry.");
  }
  if (expiresAtMs <= Date.now()) {
    output.fatal("Challenge payload has expired. Request a new challenge in yoso.sh.");
  }

  const expected = buildExpectedMessage(payload);
  if (payload.message !== expected) {
    output.fatal("Challenge payload message is invalid or has been altered.");
  }
}

function buildExpectedMessage(payload: LinkChallengePayload): string {
  return [
    "yoso.sh — link wallet to Privy account",
    "",
    `Privy user: ${payload.privyUserId}`,
    `Wallet: ${payload.walletAddress}`,
    `Nonce: ${payload.nonce}`,
    `Expires: ${payload.expiresAt}`,
  ].join("\n");
}

async function confirmSign(walletAddress: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || output.isJsonMode()) {
    output.fatal("Refusing to sign non-interactively without --yes.");
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(`  Sign this web-link challenge with ${walletAddress}? [y/N] `, resolve);
    });
    return ["y", "yes"].includes(answer.trim().toLowerCase());
  } finally {
    rl.close();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
