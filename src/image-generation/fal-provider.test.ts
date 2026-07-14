import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { FalImageGenProvider, type ImageGenFalClient } from "./fal-provider.js";

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    readFile: vi.fn(),
  };
});

type FakeImageGenClient = ImageGenFalClient & {
  subscribe: ReturnType<typeof vi.fn>;
  storage: { upload: ReturnType<typeof vi.fn> };
};

function createFakeClient(
  response: unknown,
  uploadUrl = "https://fal.storage/uploaded.png",
): FakeImageGenClient {
  return {
    subscribe: vi.fn().mockResolvedValue({ data: response, requestId: "req-1" }),
    storage: { upload: vi.fn().mockResolvedValue(uploadUrl) },
  } as unknown as FakeImageGenClient;
}

function givenFilesExist(files: Record<string, Buffer>): void {
  const readFileMock = readFile as unknown as ReturnType<typeof vi.fn>;
  readFileMock.mockImplementation(async (path: string) => {
    const buffer = files[path];
    if (buffer === undefined) throw new Error(`ENOENT: ${path}`);
    return buffer;
  });
}

describe("FalImageGenProvider #unit", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("text-to-image generation", () => {
    it("calls the configured model endpoint with the right defaults", async () => {
      const client = createFakeClient({
        images: [
          {
            url: "https://fal.storage/result.png",
            content_type: "image/png",
            width: 1024,
            height: 768,
          },
        ],
      });
      const provider = new FalImageGenProvider({
        apiKey: "test-key",
        model: "openai/gpt-image-2",
        client,
      });

      const result = await provider.generate({ prompt: "a cat", model: "openai/gpt-image-2" });

      expect(client.subscribe).toHaveBeenCalledTimes(1);
      const [endpointId, options] = client.subscribe.mock.calls[0]! as [
        string,
        { input: Record<string, unknown> },
      ];
      expect(endpointId).toBe("openai/gpt-image-2");
      expect(options.input).toEqual({
        prompt: "a cat",
        num_images: 1,
        output_format: "png",
        quality: "medium",
        image_size: "landscape_4_3",
      });
      expect(result.images).toEqual([
        {
          url: "https://fal.storage/result.png",
          contentType: "image/png",
          width: 1024,
          height: 768,
        },
      ]);
    });

    it("passes aspect_ratio as image_size when provided", async () => {
      const client = createFakeClient({ images: [{ url: "https://fal.storage/result.png" }] });
      const provider = new FalImageGenProvider({
        apiKey: "test-key",
        model: "openai/gpt-image-2",
        client,
      });

      await provider.generate({
        prompt: "a cat",
        model: "openai/gpt-image-2",
        aspectRatio: "landscape_4_3",
      });

      const [, options] = client.subscribe.mock.calls[0]! as [
        string,
        { input: Record<string, unknown> },
      ];
      expect(options.input.image_size).toBe("landscape_4_3");
    });

    it("forwards the abort signal", async () => {
      const client = createFakeClient({ images: [{ url: "https://fal.storage/result.png" }] });
      const provider = new FalImageGenProvider({
        apiKey: "test-key",
        model: "openai/gpt-image-2",
        client,
      });
      const controller = new AbortController();

      await provider.generate({
        prompt: "a cat",
        model: "openai/gpt-image-2",
        signal: controller.signal,
      });

      const [, options] = client.subscribe.mock.calls[0]! as [
        string,
        { abortSignal?: AbortSignal },
      ];
      expect(options.abortSignal).toBe(controller.signal);
    });

    it("prefers the input model over the constructor model", async () => {
      const client = createFakeClient({ images: [{ url: "https://fal.storage/result.png" }] });
      const provider = new FalImageGenProvider({
        apiKey: "test-key",
        model: "openai/gpt-image-2",
        client,
      });

      await provider.generate({ prompt: "a cat", model: "custom/model" });

      const [endpointId] = client.subscribe.mock.calls[0]! as [string, unknown];
      expect(endpointId).toBe("custom/model");
    });
  });

  describe("image-to-image editing", () => {
    it("uploads reference images and calls the edit endpoint", async () => {
      givenFilesExist({ "/tmp/cat.png": Buffer.from("cat") });
      const client = createFakeClient({ images: [{ url: "https://fal.storage/edited.png" }] });
      const provider = new FalImageGenProvider({
        apiKey: "test-key",
        model: "openai/gpt-image-2",
        client,
      });

      const result = await provider.generate({
        prompt: "add a hat",
        model: "openai/gpt-image-2",
        referenceImagePaths: ["/tmp/cat.png"],
      });

      expect(client.storage.upload).toHaveBeenCalledTimes(1);
      const uploadedFile = client.storage.upload.mock.calls[0]![0] as File;
      expect(uploadedFile.name).toBe("cat.png");
      expect(uploadedFile.type).toBe("image/png");
      const image = result.images[0]!;
      expect(image.url).toBe("https://fal.storage/edited.png");
      const [endpointId, options] = client.subscribe.mock.calls[0]! as [
        string,
        { input: Record<string, unknown> },
      ];
      expect(endpointId).toBe("openai/gpt-image-2/edit");
      expect(options.input.image_urls).toEqual(["https://fal.storage/uploaded.png"]);
    });

    it("throws a model-readable error when a reference image cannot be read", async () => {
      givenFilesExist({});
      const client = createFakeClient({ images: [{ url: "https://fal.storage/edited.png" }] });
      const provider = new FalImageGenProvider({
        apiKey: "test-key",
        model: "openai/gpt-image-2",
        client,
      });

      await expect(
        provider.generate({
          prompt: "add a hat",
          model: "openai/gpt-image-2",
          referenceImagePaths: ["/tmp/missing.png"],
        }),
      ).rejects.toThrow(/Failed to read reference image/);
    });

    it("throws a model-readable error when a reference image upload fails", async () => {
      givenFilesExist({ "/tmp/cat.png": Buffer.from("cat") });
      const client = createFakeClient({ images: [{ url: "https://fal.storage/edited.png" }] });
      client.storage.upload.mockRejectedValue(new Error("Network error"));
      const provider = new FalImageGenProvider({
        apiKey: "test-key",
        model: "openai/gpt-image-2",
        client,
      });

      await expect(
        provider.generate({
          prompt: "add a hat",
          model: "openai/gpt-image-2",
          referenceImagePaths: ["/tmp/cat.png"],
        }),
      ).rejects.toThrow(/Failed to upload reference image/);
    });
  });

  describe.skipIf(!process.env.SMOKE)("live Fal API #smoke", () => {
    it("generates an image with the default model", async () => {
      const provider = new FalImageGenProvider({
        apiKey: process.env.FAL_KEY!,
        model: "openai/gpt-image-2",
      });
      const result = await provider.generate({
        prompt: "a small blue square",
        model: "openai/gpt-image-2",
      });
      expect(result.images.length).toBeGreaterThan(0);
      expect(typeof result.images[0]!.url).toBe("string");
    }, 120_000);
  });

  describe("error handling", () => {
    it("throws a model-readable error when fal returns an error", async () => {
      const client = createFakeClient({});
      client.subscribe.mockRejectedValue(new Error("Bad request"));
      const provider = new FalImageGenProvider({
        apiKey: "test-key",
        model: "openai/gpt-image-2",
        client,
      });

      await expect(
        provider.generate({ prompt: "a cat", model: "openai/gpt-image-2" }),
      ).rejects.toThrow(/Fal image generation failed.*Bad request/);
    });

    it("throws when the response has no images array", async () => {
      const client = createFakeClient({ unexpected: true });
      const provider = new FalImageGenProvider({
        apiKey: "test-key",
        model: "openai/gpt-image-2",
        client,
      });

      await expect(
        provider.generate({ prompt: "a cat", model: "openai/gpt-image-2" }),
      ).rejects.toThrow(/unexpected response shape/);
    });
  });
});
