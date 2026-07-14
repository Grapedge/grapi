import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_IMAGE_MODEL, FalImageGenProvider } from "./fal-provider.js";
import { registerImageGenerateTool } from "./image-generate.js";

export default function imageGenerationExtension(pi: ExtensionAPI): void {
  const apiKey = process.env.FAL_KEY?.trim();
  const model = process.env.FAL_IMAGE_MODEL?.trim() || DEFAULT_IMAGE_MODEL;

  if (!apiKey) {
    let missingKeyNotified = false;
    pi.on("session_start", async (_event, ctx: ExtensionContext) => {
      if (!missingKeyNotified && ctx.hasUI) {
        missingKeyNotified = true;
        ctx.ui.notify("FAL_KEY is not set; image_generate tool is unavailable.", "warning");
      }
    });
    return;
  }

  const provider = new FalImageGenProvider({ apiKey, model });
  registerImageGenerateTool(pi, provider, model);
}
