import axios from "axios";
import * as dns from "dns";
import * as https from "https";
import * as net from "net";
import * as output from "../lib/output.js";
import type { JsonObject } from "../lib/types.js";

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.goog",
  "169.254.169.254",
]);

function isPrivateIP(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized.startsWith("::ffff:")) {
    return isPrivateIP(normalized.slice("::ffff:".length));
  }
  if (net.isIP(normalized) === 6) {
    return (
      normalized === "::1" ||
      normalized === "::" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe80:")
    );
  }
  return (
    normalized.startsWith("10.") ||
    normalized.startsWith("172.16.") ||
    normalized.startsWith("172.17.") ||
    normalized.startsWith("172.18.") ||
    normalized.startsWith("172.19.") ||
    normalized.startsWith("172.20.") ||
    normalized.startsWith("172.21.") ||
    normalized.startsWith("172.22.") ||
    normalized.startsWith("172.23.") ||
    normalized.startsWith("172.24.") ||
    normalized.startsWith("172.25.") ||
    normalized.startsWith("172.26.") ||
    normalized.startsWith("172.27.") ||
    normalized.startsWith("172.28.") ||
    normalized.startsWith("172.29.") ||
    normalized.startsWith("172.30.") ||
    normalized.startsWith("172.31.") ||
    normalized.startsWith("192.168.") ||
    normalized.startsWith("169.254.") ||
    normalized.startsWith("127.") ||
    normalized === "0.0.0.0"
  );
}

function lookupAll(hostname: string): Promise<dns.LookupAddress[]> {
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, { all: true }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses);
    });
  });
}

async function resolvePublicAddress(hostname: string): Promise<dns.LookupAddress> {
  const addresses = await lookupAll(hostname);
  if (addresses.length === 0) {
    throw new Error("No DNS records returned");
  }
  const publicAddress = addresses.find((record) => !isPrivateIP(record.address));
  if (!publicAddress) {
    throw new Error("URL resolves only to private or link-local addresses");
  }
  return publicAddress;
}

export async function query(url: string, params?: JsonObject): Promise<void> {
  if (!url) {
    output.fatal("Usage: yoso-agent resource query <url> [--params '<json>']");
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    output.fatal(`Invalid URL: ${url}`);
  }

  if (parsed!.protocol !== "https:") {
    output.fatal(`Only HTTPS URLs are allowed (got ${parsed!.protocol})`);
  }

  if (BLOCKED_HOSTNAMES.has(parsed!.hostname)) {
    output.fatal(`Blocked hostname: ${parsed!.hostname}`);
  }

  let resolvedAddress: dns.LookupAddress;
  try {
    resolvedAddress = await resolvePublicAddress(parsed!.hostname);
  } catch (dnsErr) {
    output.fatal(
      `DNS resolution failed for ${parsed!.hostname}: ${dnsErr instanceof Error ? dnsErr.message : String(dnsErr)}`
    );
  }

  try {
    output.log(`\nQuerying resource at: ${url}`);
    if (params && Object.keys(params).length > 0) {
      output.log(`  With params: ${JSON.stringify(params, null, 2)}\n`);
    } else {
      output.log("");
    }

    let response;
    try {
      const axiosConfig = {
        timeout: 10_000,
        maxContentLength: 5 * 1024 * 1024,
        maxRedirects: 0,
        httpsAgent: new https.Agent({
          lookup: (hostname, _options, callback) => {
            if (hostname === parsed!.hostname) {
              callback(null, resolvedAddress.address, resolvedAddress.family);
              return;
            }
            callback(new Error("Unexpected hostname during resource query lookup"), "", 0);
          },
        }),
      };
      if (params && Object.keys(params).length > 0) {
        const queryString = new URLSearchParams();
        for (const [key, value] of Object.entries(params)) {
          if (value !== null && value !== undefined) {
            queryString.append(key, String(value));
          }
        }
        const urlWithParams = url.includes("?")
          ? `${url}&${queryString.toString()}`
          : `${url}?${queryString.toString()}`;
        response = await axios.get(urlWithParams, axiosConfig);
      } else {
        response = await axios.get(url, axiosConfig);
      }
    } catch (httpError: unknown) {
      if (axios.isAxiosError(httpError) && httpError.response) {
        output.fatal(
          `Resource query failed: ${httpError.response.status} ${httpError.response.statusText}`
        );
      } else {
        output.fatal(
          `Resource query failed: ${httpError instanceof Error ? httpError.message : String(httpError)}`
        );
      }
    }

    const responseData = response.data;

    output.output(responseData, (data) => {
      output.heading(`Resource Query Result`);
      output.log(`\n  URL: ${url}`);
      output.log(`\n  Response:`);
      if (typeof data === "string") {
        output.log(`    ${data}`);
      } else {
        output.log(
          `    ${JSON.stringify(data, null, 2)
            .split("\n")
            .map((line, i) => (i === 0 ? line : `    ${line}`))
            .join("\n")}`
        );
      }
      output.log("");
    });
  } catch (e) {
    output.fatal(`Resource query failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
