import * as output from "../lib/output.js";
import { searchAgents } from "../lib/search-client.js";

export interface SearchOptions {
  mode?: "hybrid" | "vector" | "keyword";
  contains?: string;
  match?: "all" | "any";
  similarityCutoff?: number;
  sparseCutoff?: number;
  topK?: number;
}

interface AgentMetrics {
  successfulJobCount: number | null;
  successRate: number | null;
  uniqueBuyerCount: number | null;
  minsFromLastOnlineTime: number | null;
  isOnline: boolean;
}

interface AgentJob {
  id: number;
  name: string;
  description: string;
  type: string;
  price?: number;
  priceV2: { type: string; value: number };
  requiredFunds: boolean;
  slaMinutes: number;
  requirement: Record<string, unknown>;
  deliverable: Record<string, unknown>;
}

interface AgentResource {
  name: string;
  description?: string;
  url?: string;
  params?: Record<string, unknown>;
  [key: string]: unknown;
}

interface Agent {
  id: number | string;
  name: string;
  description: string;
  contractAddress: string;
  walletAddress: string;
  twitterHandle: string;
  profilePic: string;
  tokenAddress: string | null;
  cluster: string | null;
  category: string | null;
  symbol: string | null;
  agentId: number | null;
  isYosoAgent: boolean;
  metrics?: Partial<AgentMetrics>;
  jobs?: AgentJob[];
  offerings?: AgentJob[];
  resources?: AgentResource[];
}

export const SEARCH_DEFAULTS = {
  mode: "hybrid" as const,
  similarityCutoff: 0.5,
  sparseCutoff: 0.0,
  match: "all" as const,
  topK: 5,
};

const MODE_MAP: Record<string, string> = {
  hybrid: "hybrid",
  vector: "dense",
  keyword: "sparse",
};

function buildParams(query: string, opts: SearchOptions): Record<string, string> {
  const params: Record<string, string> = { query };
  params.yoso = "true";

  // Search mode
  if (opts.mode) {
    const apiMode = MODE_MAP[opts.mode];
    if (!apiMode) {
      output.fatal(`Invalid search mode "${opts.mode}". Use: hybrid, vector, keyword`);
    }
    params.searchMode = apiMode;
  }

  // String filters
  if (opts.contains) params.fullTextFilter = opts.contains;
  if (opts.match) params.fullTextMatch = opts.match;

  // Cutoffs
  params.similarityCutoff = String(opts.similarityCutoff ?? SEARCH_DEFAULTS.similarityCutoff);
  if (opts.sparseCutoff !== undefined) params.sparseCutoff = String(opts.sparseCutoff);

  // Result count
  params.topK = String(opts.topK ?? SEARCH_DEFAULTS.topK);

  return params;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function getOfferings(agent: Agent): AgentJob[] {
  return agent.jobs ?? agent.offerings ?? [];
}

function formatTable(agents: Agent[]): void {
  const header = {
    rank: "#",
    name: "Name",
    id: "ID",
    category: "Category",
    rate: "Success",
    jobs: "Jobs",
    buyers: "Buyers",
    online: "Online",
  };

  // Column widths
  const w = {
    rank: 4,
    name: 20,
    id: 6,
    category: 16,
    rate: 9,
    jobs: 6,
    buyers: 8,
    online: 6,
  };

  const row = (r: typeof header) =>
    `  ${r.rank.toString().padStart(w.rank)}  ` +
    `${truncate(r.name, w.name).padEnd(w.name)}  ` +
    `${r.id.toString().padEnd(w.id)}  ` +
    `${truncate(r.category, w.category).padEnd(w.category)}  ` +
    `${r.rate.toString().padStart(w.rate)}  ` +
    `${r.jobs.toString().padStart(w.jobs)}  ` +
    `${r.buyers.toString().padStart(w.buyers)}  ` +
    `${r.online.toString().padEnd(w.online)}`;

  // Header
  output.log(output.colors.dim(row(header)));

  // Rows
  for (let i = 0; i < agents.length; i++) {
    const a = agents[i];
    const metrics = a.metrics ?? {};
    const offerings = getOfferings(a);
    output.log(
      row({
        rank: String(i + 1),
        name: a.name ?? "-",
        id: String(a.id),
        category: a.category ?? "-",
        rate: metrics.successRate != null ? `${metrics.successRate.toFixed(1)}%` : "-",
        jobs:
          metrics.successfulJobCount != null
            ? String(metrics.successfulJobCount)
            : String(offerings.length),
        buyers: metrics.uniqueBuyerCount != null ? String(metrics.uniqueBuyerCount) : "-",
        online: metrics.isOnline == null ? "-" : metrics.isOnline ? "Yes" : "No",
      })
    );
  }
}

function formatPrice(price?: number, priceType?: string): string {
  if (price == null) return "-";
  if (priceType === "percentage") return `${(price * 100).toFixed(1)}%`;
  return `$${price} USDC`;
}

function formatDetails(agents: Agent[]): void {
  for (const a of agents) {
    output.log(`\n  ${output.colors.bold(a.name ?? "-")}`);
    output.log(`  Wallet: ${a.walletAddress ?? "-"}`);
    if (a.description) {
      output.log(`  ${output.colors.dim(a.description)}`);
    }

    const jobs = getOfferings(a);
    if (jobs.length > 0) {
      output.log("    Offerings:");
      for (const j of jobs) {
        const fee = formatPrice(j.priceV2?.value ?? j.price, j.priceV2?.type);
        const funds = j.requiredFunds ? " [requires funds]" : "";
        output.log(`      - ${j.name} (${fee}${funds})`);
        if (j.description) {
          output.log(`        ${j.description}`);
        }
        if (j.requirement && Object.keys(j.requirement).length > 0) {
          const req = JSON.stringify(j.requirement, null, 2).split("\n").join("\n          ");
          output.log(`        Requirement: ${req}`);
        }
      }
    }

    const resources = a.resources ?? [];
    if (resources.length > 0) {
      output.log("    Resources:");
      for (const r of resources) {
        output.log(`      - ${r.name}`);
        if (r.description) {
          output.log(`        ${r.description}`);
        }
        if (r.url) {
          output.log(`        URL: ${r.url}`);
        }
      }
    }
  }
}

function formatSummary(opts: SearchOptions): string {
  const parts: string[] = [];

  // Mode
  parts.push(`mode=${opts.mode ?? SEARCH_DEFAULTS.mode}`);

  // Active filters
  const filters: string[] = [];
  if (opts.contains) {
    const m = opts.match ?? SEARCH_DEFAULTS.match;
    filters.push(`contains="${opts.contains}" (match=${m})`);
  }
  parts.push(filters.join(", "));

  return parts.join(" · ");
}

export async function search(query: string, opts: SearchOptions): Promise<void> {
  if (!query.trim()) {
    output.fatal(
      "Usage: yoso-agent browse <query>\n  Run `yoso-agent browse --help` for all options."
    );
  }

  // Validate: --match requires --contains
  if (opts.match && !opts.contains) {
    output.fatal("--match requires --contains");
  }

  const params = buildParams(query, opts);

  try {
    const data = await searchAgents<Agent>(params);

    // Handle the known SQL-error quirk for empty results
    if (data.length === 0) {
      output.output([], () => {
        output.log(`\n  No agents found for "${query}".`);
        output.log(`  Try tweaking search parameters (\`yoso-agent browse --help\`).`);
        output.log("");
      });
      return;
    }

    output.output(data, (agents: Agent[]) => {
      output.heading(`Search results for "${query}"`);
      output.log(output.colors.dim(`  ${formatSummary(opts)}`));
      output.log("");
      formatTable(agents);
      formatDetails(agents);
      output.log(output.colors.dim(`\n  ${agents.length} result${agents.length === 1 ? "" : "s"}`));
      output.log("");
    });
  } catch (e: unknown) {
    // Handle the SQL-error quirk (empty WHERE IN ())
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("syntax") || msg.includes("SQL")) {
      output.output([], () => {
        output.log(`\n  No agents found for "${query}".`);
        output.log(`  Try tweaking search parameters (\`yoso-agent browse --help\`).`);
        output.log("");
      });
      return;
    }
    output.fatal(`Search failed: ${msg}`);
  }
}
