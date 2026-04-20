import client from "./client.js";
import { CONTRACTS } from "./contracts.js";
import type { JsonObject } from "./types.js";

export interface AgentInfo {
  name: string;
  description: string;
  tokenAddress: string;
  token: {
    name: string;
    symbol: string;
  };
  walletAddress: string;
  jobs: {
    name: string;
    priceV2: {
      type: string;
      value: number;
    };
    slaMinutes: number;
    requiredFunds: boolean;
    deliverable: string;
    requirement: JsonObject;
  }[];
}

export async function getMyAgentInfo(): Promise<AgentInfo> {
  const agent = await client.get("/agents/me");
  const data = agent.data.data;
  if (!data.jobs && data.offerings) {
    data.jobs = data.offerings;
  }
  return data;
}

interface WalletBalance {
  symbol: string;
  tokenAddress: string | null;
  tokenBalance: string;
  decimals: number;
  tokenMetadata: { symbol: string | null; decimals: number | null };
}

export interface LowBalanceWarning {
  symbol: string;
  amount: number;
  minimum: number;
}

// First-hire failure class: agent with <0.01 HYPE can't pay gas, <0.25 USDC can't sign escrow.
const MIN_HYPE = 0.01;
const MIN_USDC = 0.25;

function hexToFloat(hexBalance: string, decimals: number): number {
  const raw = BigInt(hexBalance);
  if (raw === 0n) return 0;
  const divisor = 10n ** BigInt(decimals);
  const whole = Number(raw / divisor);
  const frac = Number(raw % divisor) / Number(divisor);
  return whole + frac;
}

// Match the exact escrow USDC contract on HyperEVM, not just any token whose
// symbol uppercases to USDC. The /agents/wallet-balances endpoint can include
// other USDC variants (bridged, test deployments) that the escrow flow won't
// accept, and a symbol-only lookup would silently suppress the warning.
const ESCROW_USDC_ADDRESS = CONTRACTS.USDC.toLowerCase();

export async function checkLowBalances(): Promise<LowBalanceWarning[]> {
  const res = await client.get<{ data: WalletBalance[] }>("/agents/wallet-balances");
  const tokens = res.data?.data ?? [];
  const warnings: LowBalanceWarning[] = [];

  const hype = tokens.find((t) => t.tokenAddress === null);
  const hypeAmount = hype
    ? hexToFloat(hype.tokenBalance, hype.tokenMetadata?.decimals ?? hype.decimals ?? 18)
    : 0;
  if (hypeAmount < MIN_HYPE) {
    warnings.push({ symbol: "HYPE", amount: hypeAmount, minimum: MIN_HYPE });
  }

  const usdc = tokens.find(
    (t) => t.tokenAddress != null && t.tokenAddress.toLowerCase() === ESCROW_USDC_ADDRESS
  );
  const usdcAmount = usdc
    ? hexToFloat(usdc.tokenBalance, usdc.tokenMetadata?.decimals ?? usdc.decimals ?? 6)
    : 0;
  if (usdcAmount < MIN_USDC) {
    warnings.push({ symbol: "USDC", amount: usdcAmount, minimum: MIN_USDC });
  }

  return warnings;
}
