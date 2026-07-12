import { TavilyProvider } from "./web/tavily.js";
import type { WebSearchProvider } from "./web/types.js";

export interface GrapiConfig {
  /** Provider used by the web_search tool. */
  webSearchProvider?: WebSearchProvider;
}

/**
 * Load grapi configuration from environment variables.
 *
 * - TAVILY_API_KEY: enables the Tavily-backed web_search tool.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): GrapiConfig {
  const config: GrapiConfig = {};

  if (env.TAVILY_API_KEY) {
    config.webSearchProvider = new TavilyProvider(env.TAVILY_API_KEY);
  }

  return config;
}
