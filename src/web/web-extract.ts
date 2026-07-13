import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TavilyProvider } from "./tavily.js";

/**
 * Web extract extension entry point.
 *
 * Currently registers no tools — web_extract will be added here once the
 * tool semantics (truncation, content length, error handling) are finalized.
 * The TavilyProvider.extract capability is already available and tested.
 */
export default function webExtractExtension(pi: ExtensionAPI): void {
  const apiKey = process.env.TAVILY_API_KEY?.trim();
  const provider = apiKey ? new TavilyProvider(apiKey) : undefined;

  let missingKeyNotified = false;

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    if (!provider && !missingKeyNotified && ctx.hasUI) {
      missingKeyNotified = true;
      ctx.ui.notify("TAVILY_API_KEY is not set; web_extract tool is unavailable.", "warning");
    }
  });

  // TODO: register web_extract tool using provider.extract once ready.
}
