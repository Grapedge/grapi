import {
  type AgentToolResult,
  type AgentToolUpdateCallback,
  type ExtensionAPI,
  type ExtensionContext,
  defineTool,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wrapUntrustedContent } from "../web/untrusted-content.js";
import type { ImageGenImage, ImageGenProvider } from "./types.js";

const imageGenerateSchema = Type.Object({
  prompt: Type.String({
    description: "Text description of the image to generate or edit",
  }),
  aspect_ratio: Type.Optional(
    Type.Union(
      [
        Type.Literal("square"),
        Type.Literal("square_hd"),
        Type.Literal("landscape_4_3"),
        Type.Literal("landscape_16_9"),
        Type.Literal("portrait_4_3"),
        Type.Literal("portrait_16_9"),
      ],
      {
        description:
          "Aspect ratio preset. Must be one of the listed values; omit for the default (landscape_4_3).",
      },
    ),
  ),
  reference_image_paths: Type.Optional(
    Type.Array(
      Type.String({
        description: "Local file path of a reference image for image-to-image editing",
      }),
    ),
  ),
});

export type ImageGenerateToolInput = Static<typeof imageGenerateSchema>;

export interface SavedImage extends ImageGenImage {
  /** Local file path where the image was saved, if download succeeded. */
  path?: string | undefined;
}

export interface ImageGenerateToolDetails {
  /** CDN URL of the generated image. */
  url?: string | undefined;
  /** Local file path of the downloaded image, if available. */
  path?: string | undefined;
}

function coerceReferenceImagePaths(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? [trimmed] : undefined;
  }
  if (Array.isArray(value)) {
    const paths = value.filter(
      (item): item is string => typeof item === "string" && item.trim().length > 0,
    );
    return paths.length > 0 ? paths : undefined;
  }
  return undefined;
}

function formatImageDetails(image: SavedImage): string {
  const dimensions =
    image.width !== undefined && image.height !== undefined
      ? ` (${image.width}x${image.height})`
      : "";
  const mime = image.contentType ? ` [${image.contentType}]` : "";
  return `${dimensions}${mime}`;
}

function formatImages(images: SavedImage[]): string {
  if (images.length === 0) return "No images were generated.";
  const list = images
    .map((image, index) => {
      const pathLine = image.path ? `\n   path: ${image.path}` : "";
      return `${index + 1}. url: ${image.url}${formatImageDetails(image)}${pathLine}`;
    })
    .join("\n\n");
  return `Generated ${images.length} image(s):\n${list}`;
}

function extensionForImage(image: ImageGenImage): string {
  switch (image.contentType) {
    case "image/png":
      return ".png";
    case "image/jpeg":
      return ".jpg";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    default: {
      const match = /\.([a-z0-9]+)$/i.exec(image.url);
      return match?.[1] ? `.${match[1].toLowerCase()}` : ".bin";
    }
  }
}

async function downloadImage(
  image: ImageGenImage,
  filePath: string,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(image.url, signal !== undefined ? { signal } : {});
  if (!response.ok) {
    throw new Error(`Failed to download ${image.url}: ${response.status} ${response.statusText}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(filePath, buffer);
}

async function saveGeneratedImages(
  images: ImageGenImage[],
  toolCallId: string,
  signal?: AbortSignal,
): Promise<SavedImage[]> {
  return Promise.all(
    images.map(async (image, index) => {
      const fileName = `pi-image-gen-${toolCallId}-${index}-${randomUUID().slice(0, 8)}${extensionForImage(image)}`;
      const filePath = join(tmpdir(), fileName);
      try {
        await downloadImage(image, filePath, signal);
        return { ...image, path: filePath };
      } catch {
        return { ...image, path: undefined };
      }
    }),
  );
}

export function createImageGenerateToolDefinition(provider: ImageGenProvider, model: string) {
  return defineTool({
    name: "image_generate",
    label: "image generate",
    description:
      "Generate or edit images from a text prompt. Use image_generate when the user asks for illustrations, diagrams, logos, photos, or edits to existing images. Pass reference_image_paths to edit existing images. Results are returned as local file paths and CDN URLs.",
    promptSnippet: "Generate or edit an image",
    promptGuidelines: [
      "Use image_generate for visual content such as diagrams, logos, mockups, or photos.",
      "Pass reference_image_paths to perform image-to-image edits on local images.",
      "Use aspect_ratio to request a specific output shape when it matters.",
    ],
    parameters: imageGenerateSchema,
    async execute(
      _toolCallId: string,
      { prompt, aspect_ratio, reference_image_paths }: ImageGenerateToolInput,
      signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<ImageGenerateToolDetails> | undefined,
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult<ImageGenerateToolDetails>> {
      const trimmedPrompt = prompt.trim();
      if (trimmedPrompt.length === 0) {
        throw new Error("Invalid arguments: prompt is required for image_generate.");
      }

      const result = await provider.generate({
        prompt: trimmedPrompt,
        model,
        aspectRatio: aspect_ratio,
        referenceImagePaths: coerceReferenceImagePaths(reference_image_paths),
        signal,
      });

      const savedImages = await saveGeneratedImages(result.images, _toolCallId, signal);
      const first = savedImages[0];
      const details: ImageGenerateToolDetails =
        first === undefined ? {} : { url: first.url, path: first.path };

      return {
        content: [{ type: "text", text: wrapUntrustedContent(formatImages(savedImages)) }],
        details,
      };
    },
    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const label =
        args.reference_image_paths !== undefined && args.reference_image_paths.length > 0
          ? "image_generate (edit)"
          : "image_generate";
      text.setText(
        theme.fg("toolTitle", theme.bold(label)) + " " + theme.fg("toolTitle", args.prompt),
      );
      return text;
    },
    renderResult(result, options, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const url = result.details?.url;
      if (url === undefined) {
        text.setText("");
        return text;
      }

      if (!options.expanded) {
        const line = result.details?.path ?? url;
        text.setText(line ? `\n${line}` : "");
        return text;
      }

      const prompt = (context.args as ImageGenerateToolInput | undefined)?.prompt ?? "";
      const header = prompt ? theme.fg("toolOutput", `prompt: ${prompt}`) : "";
      const urlLine = `url: ${theme.fg("accent", url)}`;
      const pathLine = result.details?.path
        ? `path: ${theme.fg("toolOutput", result.details.path)}`
        : "";
      const body = pathLine ? `${urlLine}\n${pathLine}` : urlLine;
      text.setText(header ? `\n${header}\n${body}` : `\n${body}`);
      return text;
    },
  });
}

export function registerImageGenerateTool(
  pi: ExtensionAPI,
  provider?: ImageGenProvider,
  model?: string,
): void {
  if (!provider || model === undefined) return;
  pi.registerTool(createImageGenerateToolDefinition(provider, model));
}
