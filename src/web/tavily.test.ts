import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TavilyProvider } from "./tavily.js";

describe("TavilyProvider", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("search", () => {
    it("calls the Tavily search endpoint and maps the response", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          query: "Leo Messi",
          results: [
            {
              title: "Lionel Messi - Wikipedia",
              url: "https://en.wikipedia.org/wiki/Lionel_Messi",
              content: "Lionel Andrés Messi is an Argentine footballer.",
              score: 0.95,
              published_date: "2024-01-15",
            },
          ],
          answer: "Lionel Messi is an Argentine footballer.",
          response_time: "1.67",
          usage: { credits: 1 },
        }),
      } as Response);
      globalThis.fetch = fetchMock;

      const provider = new TavilyProvider("test-key");
      const result = await provider.search({ query: "Leo Messi", limit: 3 });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.tavily.com/search",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer test-key",
            "Content-Type": "application/json",
          }),
          body: JSON.stringify({ query: "Leo Messi", max_results: 3 }),
        }),
      );

      expect(result.query).toBe("Leo Messi");
      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toEqual({
        title: "Lionel Messi - Wikipedia",
        url: "https://en.wikipedia.org/wiki/Lionel_Messi",
        content: "Lionel Andrés Messi is an Argentine footballer.",
        score: 0.95,
        publishedAt: "2024-01-15",
      });
      expect(result.answer).toBe("Lionel Messi is an Argentine footballer.");
      expect(result.responseTime).toBe(1.67);
      expect(result.usage).toEqual({ credits: 1 });
    });

    it("uses the default limit when none is provided", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          query: "hello",
          results: [],
        }),
      } as Response);
      globalThis.fetch = fetchMock;

      const provider = new TavilyProvider("test-key");
      await provider.search({ query: "hello" });

      expect(fetchMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: JSON.stringify({ query: "hello", max_results: 5 }),
        }),
      );
    });

    it("throws when the response is not ok", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        json: async () => ({ error: "bad key" }),
      } as Response);
      globalThis.fetch = fetchMock;

      const provider = new TavilyProvider("test-key");
      await expect(provider.search({ query: "hello" })).rejects.toThrow(
        "Tavily search failed: 401 Unauthorized",
      );
    });
  });

  describe("extract", () => {
    it("calls the Tavily extract endpoint and maps the response", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          results: [
            {
              url: "https://example.com",
              raw_content: "# Hello\n\nThis is the page.",
              images: ["https://example.com/image.png"],
              favicon: "https://example.com/favicon.ico",
            },
          ],
          failed_results: [{ url: "https://bad.example", error: "Could not fetch page" }],
          response_time: 2.34,
          usage: { total_credits_used: 1 },
        }),
      } as Response);
      globalThis.fetch = fetchMock;

      const provider = new TavilyProvider("test-key");
      const result = await provider.extract({ url: "https://example.com" });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.tavily.com/extract",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer test-key",
            "Content-Type": "application/json",
          }),
          body: JSON.stringify({ urls: ["https://example.com"], format: "markdown" }),
        }),
      );

      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toEqual({
        url: "https://example.com",
        content: "# Hello\n\nThis is the page.",
        images: ["https://example.com/image.png"],
        favicon: "https://example.com/favicon.ico",
      });
      expect(result.failed).toEqual([
        { url: "https://bad.example", error: "Could not fetch page" },
      ]);
      expect(result.responseTime).toBe(2.34);
      expect(result.usage).toEqual({ total_credits_used: 1 });
    });

    it("throws when the response is not ok", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        json: async () => ({ error: "boom" }),
      } as Response);
      globalThis.fetch = fetchMock;

      const provider = new TavilyProvider("test-key");
      await expect(provider.extract({ url: "https://example.com" })).rejects.toThrow(
        "Tavily extract failed: 500 Internal Server Error",
      );
    });
  });
});
