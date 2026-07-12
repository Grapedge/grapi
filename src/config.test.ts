import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { TavilyProvider } from "./web/tavily.js";

describe("loadConfig", () => {
  it("creates a Tavily provider when TAVILY_API_KEY is present", () => {
    const config = loadConfig({ TAVILY_API_KEY: "test-key" });
    expect(config.webSearchProvider).toBeInstanceOf(TavilyProvider);
  });

  it("skips provider creation when TAVILY_API_KEY is missing", () => {
    const config = loadConfig({});
    expect(config.webSearchProvider).toBeUndefined();
  });

  it("skips provider creation when TAVILY_API_KEY is empty", () => {
    const config = loadConfig({ TAVILY_API_KEY: "" });
    expect(config.webSearchProvider).toBeUndefined();
  });
});
