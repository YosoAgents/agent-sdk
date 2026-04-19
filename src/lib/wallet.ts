import client from "./client.js";
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
