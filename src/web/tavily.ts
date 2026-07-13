import {
  DEFAULT_SEARCH_LIMIT,
  type WebExtractInput,
  type WebExtractProvider,
  type WebExtractResponse,
  type WebSearchInput,
  type WebSearchProvider,
  type WebSearchResponse,
} from "./types.js";

/** Tavily /search wire result (snake_case, as sent over HTTP). */
interface TavilySearchWireResult {
  title: string;
  url: string;
  content: string;
  published_date?: string;
}

/** Tavily /search wire response. */
interface TavilySearchWireResponse {
  query: string;
  results: TavilySearchWireResult[];
  answer?: string;
  response_time?: string | number;
}

/** Tavily /extract wire result. */
interface TavilyExtractWireResult {
  url: string;
  raw_content: string;
  images?: string[];
  favicon?: string;
}

/** Tavily /extract wire failed result (partial-success semantics). */
interface TavilyExtractWireFailedResult {
  url: string;
  error: string;
}

/** Tavily /extract wire response. */
interface TavilyExtractWireResponse {
  results: TavilyExtractWireResult[];
  failed_results?: TavilyExtractWireFailedResult[];
  response_time?: string | number;
}

/**
 * Tavily API client — a minimal fetch-based wrapper around POST /search and
 * POST /extract, modelled on the shape of the official @tavily/core SDK but
 * with zero runtime dependencies.
 */
export class TavilyProvider implements WebSearchProvider, WebExtractProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, baseUrl = "https://api.tavily.com") {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  async search(input: WebSearchInput): Promise<WebSearchResponse> {
    const data = await this.post<TavilySearchWireResponse>(
      "/search",
      {
        query: input.query,
        max_results: input.limit ?? DEFAULT_SEARCH_LIMIT,
      },
      input.signal,
    );
    return {
      query: data.query,
      results: data.results.map((r) => ({
        title: r.title,
        url: r.url,
        content: r.content,
        publishedAt: r.published_date,
      })),
      answer: data.answer,
      responseTime: normalizeResponseTime(data.response_time),
    };
  }

  async extract(input: WebExtractInput): Promise<WebExtractResponse> {
    const data = await this.post<TavilyExtractWireResponse>(
      "/extract",
      {
        urls: [input.url],
        format: "markdown",
      },
      input.signal,
    );
    return {
      results: data.results.map((r) => ({
        url: r.url,
        content: r.raw_content,
        images: r.images,
        favicon: r.favicon,
      })),
      failed: data.failed_results?.map((f) => ({ url: f.url, error: f.error })) ?? [],
      responseTime: normalizeResponseTime(data.response_time),
    };
  }

  private async post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      let message = `Tavily POST ${path} failed: ${response.status} ${response.statusText}`;
      try {
        const errorBody = (await response.json()) as { detail?: { error?: string } };
        if (errorBody?.detail?.error) {
          message = `Tavily ${response.status}: ${errorBody.detail.error}`;
        }
      } catch {
        // response body wasn't JSON; keep the default status-based message
      }
      throw new Error(message);
    }
    return (await response.json()) as T;
  }
}

/** Normalize Tavily's unstable response_time (number | string) to a number. */
function normalizeResponseTime(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isNaN(n) ? undefined : n;
}
