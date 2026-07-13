import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TavilyProvider } from "./tavily.js";

/**
 * Control what the (mocked) network returns. We only steer fetch's return
 * value — we never assert how fetch was called (method/url/body), since that
 * is an implementation detail. The real HTTP contract is covered by the
 * live smoke tests at the bottom of this file.
 */
function givenTavilyResponds(
  body: unknown,
  init: { ok?: boolean; status?: number; statusText?: string } = {},
): void {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: init.statusText ?? "OK",
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response);
}

describe("TavilyProvider #unit", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("search", () => {
    it("maps a Tavily search response to WebSearchResponse", async () => {
      // Arrange
      givenTavilyResponds({
        query: "Leo Messi",
        results: [
          {
            title: "Lionel Messi - Wikipedia",
            url: "https://en.wikipedia.org/wiki/Lionel_Messi",
            content: "Lionel Andrés Messi is an Argentine footballer.",
          },
        ],
        answer: "An Argentine footballer.",
        response_time: 1.67,
        request_id: "abc",
      });
      const provider = new TavilyProvider("test-key");

      // Act
      const result = await provider.search({ query: "Leo Messi" });

      // Assert
      expect(result.query).toBe("Leo Messi");
      expect(result.results).toEqual([
        {
          title: "Lionel Messi - Wikipedia",
          url: "https://en.wikipedia.org/wiki/Lionel_Messi",
          content: "Lionel Andrés Messi is an Argentine footballer.",
          publishedAt: undefined,
        },
      ]);
      expect(result.answer).toBe("An Argentine footballer.");
      expect(result.responseTime).toBe(1.67);
    });

    it("normalizes a string response_time to a number", async () => {
      givenTavilyResponds({ query: "hi", results: [], response_time: "2.5" });
      const provider = new TavilyProvider("test-key");

      const result = await provider.search({ query: "hi" });

      expect(result.responseTime).toBe(2.5);
    });
  });

  describe("extract", () => {
    it("maps results and failed_results (partial success is data, not an error)", async () => {
      givenTavilyResponds({
        results: [
          {
            url: "https://example.com",
            raw_content: "# Hello",
            title: "Hello World",
            images: ["https://example.com/i.png"],
            favicon: "https://example.com/f.ico",
          },
        ],
        failed_results: [{ url: "https://bad.example", error: "Could not fetch" }],
        response_time: 1.23,
      });
      const provider = new TavilyProvider("test-key");

      const result = await provider.extract({ url: "https://example.com" });

      expect(result.results).toEqual([
        {
          url: "https://example.com",
          content: "# Hello",
          title: "Hello World",
          images: ["https://example.com/i.png"],
          favicon: "https://example.com/f.ico",
        },
      ]);
      expect(result.failed).toEqual([{ url: "https://bad.example", error: "Could not fetch" }]);
      expect(result.responseTime).toBe(1.23);
    });
  });

  describe("error handling", () => {
    it("surfaces the provider's detail.error on a non-2xx response", async () => {
      givenTavilyResponds(
        { detail: { error: "Invalid API key" } },
        { ok: false, status: 401, statusText: "Unauthorized" },
      );
      const provider = new TavilyProvider("bad-key");

      await expect(provider.search({ query: "hi" })).rejects.toThrow("Invalid API key");
    });

    it("falls back to status when there is no detail.error", async () => {
      givenTavilyResponds(
        { unexpected: true },
        { ok: false, status: 500, statusText: "Internal Server Error" },
      );
      const provider = new TavilyProvider("key");

      await expect(provider.search({ query: "hi" })).rejects.toThrow(/500/);
    });
  });
});

describe.skipIf(!process.env.TAVILY_API_KEY)("live Tavily API #smoke", () => {
  it("searches the real Tavily /search endpoint end-to-end", async () => {
    const provider = new TavilyProvider(process.env.TAVILY_API_KEY!);
    const result = await provider.search({ query: "hello world", limit: 1 });
    expect(result.results.length).toBeGreaterThan(0);
    expect(typeof result.results[0]?.url).toBe("string");
  });

  it("extracts a real page via the Tavily /extract endpoint", async () => {
    const provider = new TavilyProvider(process.env.TAVILY_API_KEY!);
    const result = await provider.extract({ url: "https://example.com" });
    expect(result.results.length).toBeGreaterThan(0);
    expect(typeof result.results[0]?.content).toBe("string");
  });
});
