/** A single generated/edited image. */
export interface ImageGenImage {
  /** Public URL of the generated image. */
  url: string;
  /** Width in pixels, if available. */
  width?: number | undefined;
  /** Height in pixels, if available. */
  height?: number | undefined;
  /** MIME type of the image, if available. */
  contentType?: string | undefined;
}

/** Provider-side input for image generation. */
export interface ImageGenInput {
  /** Text prompt describing the desired image. */
  prompt: string;
  /** Endpoint id configured by the environment, not exposed to the model. */
  model: string;
  /** Optional aspect-ratio preset passed through as the backend's image_size. */
  aspectRatio?: string | undefined;
  /** Local file paths of reference images for image-to-image editing. */
  referenceImagePaths?: string[] | undefined;
  /** Abort signal for the underlying request. */
  signal?: AbortSignal | undefined;
}

/** Provider-side output for image generation. */
export interface ImageGenOutput {
  /** Generated/edited images. */
  images: ImageGenImage[];
}

/** Capability contract for image-generation backends. */
export interface ImageGenProvider {
  generate(input: ImageGenInput): Promise<ImageGenOutput>;
}
