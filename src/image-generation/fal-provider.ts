import { ApiError, ValidationError, createFalClient } from "@fal-ai/client";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { ImageGenInput, ImageGenOutput, ImageGenProvider } from "./types.js";

/** Minimal Fal client surface used by image generation. */
export interface ImageGenFalClient {
  subscribe(endpointId: string, options: unknown): Promise<{ data: unknown; requestId: string }>;
  storage: { upload(file: Blob): Promise<string> };
}

export const DEFAULT_IMAGE_MODEL = "openai/gpt-image-2";

/** Edit endpoint is fixed to the gpt-image-2 edit model, regardless of FAL_IMAGE_MODEL. */
const EDIT_ENDPOINT = `${DEFAULT_IMAGE_MODEL}/edit`;
const DEFAULT_ASPECT_RATIO = "landscape_4_3";
const DEFAULT_NUM_IMAGES = 1;
const DEFAULT_OUTPUT_FORMAT = "png";
const DEFAULT_QUALITY = "medium";

interface FalImageGenWireImage {
  url: string;
  content_type?: string;
  width?: number;
  height?: number;
}

interface FalImageGenWireOutput {
  images?: FalImageGenWireImage[];
}

export interface FalImageGenProviderOptions {
  apiKey: string;
  model: string;
  client?: ImageGenFalClient;
}

export class FalImageGenProvider implements ImageGenProvider {
  private readonly client: ImageGenFalClient;
  private readonly model: string;

  constructor({ apiKey, model, client }: FalImageGenProviderOptions) {
    this.client = client ?? createFalClient({ credentials: apiKey });
    this.model = model;
  }

  async generate(input: ImageGenInput): Promise<ImageGenOutput> {
    const model = input.model ?? this.model;
    const hasReferences =
      input.referenceImagePaths !== undefined && input.referenceImagePaths.length > 0;
    const endpointId = hasReferences ? EDIT_ENDPOINT : model;
    const imageUrls = await this.uploadReferenceImages(input.referenceImagePaths);

    const requestInput: Record<string, unknown> = {
      prompt: input.prompt,
      num_images: DEFAULT_NUM_IMAGES,
      output_format: DEFAULT_OUTPUT_FORMAT,
      quality: DEFAULT_QUALITY,
    };
    requestInput.image_size = input.aspectRatio ?? DEFAULT_ASPECT_RATIO;
    if (imageUrls.length > 0) {
      requestInput.image_urls = imageUrls;
    }

    const options: import("@fal-ai/client").RunOptions<Record<string, unknown>> = {
      input: requestInput,
      ...(input.signal !== undefined ? { abortSignal: input.signal } : {}),
    };

    try {
      const result = await this.client.subscribe(endpointId, options);
      return { images: this.mapImages(result.data as FalImageGenWireOutput) };
    } catch (error) {
      throw new Error(
        `Fal image generation failed: ${formatFalError(error)}. Check the prompt, aspect ratio, and reference images, then retry.`,
        { cause: error },
      );
    }
  }

  private async uploadReferenceImages(paths: string[] | undefined): Promise<string[]> {
    if (paths === undefined || paths.length === 0) return [];
    const uploads = paths.map((path) => this.uploadReferenceImage(path));
    return Promise.all(uploads);
  }

  private async uploadReferenceImage(path: string): Promise<string> {
    let buffer: Buffer;
    try {
      buffer = await readFile(path);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown error";
      throw new Error(`Failed to read reference image ${path}: ${reason}`);
    }

    const fileName = basename(path);
    const file = new File([new Uint8Array(buffer)], fileName, { type: contentTypeForPath(path) });
    try {
      return await this.client.storage.upload(file);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown error";
      throw new Error(`Failed to upload reference image ${path}: ${reason}`);
    }
  }

  private mapImages(data: FalImageGenWireOutput): ImageGenOutput["images"] {
    if (!Array.isArray(data.images)) {
      throw new Error("Fal image generation returned an unexpected response shape.");
    }
    return data.images.map((image) => ({
      url: image.url,
      contentType: image.content_type,
      width: image.width,
      height: image.height,
    }));
  }
}

function formatFalError(error: unknown): string {
  if (error instanceof ValidationError) {
    const details = error.fieldErrors
      .map((info) => `${info.loc.join(".")}: ${info.msg}`)
      .join("; ");
    return `Validation error (422)${details ? ` - ${details}` : ""}`;
  }
  if (error instanceof ApiError) {
    const bodyMessage =
      typeof error.body === "object" && error.body !== null && "detail" in error.body
        ? String((error.body as { detail?: unknown }).detail)
        : JSON.stringify(error.body);
    return `${error.status}${bodyMessage ? ` ${bodyMessage}` : ""}`;
  }
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return "Unknown error";
}

function contentTypeForPath(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      return "application/octet-stream";
  }
}
