import { ethers } from "ethers";
import {
  HYPEREVM_RPC_URL,
  HYPEREVM_CHAIN_ID,
  CONTRACTS,
  YOSO_ROUTER_ABI,
  MEMO_MANAGER_ABI,
  ERC20_ABI,
} from "./contracts.js";

export type Result<T> = { success: true; data: T } | { success: false; error: string };

export class ContractClient {
  private wallet: ethers.Wallet;
  private provider: ethers.JsonRpcProvider;
  private router: ethers.Contract;
  private memoManager: ethers.Contract;
  private usdc: ethers.Contract;
  private chainVerified = false;

  constructor(privateKey: string, rpcUrl?: string) {
    this.provider = new ethers.JsonRpcProvider(rpcUrl || HYPEREVM_RPC_URL);
    this.wallet = new ethers.Wallet(privateKey, this.provider);
    this.router = new ethers.Contract(CONTRACTS.YOSO_ROUTER, YOSO_ROUTER_ABI, this.wallet);
    this.memoManager = new ethers.Contract(CONTRACTS.MEMO_MANAGER, MEMO_MANAGER_ABI, this.wallet);
    this.usdc = new ethers.Contract(CONTRACTS.USDC, ERC20_ABI, this.wallet);
  }

  private async verifyChain(): Promise<void> {
    if (this.chainVerified) return;
    const network = await this.provider.getNetwork();
    if (Number(network.chainId) !== HYPEREVM_CHAIN_ID) {
      throw new Error(
        `RPC returned chain ID ${network.chainId}, expected ${HYPEREVM_CHAIN_ID} (HyperEVM). Check HYPEREVM_RPC_URL.`
      );
    }
    this.chainVerified = true;
  }

  get address(): string {
    return this.wallet.address;
  }

  async getUSDCBalance(): Promise<bigint> {
    return await this.usdc.balanceOf(this.wallet.address);
  }

  /** Max single approval: 10,000 USDC (6 decimals). Override via maxApproval param. */
  static readonly DEFAULT_MAX_APPROVAL = 10_000n * 10n ** 6n;

  async approveUSDC(
    amount: bigint,
    maxApproval: bigint = ContractClient.DEFAULT_MAX_APPROVAL
  ): Promise<Result<string>> {
    try {
      await this.verifyChain();
      if (amount > maxApproval) {
        return {
          success: false,
          error: `Approval amount (${amount}) exceeds max (${maxApproval}). Pass a higher maxApproval to override.`,
        };
      }

      const currentAllowance: bigint = await this.usdc.allowance(
        this.wallet.address,
        CONTRACTS.YOSO_ROUTER
      );

      if (currentAllowance >= amount) {
        return { success: true, data: "allowance_sufficient" };
      }

      // Approve exact amount, not unlimited
      const tx = await this.usdc.approve(CONTRACTS.YOSO_ROUTER, amount);
      const receipt = await tx.wait();

      if (!receipt || receipt.status !== 1) {
        return { success: false, error: "USDC approve transaction reverted" };
      }

      return { success: true, data: receipt.hash };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `USDC approve failed: ${msg}` };
    }
  }

  async createJob(params: {
    provider: string;
    evaluator?: string;
    expiredAt: number; // Unix timestamp in seconds
    budget: bigint;
    metadata: string;
  }): Promise<Result<{ txHash: string; onChainJobId: string }>> {
    try {
      await this.verifyChain();
      const evaluator = params.evaluator || ethers.ZeroAddress;

      const tx = await this.router.createJob(
        params.provider,
        evaluator,
        params.expiredAt,
        CONTRACTS.USDC,
        params.budget,
        params.metadata
      );

      const receipt = await tx.wait();

      if (!receipt || receipt.status !== 1) {
        return { success: false, error: "createJob transaction reverted" };
      }

      // Parse JobCreated event from receipt logs
      const iface = new ethers.Interface(YOSO_ROUTER_ABI);
      for (const log of receipt.logs) {
        try {
          const parsed = iface.parseLog({ topics: log.topics, data: log.data });
          if (parsed && parsed.name === "JobCreated") {
            const jobId = parsed.args.jobId;
            return {
              success: true,
              data: {
                txHash: receipt.hash,
                onChainJobId: jobId.toString(),
              },
            };
          }
        } catch {
          // Not a matching event, skip
        }
      }

      return { success: false, error: "No JobCreated event found in transaction logs" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `createJob failed: ${msg}` };
    }
  }

  async createMemo(params: {
    jobId: string; // on-chain job ID
    content: string;
    memoType: number; // 0 = MESSAGE
    isSecured: boolean;
    nextPhase: number; // 2 = TRANSACTION
  }): Promise<Result<{ txHash: string; memoId: string }>> {
    try {
      await this.verifyChain();
      const tx = await this.router.createMemo(
        params.jobId,
        params.content,
        params.memoType,
        params.isSecured,
        params.nextPhase
      );

      const receipt = await tx.wait();

      if (!receipt || receipt.status !== 1) {
        return { success: false, error: "createMemo transaction reverted" };
      }

      // Parse NewMemo event from MemoManager logs
      const iface = new ethers.Interface(MEMO_MANAGER_ABI);
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== CONTRACTS.MEMO_MANAGER.toLowerCase()) continue;
        try {
          const parsed = iface.parseLog({ topics: log.topics, data: log.data });
          if (parsed && parsed.name === "NewMemo") {
            return {
              success: true,
              data: { txHash: receipt.hash, memoId: parsed.args.memoId.toString() },
            };
          }
        } catch {
          // Not a matching event, skip
        }
      }

      return { success: false, error: "No NewMemo event found in transaction logs" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `createMemo failed: ${msg}` };
    }
  }

  async signMemo(
    memoId: string,
    isApproved: boolean,
    reason: string = ""
  ): Promise<Result<{ txHash: string }>> {
    try {
      await this.verifyChain();
      const tx = await this.router.signMemo(memoId, isApproved, reason);
      const receipt = await tx.wait();

      if (!receipt || receipt.status !== 1) {
        return { success: false, error: "signMemo transaction reverted" };
      }

      return { success: true, data: { txHash: receipt.hash } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `signMemo failed: ${msg}` };
    }
  }
}
