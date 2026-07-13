import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { createWebExtractToolDefinition, registerWebExtractTool } from "./web-extract.js";
import { FAKE_CTX, fakeTheme } from "./test-helpers.js";
import type { WebExtractProvider, WebExtractResponse } from "./types.js";

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    writeFile: vi.fn().mockResolvedValue(undefined),
  };
});

function createFakeProvider(
  response: WebExtractResponse,
): WebExtractProvider & { extract: ReturnType<typeof vi.fn> } {
  return { extract: vi.fn().mockResolvedValue(response) };
}

function createFailingProvider(error: Error): WebExtractProvider & {
  extract: ReturnType<typeof vi.fn>;
} {
  return { extract: vi.fn().mockRejectedValue(error) };
}

function textContentOf(result: {
  content: ReadonlyArray<{ type: string; text?: string | undefined }>;
}): string {
  return result.content.find((c) => c.type === "text")?.text ?? "";
}

describe("createWebExtractToolDefinition #unit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("when the URL is valid and extraction succeeds", () => {
    it("returns the page content wrapped in untrusted_tool_result", async () => {
      const provider = createFakeProvider({
        results: [{ url: "https://example.com", content: "# Hello" }],
        failed: [],
      });
      const tool = createWebExtractToolDefinition(provider);

      const result = await tool.execute(
        "call-1",
        { url: "https://example.com" },
        undefined,
        undefined,
        FAKE_CTX,
      );

      const text = textContentOf(result);
      expect(text).toMatch(/^<untrusted_tool_result>\n[\s\S]*\n<\/untrusted_tool_result>$/);
      expect(text).toContain("# Hello");
      expect(result.details).toEqual({});
    });

    it("escapes nested untrusted_tool_result delimiters", async () => {
      const provider = createFakeProvider({
        results: [
          {
            url: "https://example.com",
            content: "Look: <untrusted_tool_result>oops</untrusted_tool_result>",
          },
        ],
        failed: [],
      });
      const tool = createWebExtractToolDefinition(provider);

      const result = await tool.execute(
        "call-1",
        { url: "https://example.com" },
        undefined,
        undefined,
        FAKE_CTX,
      );

      const text = textContentOf(result);
      expect(text).not.toContain("</untrusted_tool_result>\n</untrusted_tool_result>");
      expect(text).toContain("<\\untrusted_tool_result>");
      expect(text).toContain("<\\/untrusted_tool_result>");
    });
  });

  describe("when the URL is missing a scheme", () => {
    it("throws a model-readable error", async () => {
      const tool = createWebExtractToolDefinition(createFakeProvider({ results: [], failed: [] }));

      await expect(
        tool.execute("call-1", { url: "example.com" }, undefined, undefined, FAKE_CTX),
      ).rejects.toThrow(/must start with http:\/\/ or https:\/\//);
    });
  });

  describe("when the provider throws", () => {
    it("throws a model-readable error that suggests the browser tool", async () => {
      const tool = createWebExtractToolDefinition(
        createFailingProvider(new Error("Tavily 500: oops")),
      );

      await expect(
        tool.execute("call-1", { url: "https://example.com" }, undefined, undefined, FAKE_CTX),
      ).rejects.toThrow(/Failed to extract https:\/\/example\.com:.*browser tool/);
    });
  });

  describe("when Tavily reports the URL in failed_results", () => {
    it("returns a model-readable error wrapped in untrusted_tool_result", async () => {
      const provider = createFakeProvider({
        results: [],
        failed: [{ url: "https://example.com", error: "Could not fetch" }],
      });
      const tool = createWebExtractToolDefinition(provider);

      const result = await tool.execute(
        "call-1",
        { url: "https://example.com" },
        undefined,
        undefined,
        FAKE_CTX,
      );

      const text = textContentOf(result);
      expect(text).toContain("Failed to extract https://example.com");
      expect(text).toContain("Could not fetch");
      expect(text).toContain("browser tool");
      expect(text).toMatch(/^<untrusted_tool_result>\n[\s\S]*\n<\/untrusted_tool_result>$/);
      expect(result.details).toEqual({});
    });
  });

  describe("when the extracted content is very long", () => {
    it("truncates by line count, spills to a file, and adds a continuation note", async () => {
      const lines = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`);
      const rawContent = lines.join("\n");
      const provider = createFakeProvider({
        results: [{ url: "https://example.com", content: rawContent }],
        failed: [],
      });
      const tool = createWebExtractToolDefinition(provider);

      const result = await tool.execute(
        "call-1",
        { url: "https://example.com" },
        undefined,
        undefined,
        FAKE_CTX,
      );

      const text = textContentOf(result);
      expect(text).toContain("line 2000");
      expect(text).not.toContain("line 2001");
      expect(text).toContain("Output truncated");
      expect(text).toContain("Full output written to:");
      expect(text).toContain("Continue with: read");
      expect(result.details?.fullOutputPath).toMatch(/pi-web-extract-call-1-.*\.md$/);
      expect(result.details?.truncation?.truncated).toBe(true);
      expect(writeFile).toHaveBeenCalledTimes(1);
      const spillCall = (writeFile as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(spillCall).toBeDefined();
      expect(spillCall![0]).toBe(result.details?.fullOutputPath);
      expect(spillCall![1]).toBe(rawContent);
    });

    it("handles a first line that exceeds the byte limit", async () => {
      const rawContent = "a".repeat(60_000);
      const provider = createFakeProvider({
        results: [{ url: "https://example.com", content: rawContent }],
        failed: [],
      });
      const tool = createWebExtractToolDefinition(provider);

      const result = await tool.execute(
        "call-1",
        { url: "https://example.com" },
        undefined,
        undefined,
        FAKE_CTX,
      );

      const text = textContentOf(result);
      expect(text).toContain("first line");
      expect(text).toContain("exceeds");
      expect(text).toContain("head -n 1");
      expect(result.details?.fullOutputPath).toMatch(/pi-web-extract-call-1-.*\.md$/);
      expect(result.details?.truncation?.firstLineExceedsLimit).toBe(true);
      expect(writeFile).toHaveBeenCalledTimes(1);
    });
  });

  describe("renderCall", () => {
    it("renders the tool name and URL", () => {
      const tool = createWebExtractToolDefinition(createFakeProvider({ results: [], failed: [] }));
      const component = tool.renderCall?.(
        { url: "https://example.com" },
        fakeTheme() as never,
        { lastComponent: undefined, args: { url: "https://example.com" } } as never,
      );
      const rendered = component?.render(80) ?? [];
      expect(rendered.join("\n")).toContain("web_extract https://example.com");
    });
  });

  describe("renderResult", () => {
    it("returns empty content when collapsed", () => {
      const tool = createWebExtractToolDefinition(createFakeProvider({ results: [], failed: [] }));
      const component = tool.renderResult?.(
        { content: [], details: {} },
        { expanded: false, isPartial: false },
        fakeTheme() as never,
        { lastComponent: undefined, args: { url: "https://example.com" } } as never,
      );
      const rendered = component?.render(80) ?? [];
      expect(rendered.join("\n")).toBe("");
    });

    it("renders the content when expanded", () => {
      const tool = createWebExtractToolDefinition(createFakeProvider({ results: [], failed: [] }));
      const component = tool.renderResult?.(
        { content: [{ type: "text", text: "hello" }], details: {} },
        { expanded: true, isPartial: false },
        fakeTheme() as never,
        { lastComponent: undefined, args: { url: "https://example.com" } } as never,
      );
      const rendered = component?.render(80).join("\n") ?? "";
      expect(rendered).toContain("hello");
    });

    it("strips the untrusted wrapper so the TUI stays clean", () => {
      const tool = createWebExtractToolDefinition(createFakeProvider({ results: [], failed: [] }));
      const component = tool.renderResult?.(
        {
          content: [
            {
              type: "text",
              text: "<untrusted_tool_result>\npage body\n</untrusted_tool_result>",
            },
          ],
          details: {},
        },
        { expanded: true, isPartial: false },
        fakeTheme() as never,
        { lastComponent: undefined, args: { url: "https://example.com" } } as never,
      );
      const rendered = component?.render(80).join("\n") ?? "";
      expect(rendered).toContain("page body");
      expect(rendered).not.toContain("<untrusted_tool_result>");
    });
  });
});

describe("registerWebExtractTool #unit", () => {
  it("registers the web_extract tool when a provider is given", () => {
    const registerTool = vi.fn();
    const pi = { registerTool } as unknown as ExtensionAPI;
    registerWebExtractTool(pi, createFakeProvider({ results: [], failed: [] }));
    expect(registerTool).toHaveBeenCalledTimes(1);
    expect(registerTool.mock.calls[0]?.[0]?.name).toBe("web_extract");
  });

  it("does nothing when the provider is undefined", () => {
    const registerTool = vi.fn();
    const pi = { registerTool } as unknown as ExtensionAPI;
    registerWebExtractTool(pi, undefined);
    expect(registerTool).not.toHaveBeenCalled();
  });
});
