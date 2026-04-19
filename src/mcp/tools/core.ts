import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import client from "../../lib/client.js";
import { processNegotiationPhase } from "../../lib/api.js";
import { searchAgents } from "../../lib/search-client.js";
import { parseRequirementsJson } from "../validation.js";

interface CreateJobResponse {
  data?: {
    jobId?: number;
  };
  jobId?: number;
}

interface MarketplaceAgent {
  name?: string;
  walletAddress?: string;
  jobs?: unknown[];
  offerings?: unknown[];
}

function ok(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  };
}

function err(error: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ success: false, error }) }],
  };
}

export function registerCoreTools(server: McpServer): void {
  server.tool(
    "browse_agents",
    "Search the YOSO marketplace for agents and offerings",
    {
      query: z.string().min(1).max(500).describe("Search query"),
      limit: z.number().positive().max(50).optional().describe("Max results (max 50)"),
    },
    async ({ query, limit }) => {
      try {
        const params: Record<string, string> = {
          query,
          yoso: "true",
          topK: String(limit ?? 5),
        };
        const agents = await searchAgents<unknown>(params);
        if (agents.length === 0) {
          return ok({ success: true, agents: [], message: `No agents found for "${query}"` });
        }
        return ok({ success: true, agents });
      } catch (e) {
        return err(`Search failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  );

  server.tool(
    "hire_agent",
    "Create a job to hire an agent for a specific offering",
    {
      agent_wallet: z
        .string()
        .regex(/^0x[a-fA-F0-9]{40}$/, "Must be a valid Ethereum address")
        .describe("Agent wallet address"),
      offering_name: z.string().min(1).max(100).describe("Name of the offering"),
      requirements: z.string().max(10_000).optional().describe("Job requirements (JSON string)"),
      auto_pay: z
        .boolean()
        .optional()
        .default(false)
        .describe("Skip manual payment review. Defaults to false."),
    },
    async ({ agent_wallet, offering_name, requirements, auto_pay }) => {
      try {
        const parsedRequirements = parseRequirementsJson(requirements);
        if (!parsedRequirements.ok) return err(parsedRequirements.error);

        const response = await client.post<CreateJobResponse>("/agents/jobs", {
          providerWalletAddress: agent_wallet,
          jobOfferingName: offering_name,
          serviceRequirements: parsedRequirements.value,
          isAutomated: auto_pay,
          clientOperationId: randomUUID(),
        });
        const jobId = response.data.data?.jobId ?? response.data.jobId;
        if (typeof jobId !== "number") {
          return err("Create job response did not include jobId");
        }
        return ok({ success: true, jobId });
      } catch (e) {
        return err(`Failed to create job: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  );

  server.tool(
    "job_status",
    "Check the status of a job",
    { job_id: z.string().regex(/^\d+$/, "Must be a numeric job ID").describe("Job ID") },
    async ({ job_id }) => {
      try {
        const response = await client.get(`/agents/jobs/${job_id}`);
        const data = response.data?.data;
        if (!data) {
          return err(`Job not found: ${job_id}`);
        }
        return ok({
          success: true,
          job: {
            jobId: data.id,
            phase: data.phase,
            providerName: data.providerName ?? null,
            providerWalletAddress: data.providerAddress ?? null,
            clientName: data.clientName ?? null,
            clientWalletAddress: data.clientAddress ?? null,
            expiry: data.expiry ?? null,
            paymentRequestData: data.paymentRequestData ?? null,
            deliverable: data.deliverable ?? null,
            memos: (data.memos || []).map(
              (m: { nextPhase: string; content: string; createdAt: string; status: string }) => ({
                nextPhase: m.nextPhase,
                content: m.content,
                createdAt: m.createdAt,
                status: m.status,
              })
            ),
          },
        });
      } catch (e) {
        return err(`Failed to get job status: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  );

  server.tool(
    "job_approve_payment",
    "Accept or reject a payment request for a job",
    {
      job_id: z.string().regex(/^\d+$/, "Must be a numeric job ID").describe("Job ID"),
      approve: z.boolean().describe("Whether to approve the payment"),
    },
    async ({ job_id, approve }) => {
      try {
        await processNegotiationPhase(Number(job_id), { accept: approve });
        return ok({ success: true, jobId: Number(job_id), approved: approve });
      } catch (e) {
        return err(`Failed to process payment: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  );

  server.tool(
    "register_agent",
    "Disabled in MCP — run `yoso-agent setup` in a terminal. MCP is not a safe channel for wallet private keys.",
    {
      name: z.string().min(1).max(100).optional().describe("Agent name (ignored)"),
      description: z.string().max(500).optional().describe("Agent description (ignored)"),
    },
    async () => {
      return err(
        "register_agent is disabled in MCP. Run `yoso-agent setup` in a terminal — " +
          "the CLI writes the wallet key to .env (0o600) or an encrypted keystore. " +
          "MCP tool responses are persisted by hosts and are not a safe channel for private keys."
      );
    }
  );

  server.tool(
    "list_offerings",
    "List available offerings from an agent",
    {
      agent_wallet: z
        .string()
        .regex(/^0x[a-fA-F0-9]{40}$/, "Must be a valid Ethereum address")
        .optional()
        .describe("Agent wallet (omit for own offerings)"),
    },
    async ({ agent_wallet }) => {
      try {
        if (!agent_wallet) {
          // Own offerings via authenticated /agents/me
          const response = await client.get("/agents/me");
          const data = response.data?.data;
          if (!data) {
            return err("Could not fetch agent info. Is an agent active?");
          }
          return ok({
            success: true,
            agent: data.name,
            offerings: data.jobs ?? [],
          });
        }
        // Other agent - search by wallet address
        const agents = await searchAgents<MarketplaceAgent>({
          query: agent_wallet,
          yoso: "true",
          topK: "10",
        });
        if (agents.length === 0) {
          return ok({ success: true, agent: agent_wallet, offerings: [] });
        }
        const match = agents.find(
          (a) => a.walletAddress?.toLowerCase() === agent_wallet.toLowerCase()
        );
        if (!match) {
          return ok({
            success: true,
            agent: agent_wallet,
            offerings: [],
            message: "Agent not found",
          });
        }
        return ok({
          success: true,
          agent: match.name,
          offerings: match.jobs ?? match.offerings ?? [],
        });
      } catch (e) {
        return err(`Failed to list offerings: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  );
}
