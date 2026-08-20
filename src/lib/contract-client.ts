import { ethers } from "ethers";
import {
  HYPEREVM_RPC_URL,
  HYPEREVM_CHAIN_ID,
  CONTRACTS,
  YOSO_ROUTER_ABI,
  MEMO_MANAGER_ABI,
  ERC20_ABI,
} from "./contracts.js";
import {
  isInvalidBlockHeight,
  retryOnInvalidBlockHeight,
  SILENT_LOGGER,
  type RetryLogger,
} from "./retry.js";

export type Result<T> = { success: true; data: T } | { success: false; error: string };

export class ContractClient {
  private wallet: ethers.Wallet;
  private nonceManager: ethers.NonceManager;
  private provider: ethers.JsonRpcProvider;
  private router: ethers.Contract;
  private usdc: ethers.Contract;
  private writeUsdc: ethers.Contract;
  private memoManager: ethers.Contract;
  private chainVerified = false;
  private logger: RetryLogger;
  private submissionTail: Promise<void> = Promise.resolve();
  private canResetNonce = false;

  constructor(privateKey: string, rpcUrl?: string, logger: RetryLogger = SILENT_LOGGER) {
    const provider = new ethers.JsonRpcProvider(rpcUrl || HYPEREVM_RPC_URL);
    // Ethers populates and signs inside Wallet.sendTransaction before it calls
    // provider.broadcastTransaction. Only the latter is an ambiguous submission boundary.
    this.provider = new Proxy(provider, {
      get: (target, property) => {
        if (property === "broadcastTransaction") {
          return async (signedTx: string) => {
            this.canResetNonce = false;
            return target.broadcastTransaction(signedTx);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as ethers.JsonRpcProvider;
    this.wallet = new ethers.Wallet(privateKey, this.provider);
    this.nonceManager = new ethers.NonceManager(this.wallet);
    this.router = new ethers.Contract(CONTRACTS.YOSO_ROUTER, YOSO_ROUTER_ABI, this.nonceManager);
    this.usdc = new ethers.Contract(CONTRACTS.USDC, ERC20_ABI, this.wallet);
    this.writeUsdc = new ethers.Contract(CONTRACTS.USDC, ERC20_ABI, this.nonceManager);
    this.memoManager = new ethers.Contract(CONTRACTS.MEMO_MANAGER, MEMO_MANAGER_ABI, this.provider);
    this.logger = logger;
  }

  private async verifyChain(): Promise<void> {
    if (this.chainVerified) return;
    const network = await retryOnInvalidBlockHeight(() => this.provider.getNetwork(), this.logger);
    if (Number(network.chainId) !== HYPEREVM_CHAIN_ID) {
      throw new Error(
        `RPC returned chain ID ${network.chainId}, expected ${HYPEREVM_CHAIN_ID} (HyperEVM). Check HYPEREVM_RPC_URL.`
      );
    }
    this.chainVerified = true;
  }

  // Keep recovery decisions and any retry exclusive with transaction submission.
  private async submitWrite<T>(
    submit: () => Promise<T>,
    recoverStaleNonce?: () => Promise<boolean>
  ): Promise<T> {
    const previous = this.submissionTail;
    let release!: () => void;
    this.submissionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;

    const retryBeforeBroadcast = (error: unknown) => {
      if (!this.canResetNonce) throw error;
      this.nonceManager.reset();
    };
    const resetAfterTerminalPreBroadcastError = () => {
      if (this.canResetNonce) this.nonceManager.reset();
    };

    try {
      this.canResetNonce = true;
      try {
        return await retryOnInvalidBlockHeight(submit, this.logger, retryBeforeBroadcast);
      } catch (error) {
        resetAfterTerminalPreBroadcastError();
        if (!recoverStaleNonce) {
          if (!this.canResetNonce && this.isStaleNonceError(error)) this.nonceManager.reset();
          throw error;
        }
        if (!this.isStaleNonceError(error)) throw error;
        if (!(await recoverStaleNonce())) {
          this.nonceManager.reset();
          throw error;
        }

        this.nonceManager.reset();
        this.canResetNonce = true;
        try {
          return await retryOnInvalidBlockHeight(submit, this.logger, retryBeforeBroadcast);
        } catch (recoveryError) {
          resetAfterTerminalPreBroadcastError();
          if (this.isStaleNonceError(recoveryError)) this.nonceManager.reset();
          throw recoveryError;
        }
      }
    } finally {
      this.canResetNonce = false;
      release();
    }
  }

  private isStaleNonceError(err: unknown): boolean {
    return ethers.isError(err, "NONCE_EXPIRED");
  }

  private async isMemoUnsigned(memoId: string): Promise<boolean> {
    try {
      const expectedMemoId = BigInt(memoId);
      if (expectedMemoId <= 0n) return false;

      const memo = (await retryOnInvalidBlockHeight(
        () => this.memoManager.getMemo(memoId),
        this.logger
      )) as { id?: unknown; isApproved?: unknown; approvedBy?: unknown };
      return (
        typeof memo.id === "bigint" &&
        memo.id === expectedMemoId &&
        memo.isApproved === false &&
        typeof memo.approvedBy === "string" &&
        memo.approvedBy.toLowerCase() === ethers.ZeroAddress
      );
    } catch {
      return false;
    }
  }

  get address(): string {
    return this.wallet.address;
  }

  async getUSDCBalance(): Promise<bigint> {
    return await retryOnInvalidBlockHeight<bigint>(
      () => this.usdc.balanceOf(this.wallet.address),
      this.logger
    );
  }

  // Max single approval: 10,000 USDC (6 decimals). Override via maxApproval param.
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

      const currentAllowance = await retryOnInvalidBlockHeight<bigint>(
        () => this.usdc.allowance(this.wallet.address, CONTRACTS.YOSO_ROUTER),
        this.logger
      );

      if (currentAllowance >= amount) {
        return { success: true, data: "allowance_sufficient" };
      }

      // Retry send alone; once a tx exists, retry wait alone. Prevents duplicate submissions
      // if wait fails — tx.wait() on the same response is idempotent.
      const tx = await this.submitWrite(() =>
        this.writeUsdc.approve(CONTRACTS.YOSO_ROUTER, amount)
      );
      const receipt = await retryOnInvalidBlockHeight<ethers.ContractTransactionReceipt | null>(
        () => tx.wait(),
        this.logger
      );

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

      const tx = await this.submitWrite(() =>
        this.router.createJob(
          params.provider,
          evaluator,
          params.expiredAt,
          CONTRACTS.USDC,
          params.budget,
          params.metadata
        )
      );

      const receipt = await retryOnInvalidBlockHeight<ethers.ContractTransactionReceipt | null>(
        () => tx.wait(),
        this.logger
      );

      if (!receipt || receipt.status !== 1) {
        return { success: false, error: "createJob transaction reverted" };
      }

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

      const tx = await this.submitWrite(() =>
        this.router.createMemo(
          params.jobId,
          params.content,
          params.memoType,
          params.isSecured,
          params.nextPhase
        )
      );

      const receipt = await retryOnInvalidBlockHeight<ethers.ContractTransactionReceipt | null>(
        () => tx.wait(),
        this.logger
      );

      if (!receipt || receipt.status !== 1) {
        return { success: false, error: "createMemo transaction reverted" };
      }

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

      const tx = await this.submitWrite(
        () => this.router.signMemo(memoId, isApproved, reason),
        () => this.isMemoUnsigned(memoId)
      );
      const receipt = await retryOnInvalidBlockHeight<ethers.ContractTransactionReceipt | null>(
        () => tx.wait(),
        this.logger
      );

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
