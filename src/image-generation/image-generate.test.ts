import { beforeEach, describe, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { createImageGenerateToolDefinition, registerImageGenerateTool } from "./image-generate.js";
import { FAKE_CTX, fakeTheme } from "../web/test-helpers.js";
import type { ImageGenOutput, ImageGenProvider } from "./types.js";

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    writeFile: vi.fn().mockResolvedValue(undefined),
  };
});

function createFakeProvider(
  response: ImageGenOutput,
): ImageGenProvider & { generate: ReturnType<typeof vi.fn> } {
  return { generate: vi.fn().mockResolvedValue(response) };
}

function givenFetchReturnsImage(): void {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    arrayBuffer: async () => new ArrayBuffer(8),
  } as Response);
}

function textContentOf(result: {
  content: ReadonlyArray<{ type: string; text?: string | undefined }>;
}): string {
  return result.content.find((c) => c.type === "text")?.text ?? "";
}

describe("createImageGenerateToolDefinition #unit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    givenFetchReturnsImage();
  });

  describe("when the provider returns images", () => {
    it("downloads each image to a temp file and returns url + path", async () => {
      const provider = createFakeProvider({
        images: [
          {
            url: "https://fal.storage/result.png",
            width: 1024,
            height: 768,
            contentType: "image/png",
          },
        ],
      });
      const tool = createImageGenerateToolDefinition(provider, "openai/gpt-image-2");

      const result = await tool.execute(
        "call-1",
        { prompt: "a cat" },
        undefined,
        undefined,
        FAKE_CTX,
      );

      const text = textContentOf(result);
      expect(text).toMatch(/^<untrusted_tool_result>\n[\s\S]*\n<\/untrusted_tool_result>$/);
      expect(text).toContain("url: https://fal.storage/result.png");
      expect(text).toContain("path:");
      expect(result.details).toEqual({
        url: "https://fal.storage/result.png",
        path: expect.stringMatching(/pi-image-gen-call-1-0-.*\.png$/),
      });
      expect(writeFile).toHaveBeenCalledTimes(1);
    });

    it("coerces a single reference image path string into an array", async () => {
      const provider = createFakeProvider({ images: [{ url: "https://fal.storage/edited.png" }] });
      const tool = createImageGenerateToolDefinition(provider, "openai/gpt-image-2");

      await tool.execute(
        "call-1",
        { prompt: "add a hat", reference_image_paths: "/tmp/cat.png" as unknown as string[] },
        undefined,
        undefined,
        FAKE_CTX,
      );

      const call = provider.generate.mock.calls[0]!;
      expect(call[0].referenceImagePaths).toEqual(["/tmp/cat.png"]);
    });

    it("forwards an abort signal to the provider", async () => {
      const provider = createFakeProvider({ images: [{ url: "https://fal.storage/result.png" }] });
      const tool = createImageGenerateToolDefinition(provider, "openai/gpt-image-2");
      const controller = new AbortController();

      await tool.execute("call-1", { prompt: "a cat" }, controller.signal, undefined, FAKE_CTX);

      const call = provider.generate.mock.calls[0]!;
      expect(call[0].signal).toBe(controller.signal);
    });

    it("still returns the CDN URL when a download fails", async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue({ ok: false, status: 404, statusText: "Not Found" });
      const provider = createFakeProvider({
        images: [{ url: "https://fal.storage/result.png", contentType: "image/png" }],
      });
      const tool = createImageGenerateToolDefinition(provider, "openai/gpt-image-2");

      const result = await tool.execute(
        "call-1",
        { prompt: "a cat" },
        undefined,
        undefined,
        FAKE_CTX,
      );

      expect(result.details.url).toBe("https://fal.storage/result.png");
      expect(result.details.path).toBeUndefined();
    });
  });

  describe("when the prompt is empty", () => {
    it("throws a model-readable error", async () => {
      const tool = createImageGenerateToolDefinition(
        createFakeProvider({ images: [] }),
        "openai/gpt-image-2",
      );

      await expect(
        tool.execute("call-1", { prompt: "   " }, undefined, undefined, FAKE_CTX),
      ).rejects.toThrow(/prompt is required/);
    });
  });

  describe("renderCall", () => {
    it("renders the tool name and prompt", () => {
      const tool = createImageGenerateToolDefinition(
        createFakeProvider({ images: [] }),
        "openai/gpt-image-2",
      );
      const component = tool.renderCall?.(
        { prompt: "a cat" },
        fakeTheme() as never,
        { lastComponent: undefined, args: { prompt: "a cat" } } as never,
      );
      const rendered = component?.render(80) ?? [];
      expect(rendered.join("\n")).toContain("image_generate a cat");
    });

    it("renders the edit label when reference images are present", () => {
      const tool = createImageGenerateToolDefinition(
        createFakeProvider({ images: [] }),
        "openai/gpt-image-2",
      );
      const component = tool.renderCall?.(
        { prompt: "a cat", reference_image_paths: ["/tmp/cat.png"] },
        fakeTheme() as never,
        { lastComponent: undefined, args: { prompt: "a cat" } } as never,
      );
      const rendered = component?.render(80) ?? [];
      expect(rendered.join("\n")).toContain("image_generate (edit) a cat");
    });
  });

  describe("renderResult", () => {
    it("renders local paths when collapsed", () => {
      const tool = createImageGenerateToolDefinition(
        createFakeProvider({ images: [] }),
        "openai/gpt-image-2",
      );
      const component = tool.renderResult?.(
        {
          content: [],
          details: { url: "https://fal.storage/result.png", path: "/tmp/a.png" },
        },
        { expanded: false, isPartial: false },
        fakeTheme() as never,
        { lastComponent: undefined, args: { prompt: "a cat" } } as never,
      );
      const rendered = component?.render(80).join("\n") ?? "";
      expect(rendered).toContain("/tmp/a.png");
    });

    it("renders the prompt, url and path when expanded", () => {
      const tool = createImageGenerateToolDefinition(
        createFakeProvider({ images: [] }),
        "openai/gpt-image-2",
      );
      const component = tool.renderResult?.(
        {
          content: [],
          details: { url: "https://fal.storage/result.png", path: "/tmp/a.png" },
        },
        { expanded: true, isPartial: false },
        fakeTheme() as never,
        { lastComponent: undefined, args: { prompt: "a cute cat" } } as never,
      );
      const rendered = component?.render(80).join("\n") ?? "";
      expect(rendered).toContain("prompt: a cute cat");
      expect(rendered).toContain("url: https://fal.storage/result.png");
      expect(rendered).toContain("path: /tmp/a.png");
    });
  });
});

describe("registerImageGenerateTool #unit", () => {
  it("registers the image_generate tool when a provider and model are given", () => {
    const registerTool = vi.fn();
    const pi = { registerTool } as unknown as { registerTool: typeof registerTool };
    registerImageGenerateTool(
      pi as never,
      createFakeProvider({ images: [] }),
      "openai/gpt-image-2",
    );
    expect(registerTool).toHaveBeenCalledTimes(1);
    expect(registerTool.mock.calls[0]?.[0]?.name).toBe("image_generate");
  });

  it("does nothing when the provider is undefined", () => {
    const registerTool = vi.fn();
    const pi = { registerTool } as unknown as { registerTool: typeof registerTool };
    registerImageGenerateTool(pi as never, undefined, "openai/gpt-image-2");
    expect(registerTool).not.toHaveBeenCalled();
  });

  it("does nothing when the model is undefined", () => {
    const registerTool = vi.fn();
    const pi = { registerTool } as unknown as { registerTool: typeof registerTool };
    registerImageGenerateTool(pi as never, createFakeProvider({ images: [] }), undefined);
    expect(registerTool).not.toHaveBeenCalled();
  });
});
