import { ethers } from "ethers";
import dotenv from "dotenv";

dotenv.config();

export interface HyperliquidConfig {
  privateKey: string;
  walletAddress: string;
  testnet: boolean;
  allowLiveTrading: boolean;
}

export function loadHyperliquidConfig(): HyperliquidConfig | null {
  const privateKey = process.env.HYPERLIQUID_PRIVATE_KEY?.trim();
  const walletAddress = process.env.HYPERLIQUID_WALLET_ADDRESS?.trim();

  if (!privateKey || !walletAddress) {
    return null;
  }

  if (!privateKey.startsWith("0x") || privateKey.length < 64) {
    throw new Error("HYPERLIQUID_PRIVATE_KEY must be a hex private key (0x-prefixed, 64+ chars)");
  }
  if (!walletAddress.startsWith("0x") || walletAddress.length !== 42) {
    throw new Error(
      "HYPERLIQUID_WALLET_ADDRESS must be an Ethereum address (0x-prefixed, 42 chars)"
    );
  }

  const derived = new ethers.Wallet(privateKey).address;
  if (derived.toLowerCase() !== walletAddress.toLowerCase()) {
    throw new Error(
      `HYPERLIQUID_PRIVATE_KEY derives address ${derived}, but HYPERLIQUID_WALLET_ADDRESS is ${walletAddress}. These must match.`
    );
  }

  const testnet = (process.env.HYPERLIQUID_TESTNET ?? "true").toLowerCase() === "true";
  const allowLiveTrading =
    (process.env.HYPERLIQUID_ALLOW_LIVE_TRADING ?? "false").toLowerCase() === "true";

  return { privateKey, walletAddress, testnet, allowLiveTrading };
}
