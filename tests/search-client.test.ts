import { describe, expect, it } from "vitest";
import {
  DEFAULT_SEARCH_URL,
  deriveSearchUrlFromApiUrl,
  getSearchUrl,
  normalizeSearchParams,
  searchClient,
} from "../src/lib/search-client.js";

describe("search client URL resolution", () => {
  it("uses explicit YOSO_SEARCH_URL first", () => {
    expect(
      getSearchUrl({
        YOSO_SEARCH_URL: "https://search.example.test/custom",
        YOSO_API_URL: "https://api.example.test/api",
      })
    ).toBe("https://search.example.test/custom");
  });

  it("derives staging search URL from YOSO_API_URL with /api", () => {
    expect(deriveSearchUrlFromApiUrl("https://yosobet-app-staging.up.railway.app/api")).toBe(
      "https://yosobet-app-staging.up.railway.app/api/agents/search"
    );
  });

  it("derives production search URL from YOSO_API_URL with /api", () => {
    expect(deriveSearchUrlFromApiUrl("https://api.yoso.sh/api")).toBe(
      "https://api.yoso.sh/api/agents/search"
    );
  });

  it("adds /api when YOSO_API_URL omits it", () => {
    expect(deriveSearchUrlFromApiUrl("https://api.yoso.sh/")).toBe(
      "https://api.yoso.sh/api/agents/search"
    );
  });

  it("defaults to the existing production search URL", () => {
    expect(getSearchUrl({})).toBe(DEFAULT_SEARCH_URL);
  });

  it("disables axios proxy auto-detection", () => {
    expect(searchClient.defaults.proxy).toBe(false);
    expect(searchClient.defaults.httpAgent).toBeDefined();
    expect(searchClient.defaults.httpsAgent).toBeDefined();
  });

  it("sends both legacy and staging search parameter names", () => {
    expect(normalizeSearchParams({ query: "echo_test", topK: "3", yoso: "true" })).toEqual({
      query: "echo_test",
      q: "echo_test",
      topK: "3",
      pageSize: "3",
      page: "1",
      yoso: "true",
    });
  });

  it("preserves explicit staging parameter names", () => {
    expect(normalizeSearchParams({ q: "echo_test", pageSize: "2", page: "4" })).toEqual({
      query: "echo_test",
      q: "echo_test",
      topK: "2",
      pageSize: "2",
      page: "4",
    });
  });
});
