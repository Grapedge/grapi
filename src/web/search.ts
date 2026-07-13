import {
  type AgentToolResult,
  type AgentToolUpdateCallback,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { DEFAULT_SEARCH_LIMIT, type WebSearchProvider, type WebSearchResult } from "./types.js";

const webSearchSchema = Type.Object({
  query: Type.String({ description: "Search query" }),
  limit: Type.Optional(
    Type.Number({
      default: DEFAULT_SEARCH_LIMIT,
      minimum: 1,
      maximum: 10,
      description: `Maximum number of results (1-10, default ${DEFAULT_SEARCH_LIMIT})`,
    }),
  ),
});

export type WebSearchToolInput = Static<typeof webSearchSchema>;

export interface WebSearchToolDetails {
  query: string;
  results: WebSearchResult[];
  answer?: string | undefined;
  usage?: unknown | undefined;
  responseTime?: number | undefined;
}

export function createWebSearchToolDefinition(provider: WebSearchProvider) {
  return defineTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web and return results as a markdown numbered list. Use web_search when you need current information, facts, news, or sources beyond your training data. Output is limited to 50KB / 2000 lines; use web_extract to read a specific result in depth.",
    promptSnippet: "Search the web for current information",
    promptGuidelines: [
      "Use web_search when the user asks about recent events, current facts, or anything that may have changed after your knowledge cutoff.",
    ],
    parameters: webSearchSchema,
    async execute(
      _toolCallId: string,
      { query, limit }: WebSearchToolInput,
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<WebSearchToolDetails> | undefined,
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult<WebSearchToolDetails>> {
      const result = await provider.search({ query, limit });

      let markdown = result.results
        .map((r, index) => {
          const date = r.publishedAt ? ` (${r.publishedAt})` : "";
          return `${index + 1}. [${r.title}](${r.url})${date}\n   ${r.content}`;
        })
        .join("\n\n");

      if (markdown.length === 0) {
        markdown = "No results found.";
      }

      const truncation = truncateHead(markdown, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });

      let text = truncation.content;
      if (truncation.truncated) {
        text +=
          `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines` +
          ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).` +
          " Use web_extract on specific URLs for full content.]";
      }

      return {
        content: [{ type: "text", text }],
        details: {
          query: result.query,
          results: result.results,
          answer: result.answer,
          usage: result.usage,
          responseTime: result.responseTime,
        },
      };
    },
  });
}

export function registerWebSearchTool(pi: ExtensionAPI, provider?: WebSearchProvider): void {
  if (!provider) return;
  pi.registerTool(createWebSearchToolDefinition(provider));
}
