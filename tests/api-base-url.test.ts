import { afterEach, beforeEach, describe, expect, it } from "vitest";

// We re-import apiBaseUrl after each env mutation because module-level side
// effects (dotenv load, API key load) are cached per-import. Using dynamic
// import after mutating process.env gives us a clean evaluation each time.

describe("apiBaseUrl normalizer (SDK #9)", () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.YOSO_API_URL;
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.YOSO_API_URL;
    } else {
      process.env.YOSO_API_URL = savedEnv;
    }
  });

  async function freshApiBaseUrl(): Promise<string> {
    // vitest caches modules per-test-file; we call the named export directly.
    // Since apiBaseUrl reads process.env at call-time (not at import-time), a
    // single static import of the function is sufficient across cases.
    const { apiBaseUrl } = await import("../src/lib/client.ts");
    return apiBaseUrl();
  }

  it("defaults to https://api.yoso.sh/api when YOSO_API_URL is unset", async () => {
    // Use empty string rather than delete — a .env file in the SDK repo root
    // will be reloaded by client.ts's module-scope dotenv.config() call and
    // repopulate the variable. Empty string is treated as "unset" by
    // apiBaseUrl().
    process.env.YOSO_API_URL = "";
    expect(await freshApiBaseUrl()).toBe("https://api.yoso.sh/api");
  });

  it("appends /api when YOSO_API_URL is a host with no suffix", async () => {
    process.env.YOSO_API_URL = "https://example.com";
    expect(await freshApiBaseUrl()).toBe("https://example.com/api");
  });

  it("is idempotent when YOSO_API_URL already ends with /api", async () => {
    process.env.YOSO_API_URL = "https://example.com/api";
    expect(await freshApiBaseUrl()).toBe("https://example.com/api");
  });

  it("strips trailing slash on a host with no /api", async () => {
    process.env.YOSO_API_URL = "https://example.com/";
    expect(await freshApiBaseUrl()).toBe("https://example.com/api");
  });

  it("strips trailing slash when /api is already present", async () => {
    process.env.YOSO_API_URL = "https://example.com/api/";
    expect(await freshApiBaseUrl()).toBe("https://example.com/api");
  });

  it("strips multiple trailing slashes", async () => {
    process.env.YOSO_API_URL = "https://example.com///";
    expect(await freshApiBaseUrl()).toBe("https://example.com/api");
  });

  it("trims whitespace before normalizing", async () => {
    process.env.YOSO_API_URL = "  https://example.com  ";
    expect(await freshApiBaseUrl()).toBe("https://example.com/api");
  });
});
