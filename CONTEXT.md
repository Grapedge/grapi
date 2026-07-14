# Domain Glossary

## Image generation

- **`image_generate`** — The tool exposed to the model. Named after the mainstream convention used by Hermes and OpenClaw.
- **`ImageGenProvider`** — Capability interface for any image-generation backend.
- **`ImageGenInput`** — Provider-side input contract.
  - `prompt: string`
  - `model: string` — endpoint id, configured by the environment, not exposed to the model.
  - `aspectRatio?: string` — a fal `image_size` preset (defaults to `landscape_4_3`).
  - `referenceImagePaths?: string[]` — local file paths for image-to-image editing; the FalImageGenProvider reads them and uploads via fal's official `storage.upload`, then references them as `image_urls` on the edit endpoint.
  - `signal?: AbortSignal`
- **`ImageGenOutput`** — Provider-side output contract.
  - `images: Array<{ url: string; width?: number; height?: number; contentType?: string }>`
- **Default backend** — `openai/gpt-image-2` via fal.ai for text-to-image, `openai/gpt-image-2/edit` for editing.

## Web

- **`web_search`** — Tool for searching the web.
- **`web_extract`** — Tool for extracting a single web page as markdown.
- **`WebSearchProvider`** / **`WebExtractProvider`** — Capability interfaces for web backends.
