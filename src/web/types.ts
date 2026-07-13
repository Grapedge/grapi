/**
 * Web capability contracts.
 *
 * These interfaces decouple the tool layer from any specific HTTP backend
 * (Tavily today, searxng/exa/firecrawl tomorrow).
 */

/** Default result limit for web_search. */
export const DEFAULT_SEARCH_LIMIT = 5;

/** Input for a web search. */
export interface WebSearchInput {
  /** Search query. */
  query: string;
  /** Maximum number of results to return. */
  limit?: number | undefined;
  /** Abort signal for the underlying request. */
  signal?: AbortSignal | undefined;
}

/** A single web search result. */
export interface WebSearchResult {
  /** Page title. */
  title: string;
  /** Result URL. */
  url: string;
  /** Snippet or summary of the page. */
  content: string;
  /** Publication date, if known. */
  publishedAt?: string | undefined;
}

/** Output of a web search. */
export interface WebSearchResponse {
  /** The query that was executed. */
  query: string;
  /** Search results. */
  results: WebSearchResult[];
  /** Optional provider-generated answer. */
  answer?: string | undefined;
  /** Response time in seconds, if available. */
  responseTime?: number | undefined;
}

/** Capability contract for web search backends. */
export interface WebSearchProvider {
  search(input: WebSearchInput): Promise<WebSearchResponse>;
}

/** Input for a single web extract. */
export interface WebExtractInput {
  /** URL to extract content from. */
  url: string;
  /** Abort signal for the underlying request. */
  signal?: AbortSignal | undefined;
}

/** A single extracted page. */
export interface WebExtractResult {
  /** Page URL. */
  url: string;
  /** Extracted page content (markdown by default). */
  content: string;
  /** Image URLs found on the page, if available. */
  images?: string[] | undefined;
  /** Favicon URL, if available. */
  favicon?: string | undefined;
}

/** Output of a web extract. */
export interface WebExtractResponse {
  /** Successfully extracted pages. */
  results: WebExtractResult[];
  /** URLs that could not be extracted. */
  failed: Array<{ url: string; error: string }>;
  /** Response time in seconds, if available. */
  responseTime?: number | undefined;
}

/** Capability contract for web extract backends. */
export interface WebExtractProvider {
  extract(input: WebExtractInput): Promise<WebExtractResponse>;
}
