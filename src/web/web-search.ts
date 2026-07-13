import {
  type AgentToolResult,
  type AgentToolUpdateCallback,
  type ExtensionAPI,
  type ExtensionContext,
  defineTool,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { wrapUntrustedContent } from "./untrusted-content.js";
import { DEFAULT_SEARCH_LIMIT, type WebSearchProvider, type WebSearchResponse } from "./types.js";

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
  results: Array<{ title: string; url: string }>;
}

function coerceLimit(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return undefined;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_SEARCH_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), 10);
}

const MAX_RESULT_CONTENT_LENGTH = 2000;
function truncateResultContent(content: string): string {
  if (content.length <= MAX_RESULT_CONTENT_LENGTH) return content;
  return `${content.slice(0, MAX_RESULT_CONTENT_LENGTH)}…`;
}

function formatSearchResults(response: WebSearchResponse): string {
  const list = response.results
    .map((r, index) => {
      const date = r.publishedAt ? ` (${r.publishedAt})` : "";
      const content = truncateResultContent(r.content);
      return `${index + 1}. [${r.title}](${r.url})${date}\n   ${content}`;
    })
    .join("\n\n");

  if (response.results.length === 0) {
    return response.answer ?? "No results found.";
  }

  return response.answer ? `${response.answer}\n\n${list}` : list;
}

export function createWebSearchToolDefinition(provider: WebSearchProvider) {
  return defineTool({
    name: "web_search",
    label: "web search",
    description:
      "Search the web and return results as a markdown numbered list. Use web_search when you need current information, facts, news, or sources beyond your training data. Long result descriptions are truncated; titles and URLs are always preserved.",
    promptSnippet: "Search the web for current information",
    promptGuidelines: [
      "Use web_search when the user asks about recent events, current facts, or anything that may have changed after your knowledge cutoff.",
    ],
    parameters: webSearchSchema,
    async execute(
      _toolCallId: string,
      { query, limit }: WebSearchToolInput,
      signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<WebSearchToolDetails> | undefined,
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult<WebSearchToolDetails>> {
      const result = await provider.search({
        query,
        limit: clampLimit(coerceLimit(limit)),
        signal,
      });
      const text = wrapUntrustedContent(formatSearchResults(result));

      return {
        content: [{ type: "text", text }],
        details: {
          results: result.results.map((r) => ({ title: r.title, url: r.url })),
        },
      };
    },
    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(theme.fg("toolTitle", theme.bold(`web_search ${args.query}`)));
      return text;
    },
    renderResult(result, options, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      if (!options.expanded) {
        text.setText("");
        return text;
      }
      const sources = result.details?.results ?? [];
      if (sources.length === 0) {
        text.setText("");
        return text;
      }
      const lines = sources
        .map((r, i) => `${i + 1}. ${theme.fg("toolOutput", r.title)}: ${theme.fg("accent", r.url)}`)
        .join("\n");
      text.setText(`\n${lines}`);
      return text;
    },
  });
}

export function registerWebSearchTool(pi: ExtensionAPI, provider?: WebSearchProvider): void {
  if (!provider) return;
  pi.registerTool(createWebSearchToolDefinition(provider));
}
