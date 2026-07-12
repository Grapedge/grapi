import { describe, expect, it, vi } from "vitest";
import { registerWebSearchTool } from "./search.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WebSearchProvider, WebSearchResponse } from "./types.js";

function createFakeProvider(response: WebSearchResponse): WebSearchProvider {
  return {
    search: vi.fn().mockResolvedValue(response),
  };
}

function createMockPi(): ExtensionAPI & { registeredTool: ReturnType<typeof vi.fn> } {
  const registeredTool = vi.fn();
  return {
    registerTool: registeredTool,
    registeredTool,
  } as unknown as ExtensionAPI & { registeredTool: ReturnType<typeof vi.fn> };
}

describe("registerWebSearchTool", () => {
  it("does not register the tool when no provider is given", () => {
    const pi = createMockPi();
    registerWebSearchTool(pi, undefined);
    expect(pi.registeredTool).not.toHaveBeenCalled();
  });

  it("registers the web_search tool when a provider is given", () => {
    const pi = createMockPi();
    const provider = createFakeProvider({ query: "hello", results: [] });
    registerWebSearchTool(pi, provider);
    expect(pi.registeredTool).toHaveBeenCalledTimes(1);
    const [registeredTool] = pi.registeredTool.mock.calls[0] ?? [];
    expect(registeredTool?.name).toBe("web_search");
  });

  it("returns markdown and structured details for search results", async () => {
    const pi = createMockPi();
    const provider = createFakeProvider({
      query: "hello",
      results: [
        {
          title: "Example",
          url: "https://example.com",
          content: "An example page.",
          score: 0.9,
          publishedAt: "2024-06-01",
        },
      ],
      answer: "Answer text",
      usage: { credits: 1 },
      responseTime: 1.23,
    });
    registerWebSearchTool(pi, provider);

    const [registeredTool] = pi.registeredTool.mock.calls[0] ?? [];
    expect(registeredTool).toBeDefined();
    const result = await registeredTool.execute(
      "call-1",
      { query: "hello", limit: 1 },
      undefined,
      undefined,
      {} as ExtensionContext,
    );

    expect(provider.search).toHaveBeenCalledWith({ query: "hello", limit: 1 });

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain("1. [Example](https://example.com) (2024-06-01)");
    expect(result.content[0].text).toContain("An example page.");

    expect(result.details).toEqual({
      query: "hello",
      results: [
        {
          title: "Example",
          url: "https://example.com",
          content: "An example page.",
          score: 0.9,
          publishedAt: "2024-06-01",
        },
      ],
      answer: "Answer text",
      usage: { credits: 1 },
      responseTime: 1.23,
    });
  });

  it("renders a fallback message when no results are returned", async () => {
    const pi = createMockPi();
    const provider = createFakeProvider({ query: "hello", results: [] });
    registerWebSearchTool(pi, provider);

    const [registeredTool] = pi.registeredTool.mock.calls[0] ?? [];
    expect(registeredTool).toBeDefined();
    const result = await registeredTool.execute(
      "call-1",
      { query: "hello" },
      undefined,
      undefined,
      {} as ExtensionContext,
    );

    expect(result.content[0].text).toBe("No results found.");
    expect(result.details).toEqual({ query: "hello", results: [] });
  });
});
