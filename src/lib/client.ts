import axios from "axios";
import https from "https";
import * as path from "path";
import dotenv from "dotenv";
import { loadApiKey } from "./config.js";
import { ROOT } from "./paths.js";
import { formatApiErrorMessage, safeApiErrorBody, safeApiErrorCode } from "./api-errors.js";

// Load .env from ROOT (honors YOSO_AGENT_ROOT). Idempotent with bin/yoso-agent.ts's
// earlier load — dotenv does not overwrite existing process.env values by default.
dotenv.config({ path: path.resolve(ROOT, ".env") });

loadApiKey();

/**
 * Normalize YOSO_API_URL to end with exactly one `/api` segment. Idempotent
 * against `host`, `host/`, `host/api`, and `host/api/`.
 */
export function apiBaseUrl(): string {
  const envValue = process.env.YOSO_API_URL?.trim();
  const raw = (envValue && envValue.length > 0 ? envValue : "https://api.yoso.sh").replace(
    /\/+$/,
    ""
  );
  return raw.endsWith("/api") ? raw : `${raw}/api`;
}

const client = axios.create({
  baseURL: apiBaseUrl(),
  headers: {
    "User-Agent": "yoso-agent/0.3.0",
  },
  // Disable proxy auto-detection, which can break hosted requests on some platforms.
  proxy: false,
  httpsAgent: new https.Agent({ family: 4 }),
});

// Read API key per-request so key changes (setup, regenerate) take effect
// immediately. A caller-supplied `x-api-key` (e.g. `regenerateApiKey` during
// `agent switch`) takes precedence over the env default — otherwise the
// currently-active agent's key would clobber the per-agent header and the
// request would authenticate as the wrong agent.
client.interceptors.request.use((config) => {
  if (config.headers?.["x-api-key"]) {
    return config;
  }
  const key = process.env.YOSO_AGENT_API_KEY;
  if (key) {
    config.headers["x-api-key"] = key;
  }
  return config;
});

client.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response) {
      const status = error.response.status;
      const code = safeApiErrorCode(error.response.data);
      const body = safeApiErrorBody(error.response.data);
      // Compose a short relative URL — baseURL is already present in the user's
      // config so echoing it back adds noise.
      const cfg = error.config ?? {};
      const url = typeof cfg.url === "string" ? cfg.url : undefined;
      throw new Error(formatApiErrorMessage(status, code, body, url));
    }
    throw error;
  }
);

export default client;
