import axios from "axios";
import https from "https";
import * as path from "path";
import dotenv from "dotenv";
import { loadApiKey } from "./config.js";
import { ROOT } from "./paths.js";
import { formatApiErrorMessage, safeApiErrorCode } from "./api-errors.js";

// Load .env from ROOT (honors YOSO_AGENT_ROOT). Idempotent with bin/yoso-agent.ts's
// earlier load — dotenv does not overwrite existing process.env values by default.
dotenv.config({ path: path.resolve(ROOT, ".env") });

loadApiKey();

const client = axios.create({
  baseURL: process.env.YOSO_API_URL || "https://yoso.bet",
  headers: {
    "User-Agent": "yoso-agent/0.2.0",
  },
  // Disable proxy auto-detection, which can break hosted requests on some platforms.
  proxy: false,
  httpsAgent: new https.Agent({ family: 4 }),
});

// Read API key per-request so key changes (setup, regenerate) take effect immediately
client.interceptors.request.use((config) => {
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
      throw new Error(formatApiErrorMessage(status, code));
    }
    throw error;
  }
);

export default client;
