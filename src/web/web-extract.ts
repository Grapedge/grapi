import {
  type AgentToolResult,
  type AgentToolUpdateCallback,
  type ExtensionAPI,
  type ExtensionContext,
  type TruncationResult,
  defineTool,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { randomUUID } from "node:crypto";
import { stripUntrustedWrapper, wrapUntrustedContent } from "./untrusted-content.js";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebExtractProvider, WebExtractResponse } from "./types.js";

const webExtractSchema = Type.Object({
  url: Type.String({
    description: "URL to read (must start with http:// or https://)",
  }),
});

export type WebExtractToolInput = Static<typeof webExtractSchema>;

export interface WebExtractToolDetails {
  truncation?: TruncationResult;
  fullOutputPath?: string;
}

function isValidUrl(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://");
}

async function spillExtractedContent(content: string, toolCallId: string): Promise<string> {
  const fileName = `pi-web-extract-${toolCallId}-${randomUUID()}.md`;
  const filePath = join(tmpdir(), fileName);
  await writeFile(filePath, content, "utf-8");
  return filePath;
}

function formatTruncationNote(truncation: TruncationResult, fullOutputPath: string): string {
  if (truncation.firstLineExceedsLimit) {
    return [
      `The first line of the extracted page exceeds the ${formatSize(truncation.maxBytes)} output limit, so the inline output has been omitted.`,
      `Full output written to: ${fullOutputPath}`,
      "Preview the first line with:",
      "```bash",
      `head -n 1 ${JSON.stringify(fullOutputPath)}`,
      "```",
    ].join("\n");
  }

  return [
    `Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`,
    `(${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`,
    `Full output written to: ${fullOutputPath}.`,
    `Continue with: read --offset ${truncation.outputLines + 1} --limit ${truncation.maxLines} ${fullOutputPath}`,
  ].join(" ");
}

export function createWebExtractToolDefinition(provider: WebExtractProvider) {
  return defineTool({
    name: "web_extract",
    label: "web extract",
    description:
      "Read a single web page and return its article or documentation content as Markdown. Use web_extract when you already have a URL. Prefer web_search when you only have a question or need multiple sources. If a page fails to load or the content looks wrong, try the browser tool instead.",
    promptSnippet: "Read the content of a web page",
    promptGuidelines: [
      "Use web_extract when the user provides a URL and wants the full article or documentation content.",
      "Use web_search when you need to discover URLs or get a quick summary of multiple sources.",
      "If web_extract fails or returns incomplete content, fall back to the browser tool if available.",
    ],
    parameters: webExtractSchema,
    async execute(
      toolCallId: string,
      { url }: WebExtractToolInput,
      signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<WebExtractToolDetails> | undefined,
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult<WebExtractToolDetails>> {
      if (!isValidUrl(url)) {
        throw new Error(
          "Invalid URL: must start with http:// or https://. Please rewrite the input with a valid URL.",
        );
      }

      let response: WebExtractResponse;
      try {
        response = await provider.extract({ url, signal });
      } catch (error) {
        const reason = error instanceof Error ? error.message : "Unknown error";
        throw new Error(
          `Failed to extract ${url}: ${reason}. The page may be inaccessible or the URL may be invalid. Try using the browser tool if available.`,
        );
      }

      const page = response.results[0];
      if (!page) {
        const failure = response.failed.find((f) => f.url === url);
        const reason = failure?.error ?? "No content could be extracted";
        const text = `Failed to extract ${url}: ${reason}. The page may be inaccessible or the URL may be invalid. Try using the browser tool if available.`;
        return {
          content: [{ type: "text", text: wrapUntrustedContent(text) }],
          details: {},
        };
      }

      const rawContent = page.content;
      const truncation = truncateHead(rawContent);
      if (!truncation.truncated) {
        return {
          content: [{ type: "text", text: wrapUntrustedContent(rawContent) }],
          details: {},
        };
      }

      const fullOutputPath = await spillExtractedContent(rawContent, toolCallId);
      const displayedText = truncation.firstLineExceedsLimit
        ? formatTruncationNote(truncation, fullOutputPath)
        : `${truncation.content}\n\n${formatTruncationNote(truncation, fullOutputPath)}`;

      return {
        content: [{ type: "text", text: wrapUntrustedContent(displayedText) }],
        details: { truncation, fullOutputPath },
      };
    },
    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(theme.fg("toolTitle", theme.bold(`web_extract ${args.url}`)));
      return text;
    },
    renderResult(result, options, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      if (!options.expanded) {
        text.setText("");
        return text;
      }
      const firstText = result.content.find((c) => c.type === "text")?.text ?? "";
      const cleanText = firstText ? stripUntrustedWrapper(firstText) : "";
      text.setText(cleanText ? `\n${theme.fg("toolOutput", cleanText)}` : "");
      return text;
    },
  });
}

export function registerWebExtractTool(pi: ExtensionAPI, provider?: WebExtractProvider): void {
  if (!provider) return;
  pi.registerTool(createWebExtractToolDefinition(provider));
}
