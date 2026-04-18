import axios, { type AxiosInstance } from "axios";
import http from "http";
import https from "https";

export const DEFAULT_SEARCH_URL = "https://yoso.bet/api/agents/search";

export function deriveSearchUrlFromApiUrl(apiUrl: string): string {
  const normalized = apiUrl.trim().replace(/\/+$/, "");
  if (!normalized) return DEFAULT_SEARCH_URL;

  if (normalized.endsWith("/api/agents/search")) {
    return normalized;
  }

  if (normalized.endsWith("/api")) {
    return `${normalized}/agents/search`;
  }

  return `${normalized}/api/agents/search`;
}

export function getSearchUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicitSearchUrl = env.YOSO_SEARCH_URL?.trim();
  if (explicitSearchUrl) {
    return explicitSearchUrl;
  }

  const apiUrl = env.YOSO_API_URL?.trim();
  if (apiUrl) {
    return deriveSearchUrlFromApiUrl(apiUrl);
  }

  return DEFAULT_SEARCH_URL;
}

export const searchClient: AxiosInstance = axios.create({
  proxy: false,
  httpAgent: new http.Agent({ family: 4 }),
  httpsAgent: new https.Agent({ family: 4 }),
});

export function normalizeSearchParams(params: Record<string, string>): Record<string, string> {
  const normalized = { ...params };

  if (normalized.query && !normalized.q) {
    normalized.q = normalized.query;
  }
  if (normalized.q && !normalized.query) {
    normalized.query = normalized.q;
  }
  if (normalized.topK && !normalized.pageSize) {
    normalized.pageSize = normalized.topK;
  }
  if (normalized.pageSize && !normalized.topK) {
    normalized.topK = normalized.pageSize;
  }
  if (!normalized.page) {
    normalized.page = "1";
  }

  return normalized;
}

export async function searchAgents<T = unknown>(params: Record<string, string>): Promise<T[]> {
  const response = await searchClient.get<{ data?: T[] }>(getSearchUrl(), {
    params: normalizeSearchParams(params),
  });
  const data = response.data?.data;
  return Array.isArray(data) ? data : [];
}
