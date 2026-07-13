import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createWebSearchToolDefinition, registerWebSearchTool } from "./search.js";
import type { WebSearchProvider, WebSearchResponse } from "./types.js";

function createFakeProvider(response: WebSearchResponse): WebSearchProvider {
  return { search: vi.fn().mockResolvedValue(response) };
}

/** Extract the concatenated text content from a tool result (type-safe helper). */
function textContentOf(result: {
  content: ReadonlyArray<{ type: string; text?: string | undefined }>;
}): string {
  return result.content.find((c) => c.type === "text")?.text ?? "";
}

const NOOP_CTX = {} as ExtensionContext;

describe("createWebSearchToolDefinition", () => {
  it("defines the web_search tool", () => {
    const tool = createWebSearchToolDefinition(createFakeProvider({ query: "hi", results: [] }));
    expect(tool.name).toBe("web_search");
    expect(tool.label).toBe("Web Search");
  });

  it("returns results as a markdown numbered list and structured details", async () => {
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
      answer: "An answer.",
      responseTime: 1.23,
    });
    const tool = createWebSearchToolDefinition(provider);

    const result = await tool.execute(
      "call-1",
      { query: "hello", limit: 1 },
      undefined,
      undefined,
      NOOP_CTX,
    );

    expect(provider.search).toHaveBeenCalledWith({ query: "hello", limit: 1 });
    const text = textContentOf(result);
    expect(text).toContain("1. [Example](https://example.com) (2024-06-01)");
    expect(text).toContain("An example page.");
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
      answer: "An answer.",
      usage: undefined,
      responseTime: 1.23,
    });
  });

  it("returns a fallback message when there are no results", async () => {
    const provider = createFakeProvider({ query: "hello", results: [] });
    const tool = createWebSearchToolDefinition(provider);

    const result = await tool.execute("call-1", { query: "hello" }, undefined, undefined, NOOP_CTX);

    expect(textContentOf(result)).toBe("No results found.");
  });
});

describe("registerWebSearchTool", () => {
  it("does not register when no provider is given", () => {
    const registerTool = vi.fn();
    const pi = { registerTool } as unknown as ExtensionAPI;
    registerWebSearchTool(pi, undefined);
    expect(registerTool).not.toHaveBeenCalled();
  });

  it("registers the tool when a provider is given", () => {
    const registerTool = vi.fn();
    const pi = { registerTool } as unknown as ExtensionAPI;
    registerWebSearchTool(pi, createFakeProvider({ query: "x", results: [] }));
    expect(registerTool).toHaveBeenCalledTimes(1);
    expect(registerTool.mock.calls[0]?.[0]?.name).toBe("web_search");
  });
});
