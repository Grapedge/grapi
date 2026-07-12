import type {
  WebExtractInput,
  WebExtractProvider,
  WebExtractResponse,
  WebExtractResult,
  WebSearchInput,
  WebSearchProvider,
  WebSearchResponse,
  WebSearchResult,
} from "./types.js";
import { DEFAULT_SEARCH_LIMIT } from "./types.js";

interface TavilySearchResult {
  title: string;
  url: string;
  content: string;
  score?: number;
  published_date?: string;
  favicon?: string;
  raw_content?: string;
  images?: unknown[];
}

interface TavilySearchResponse {
  query: string;
  results: TavilySearchResult[];
  answer?: string;
  images?: unknown[];
  response_time?: string | number;
  usage?: unknown;
  request_id?: string;
  auto_parameters?: unknown;
}

interface TavilyExtractResult {
  url: string;
  raw_content: string;
  images?: string[];
  favicon?: string;
}

interface TavilyExtractFailedResult {
  url: string;
  error: string;
}

interface TavilyExtractResponse {
  results: TavilyExtractResult[];
  failed_results?: TavilyExtractFailedResult[];
  response_time?: number;
  usage?: unknown;
}

export class TavilyProvider implements WebSearchProvider, WebExtractProvider {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = "https://api.tavily.com",
  ) {}

  async search(input: WebSearchInput): Promise<WebSearchResponse> {
    const data = await this.request<TavilySearchResponse>("/search", {
      query: input.query,
      max_results: input.limit ?? DEFAULT_SEARCH_LIMIT,
    });

    return {
      query: data.query,
      results: data.results.map((r) => this.toWebSearchResult(r)),
      answer: data.answer,
      usage: data.usage,
      responseTime: this.parseResponseTime(data.response_time),
      raw: data,
    };
  }

  async extract(input: WebExtractInput): Promise<WebExtractResponse> {
    const data = await this.request<TavilyExtractResponse>("/extract", {
      urls: [input.url],
      format: "markdown",
    });

    return {
      results: data.results.map((r) => this.toWebExtractResult(r)),
      failed: data.failed_results?.map((f) => ({ url: f.url, error: f.error })) ?? [],
      usage: data.usage,
      responseTime: data.response_time,
      raw: data,
    };
  }

  private async request<T>(endpoint: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const action = endpoint === "/search" ? "search" : "extract";
      throw new Error(`Tavily ${action} failed: ${response.status} ${response.statusText}`);
    }

    return (await response.json()) as T;
  }

  private toWebSearchResult(result: TavilySearchResult): WebSearchResult {
    return {
      title: result.title,
      url: result.url,
      content: result.content,
      score: result.score,
      publishedAt: result.published_date,
    };
  }

  private toWebExtractResult(result: TavilyExtractResult): WebExtractResult {
    return {
      url: result.url,
      content: result.raw_content,
      images: result.images,
      favicon: result.favicon,
    };
  }

  private parseResponseTime(value: string | number | undefined): number | undefined {
    if (value === undefined) return undefined;
    if (typeof value === "number") return value;
    const parsed = Number.parseFloat(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
}
