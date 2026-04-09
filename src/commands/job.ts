import { ethers } from "ethers";
import client from "../lib/client.js";
import { formatPrice, getActiveAgent } from "../lib/config.js";
import * as output from "../lib/output.js";
import { getBountyByJobId } from "../lib/bounty.js";
import { processNegotiationPhase, getJobDetails, reportEscrow } from "../lib/api.js";
import { ContractClient } from "../lib/contract-client.js";

function renderDeliverable(deliverable: unknown): string {
  if (typeof deliverable === "string") return deliverable;
  return JSON.stringify(deliverable);
}

export async function create(
  agentWalletAddress: string,
  jobOfferingName: string,
  serviceRequirements: Record<string, unknown>,
  preferredSubscriptionTier?: string,
  isAutomated: boolean = false
): Promise<void> {
  if (!agentWalletAddress || !jobOfferingName) {
    output.fatal(
      "Usage: yoso-agent job create <agentWalletAddress> <jobOfferingName> [--requirements '<json>'] [--subscription '<subscriptionTier>'] [--isAutomated <true|false>]"
    );
  }

  const subscriptionRequired = preferredSubscriptionTier != null;

  if (subscriptionRequired) {
    output.log(`\n  Subscription tier: ${preferredSubscriptionTier}`);
  }

  try {
    const job = await client.post<{ data: { jobId: number } }>("/agents/jobs", {
      providerWalletAddress: agentWalletAddress,
      jobOfferingName,
      serviceRequirements,
      ...(preferredSubscriptionTier != null && { preferredSubscriptionTier }),
      isAutomated,
    });

    output.output(job.data, (data) => {
      output.heading("Job Created");
      output.field("Job ID", data.data?.jobId ?? data.jobId);
      if (subscriptionRequired) {
        output.field("Subscription Tier", preferredSubscriptionTier);
      }
      output.log("\n  Job submitted. Use `yoso-agent job status <jobId>` to check progress.\n");
    });
  } catch (e) {
    output.fatal(`Failed to create job: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function pay(jobId: string, accept: boolean, content?: string): Promise<void> {
  if (!jobId) {
    output.fatal("Usage: yoso-agent job pay <jobId> --accept <true|false> [--content '<text>']");
  }

  const numJobId = Number(jobId);

  try {
    // Reject path — API only, no on-chain interaction
    if (!accept) {
      await processNegotiationPhase(numJobId, { accept: false, ...(content ? { content } : {}) });
      output.output({ jobId: numJobId, accept: false }, (data) => {
        output.heading("Payment Rejected");
        output.field("Job ID", data.jobId);
        output.log("");
      });
      return;
    }

    // Accept path — check if on-chain escrow needed
    const job = await getJobDetails(numJobId);
    const budget = BigInt(job.budget || "0");

    if (budget > BigInt(0)) {
      // On-chain escrow flow

      // Gate: must be in NEGOTIATION (phase 1) — provider has accepted
      if (job.phase !== 1) {
        output.fatal(
          `Job is in phase ${job.phase}, expected 1 (NEGOTIATION). Provider must accept before escrow.`
        );
      }

      // Idempotency: already fully escrowed
      if (job.escrowVerifiedAt) {
        output.log("  Escrow already verified. Skipping on-chain steps.");
      } else {
        // Verify key matches active agent
        const activeAgent = getActiveAgent();
        if (!activeAgent) {
          output.fatal("No active agent. Run `yoso-agent setup` first.");
        }

        const pk = process.env.AGENT_PRIVATE_KEY || activeAgent.walletPrivateKey;
        if (!pk) {
          output.fatal(
            "Private key required for paid jobs. Set AGENT_PRIVATE_KEY env var or re-run `yoso-agent setup` to register a new agent with a wallet."
          );
        }

        const derivedAddress = new ethers.Wallet(pk).address;
        if (derivedAddress.toLowerCase() !== activeAgent.walletAddress.toLowerCase()) {
          output.fatal(
            `Private key mismatch: derived ${derivedAddress} but active agent is ${activeAgent.walletAddress}. Check AGENT_PRIVATE_KEY.`
          );
        }

        const contractClient = new ContractClient(pk);

        let onChainJobId = job.onChainJobId;
        let createJobTxHash = "";

        if (!onChainJobId) {
          // Check USDC balance
          const balance = await contractClient.getUSDCBalance();
          if (balance < budget) {
            output.fatal(
              `Insufficient USDC: have ${balance.toString()} (${Number(balance) / 1e6} USDC), need ${budget.toString()} (${Number(budget) / 1e6} USDC). Fund your wallet first.`
            );
          }

          // Approve USDC to YOSORouter
          output.log("  Approving USDC...");
          const approveResult = await contractClient.approveUSDC(budget);
          if (!approveResult.success) {
            output.fatal(`USDC approval failed: ${approveResult.error}`);
          }
          if (approveResult.data !== "allowance_sufficient") {
            output.log(`  Approved: ${approveResult.data}`);
          }

          // Create on-chain job
          output.log("  Creating on-chain job...");
          const createResult = await contractClient.createJob({
            provider: job.providerAddress,
            expiredAt: job.expiry
              ? Math.floor(job.expiry / 1000)
              : Math.floor(Date.now() / 1000) + 3600,
            budget,
            metadata: JSON.stringify({ offChainJobId: numJobId }),
          });
          if (!createResult.success) {
            output.fatal(`On-chain job creation failed: ${createResult.error}`);
          }

          onChainJobId = createResult.data.onChainJobId;
          createJobTxHash = createResult.data.txHash;
          output.log(`  On-chain job: ${onChainJobId} (tx: ${createJobTxHash})`);
        } else {
          output.log(`  Resuming — on-chain job ${onChainJobId} already exists.`);
        }

        // Create on-chain memo proposing TRANSACTION phase
        output.log("  Creating escrow memo on-chain...");
        const memoResult = await contractClient.createMemo({
          jobId: onChainJobId,
          content: "Escrow deposit",
          memoType: 0, // MESSAGE
          isSecured: false,
          nextPhase: 2, // TRANSACTION
        });
        if (!memoResult.success) {
          output.fatal(`On-chain memo creation failed: ${memoResult.error}`);
        }

        output.log(`  Memo: ${memoResult.data.memoId} (tx: ${memoResult.data.txHash})`);

        // Report to backend — backend validates and notifies provider to sign
        output.log("  Reporting to backend...");
        await reportEscrow(numJobId, createJobTxHash, onChainJobId, memoResult.data.memoId);

        output.log("  Waiting for provider to sign escrow on-chain...");
      }
    }

    // For free jobs, advance via off-chain negotiation
    if (budget === BigInt(0)) {
      await processNegotiationPhase(numJobId, { accept: true, ...(content ? { content } : {}) });
    }

    output.output({ jobId: numJobId, accept: true, onChain: budget > BigInt(0) }, (data) => {
      output.heading("Payment Processed");
      output.field("Job ID", data.jobId);
      output.field("Accepted", "true");
      if (data.onChain) output.field("On-Chain Escrow", "Memo created — provider will sign");
      output.log("");
    });
  } catch (e) {
    output.fatal(`Failed to process payment: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function evaluate(jobId: string, approve: boolean, reason?: string): Promise<void> {
  if (!jobId) {
    output.fatal(
      "Usage: yoso-agent job evaluate <jobId> --approve <true|false> [--reason '<text>']"
    );
  }

  const numJobId = Number(jobId);

  try {
    const job = await getJobDetails(numJobId);

    if (job.phase !== 3) {
      output.fatal(`Job is in phase ${job.phase}, expected 3 (EVALUATION).`);
    }

    let onChainMemoId: string | undefined;

    // For paid jobs with escrow, create on-chain completion/rejection memo
    if (job.onChainJobId && job.escrowVerifiedAt) {
      const activeAgent = getActiveAgent();
      if (!activeAgent) output.fatal("No active agent.");

      const pk = process.env.AGENT_PRIVATE_KEY || activeAgent.walletPrivateKey;
      if (!pk) output.fatal("Private key required for on-chain evaluation.");

      const derivedAddress = new ethers.Wallet(pk).address;
      if (derivedAddress.toLowerCase() !== activeAgent.walletAddress.toLowerCase()) {
        output.fatal(
          `Private key mismatch: derived ${derivedAddress} but active agent is ${activeAgent.walletAddress}.`
        );
      }

      const contractClient = new ContractClient(pk);
      const nextPhase = approve ? 4 : 5; // COMPLETED or REJECTED

      output.log(`  Creating ${approve ? "completion" : "rejection"} memo on-chain...`);
      const memoResult = await contractClient.createMemo({
        jobId: job.onChainJobId,
        content: reason || (approve ? "Approved" : "Rejected"),
        memoType: 0,
        isSecured: false,
        nextPhase,
      });
      if (!memoResult.success) {
        output.fatal(`On-chain memo creation failed: ${memoResult.error}`);
      }
      onChainMemoId = memoResult.data.memoId;
      output.log(`  Memo: ${onChainMemoId} (tx: ${memoResult.data.txHash})`);
    }

    // Call backend evaluate endpoint
    output.log("  Submitting evaluation...");
    await client.post(`/agents/jobs/${numJobId}/evaluate`, {
      approve,
      reason,
      ...(onChainMemoId ? { onChainMemoId } : {}),
    });

    output.output({ jobId: numJobId, approve, onChain: !!onChainMemoId }, (data) => {
      output.heading("Evaluation Submitted");
      output.field("Job ID", data.jobId);
      output.field("Verdict", data.approve ? "APPROVED" : "REJECTED");
      if (data.onChain) output.field("On-Chain", "Provider will sign — payment auto-releases");
      output.log("");
    });
  } catch (e) {
    output.fatal(`Failed to evaluate: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function status(jobId: string): Promise<void> {
  if (!jobId) {
    output.fatal("Usage: yoso-agent job status <jobId>");
  }

  try {
    const job = await client.get(`/agents/jobs/${jobId}`);

    if (!job?.data?.data) {
      output.fatal(`Job not found: ${jobId}`);
    }

    const data = job.data.data;

    if (job.data.errors && job.data.errors.length > 0) {
      output.output(job.data.errors, (errors) => {
        output.heading(`Job ${jobId} messages`);
        errors.forEach((error: string, i: number) => output.field(`Error ${i + 1}`, error));
      });
      // return;
    }

    const memoHistory = (data.memos || []).map(
      (memo: { nextPhase: string; content: string; createdAt: string; status: string }) => ({
        nextPhase: memo.nextPhase,
        content: memo.content,
        createdAt: memo.createdAt,
        status: memo.status,
      })
    );

    const result = {
      jobId: data.id,
      phase: data.phase,
      providerName: data.providerName ?? null,
      providerWalletAddress: data.providerAddress ?? null,
      expiry: data.expiry ?? null,
      clientName: data.clientName ?? null,
      clientWalletAddress: data.clientAddress ?? null,
      paymentRequestData: data.paymentRequestData,
      deliverable: data.deliverable,
      memoHistory,
    };
    const linkedBountyId = getBountyByJobId(String(result.jobId))?.bountyId;

    output.output(result, (r) => {
      output.heading(`Job ${r.jobId} details`);
      output.field("Phase", r.phase);
      output.field("Client", r.clientName || "-");
      output.field("Client Wallet", r.clientWalletAddress || "-");
      output.field("Provider", r.providerName || "-");
      output.field("Provider Wallet", r.providerWalletAddress || "-");
      output.field("Expiry", new Date(r.expiry * 1000).toISOString() ?? "-");

      if (r.paymentRequestData) {
        output.log(`\n  Payment Request Data:\n    ${JSON.stringify(r.paymentRequestData)}`);
      }

      if (r.deliverable) {
        output.log(`\n  Deliverable:\n    ${renderDeliverable(r.deliverable)}`);
      }
      if (r.memoHistory.length > 0) {
        output.log("\n  History:");
        for (const m of r.memoHistory) {
          output.log(`    [${m.nextPhase}] ${m.content} (${m.createdAt})`);
        }
      }
      if (linkedBountyId) {
        output.log(`\n  This job is linked to bounty ${linkedBountyId}.`);
        output.log(`  Run \`yoso-agent bounty status ${linkedBountyId}\` to sync bounty status.\n`);
      }
      output.log("");
    });
  } catch (e) {
    output.fatal(`Failed to get job status: ${e instanceof Error ? e.message : String(e)}`);
  }
}

type JobListItem = {
  id: number | string;
  phase?: unknown;
  price?: unknown;
  priceType?: unknown;
  clientAddress?: unknown;
  providerAddress?: unknown;
  name?: unknown;
  deliverable?: unknown;
};

export type JobListOptions = {
  page?: number;
  pageSize?: number;
};

export async function active(options: JobListOptions = {}): Promise<void> {
  try {
    const params: Record<string, number> = {};
    if (options.page != null) params.page = options.page;
    if (options.pageSize != null) params.pageSize = options.pageSize;
    const res = await client.get<{ data: JobListItem[] }>("/agents/jobs/active", {
      params,
    });
    const jobs = res.data.data;

    output.output({ jobs }, ({ jobs: list }) => {
      output.heading("Active Jobs");
      if (list.length === 0) {
        output.log("  No active jobs.\n");
        return;
      }
      for (const j of list) {
        output.field("Job ID", j.id);
        if (j.phase) output.field("Phase", j.phase);
        if (j.name) output.field("Name", j.name);
        if (j.price != null) output.field("Price", formatPrice(j.price, j.priceType));
        if (j.clientAddress) output.field("Client", j.clientAddress);
        if (j.providerAddress) output.field("Provider", j.providerAddress);
        if (j.deliverable) output.field("Deliverable", j.deliverable);
        output.log("");
      }
    });
  } catch (e) {
    output.fatal(`Failed to get active jobs: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function completed(options: JobListOptions = {}): Promise<void> {
  try {
    const params: Record<string, number> = {};
    if (options.page != null) params.page = options.page;
    if (options.pageSize != null) params.pageSize = options.pageSize;
    const res = await client.get<{ data: JobListItem[] }>("/agents/jobs/completed", {
      params,
    });
    const jobs = res.data.data;

    output.output({ jobs }, ({ jobs: list }) => {
      output.heading("Completed Jobs");
      if (list.length === 0) {
        output.log("  No completed jobs.\n");
        return;
      }
      for (const j of list) {
        output.field("Job ID", j.id);
        if (j.name) output.field("Name", j.name);
        if (j.price != null) output.field("Price", formatPrice(j.price, j.priceType));
        if (j.clientAddress) output.field("Client", j.clientAddress);
        if (j.providerAddress) output.field("Provider", j.providerAddress);
        if (j.deliverable) output.field("Deliverable", j.deliverable);
        output.log("");
      }
    });
  } catch (e) {
    output.fatal(`Failed to get completed jobs: ${e instanceof Error ? e.message : String(e)}`);
  }
}
