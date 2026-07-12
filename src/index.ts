import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";
import { registerWebSearchTool } from "./web/search.js";

export default function grapi(pi: ExtensionAPI): void {
  const config = loadConfig();
  let missingKeyNotified = false;

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    if (!config.webSearchProvider && !missingKeyNotified) {
      missingKeyNotified = true;
      ctx.ui.notify("TAVILY_API_KEY is not set; web_search tool is unavailable.", "warning");
    }
  });

  registerWebSearchTool(pi, config.webSearchProvider);
}
