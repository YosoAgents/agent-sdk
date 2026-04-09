import axios from "axios";
import https from "https";
import dotenv from "dotenv";
import { loadApiKey } from "./config.js";

dotenv.config();

loadApiKey();

const client = axios.create({
  baseURL: process.env.YOSO_API_URL || "https://yoso.bet",
  headers: {
    "User-Agent": "yoso-agent-sdk/0.1.0",
  },
  // Disable proxy auto-detection (fixes Railway 503 on some platforms)
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
      const message = error.response.data?.message || error.response.data?.error || error.message;
      throw new Error(`API error ${status}: ${message}`);
    }
    throw error;
  }
);

export default client;
