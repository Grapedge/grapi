/** Shared web extension configuration. */
export interface WebConfig {
  /** Tavily API key, if present. */
  apiKey: string | undefined;
}

/** Read the web extension configuration from the environment. */
export function loadWebConfig(): WebConfig {
  const raw = process.env.TAVILY_API_KEY?.trim();
  return { apiKey: raw && raw.length > 0 ? raw : undefined };
}
