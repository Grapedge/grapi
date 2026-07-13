import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadWebConfig } from "./config.js";
import { TavilyProvider } from "./tavily.js";
import { registerWebExtractTool } from "./web-extract.js";
import { registerWebSearchTool } from "./web-search.js";

export default function webExtension(pi: ExtensionAPI): void {
  const config = loadWebConfig();

  if (!config.apiKey) {
    let missingKeyNotified = false;
    pi.on("session_start", async (_event, ctx: ExtensionContext) => {
      if (!missingKeyNotified && ctx.hasUI) {
        missingKeyNotified = true;
        ctx.ui.notify(
          "TAVILY_API_KEY is not set; web_search and web_extract tools are unavailable.",
          "warning",
        );
      }
    });
    return;
  }

  const provider = new TavilyProvider(config.apiKey);
  registerWebSearchTool(pi, provider);
  registerWebExtractTool(pi, provider);
}
