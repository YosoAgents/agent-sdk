import { Contract, JsonRpcProvider } from "ethers";
import { CONTRACTS, HYPEREVM_RPC_URL } from "./contracts.js";
import * as output from "./output.js";

// Covers one small round-trip job (USDC approve + createJob + memo + claim) with headroom.
const HYPE_THRESHOLD_WEI = 10_000_000_000_000_000n; // 0.01 HYPE (18 decimals)
const USDC_THRESHOLD_RAW = 250_000n; // 0.25 USDC (6 decimals)

const POLL_INTERVAL_MS = 15_000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

const USDC_BALANCE_ABI = ["function balanceOf(address account) external view returns (uint256)"];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readBalances(
  provider: JsonRpcProvider,
  usdc: Contract,
  walletAddress: string
): Promise<{ hypeWei: bigint; usdcRaw: bigint }> {
  const [hypeWei, usdcRaw] = await Promise.all([
    provider.getBalance(walletAddress),
    usdc.balanceOf(walletAddress) as Promise<bigint>,
  ]);
  return { hypeWei, usdcRaw };
}

function formatHype(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const frac = wei % 10n ** 18n;
  const fracStr = frac.toString().padStart(18, "0").slice(0, 4);
  return `${whole}.${fracStr}`;
}

function formatUsdc(raw: bigint): string {
  const whole = raw / 10n ** 6n;
  const frac = raw % 10n ** 6n;
  const fracStr = frac.toString().padStart(6, "0").slice(0, 2);
  return `${whole}.${fracStr}`;
}

// Prints a funding prompt and polls for HYPE + USDC. Returns on both thresholds
// or timeout (does not throw on timeout). Caller must gate on TTY / JSON-mode.
export async function promptFundAndPoll(walletAddress: string): Promise<void> {
  output.log("");
  output.log("  Fund your agent to go live:");
  output.log(`    Address:  ${walletAddress}`);
  output.log("    Send:     0.02 HYPE (gas) + $1 USDC (working capital) on HyperEVM (chain 999)");
  output.log(`    USDC:     ${CONTRACTS.USDC}`);
  output.log("");
  output.log(
    `  Polling every ${POLL_INTERVAL_MS / 1000}s (timeout ${POLL_TIMEOUT_MS / 60_000} min). Ctrl-C to skip.`
  );
  output.log("");

  const provider = new JsonRpcProvider(HYPEREVM_RPC_URL);
  const usdc = new Contract(CONTRACTS.USDC, USDC_BALANCE_ABI, provider);

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let lastHypeWei: bigint | null = null;
  let lastUsdcRaw: bigint | null = null;

  while (Date.now() < deadline) {
    try {
      const { hypeWei, usdcRaw } = await readBalances(provider, usdc, walletAddress);

      if (
        lastHypeWei === null ||
        lastUsdcRaw === null ||
        hypeWei !== lastHypeWei ||
        usdcRaw !== lastUsdcRaw
      ) {
        lastHypeWei = hypeWei;
        lastUsdcRaw = usdcRaw;
        output.log(`    current:  ${formatHype(hypeWei)} HYPE, $${formatUsdc(usdcRaw)} USDC`);
      }

      if (hypeWei >= HYPE_THRESHOLD_WEI && usdcRaw >= USDC_THRESHOLD_RAW) {
        output.log("");
        output.success("Funded. Ready to run `yoso-agent sell create` / `serve start`.\n");
        return;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      output.warn(`    balance check failed: ${msg} (retrying)`);
    }

    await sleep(POLL_INTERVAL_MS);
  }

  output.log("");
  output.warn(`Timed out after ${POLL_TIMEOUT_MS / 60_000} min waiting for funds.`);
  output.log("  Re-run `yoso-agent setup` after funding, or continue manually with");
  output.log("  `yoso-agent sell init / sell create / serve start` once the wallet is funded.\n");
}
