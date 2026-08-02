/**
 * Image provider interface.
 *
 * Mirrors the shape of `ContextSource` (src/context/types.ts): a readonly name
 * plus one async method, so providers can be assembled into an ordered chain by
 * a small factory instead of an if/else ladder.
 */

export interface GenerateRequest {
  prompt: string;
  width: number;
  height: number;
  seed: number;
  /**
   * Aspect ratio as "W:H". Providers that take a ratio rather than pixel
   * dimensions (Gemini) use this; the rest derive it from width/height.
   */
  aspectRatio?: string;
  /**
   * Style reference images. Used for wardrobe / hair / colour-grade continuity
   * — the persona is faceless, so there is no facial identity to preserve.
   * Providers that don't accept references ignore this.
   */
  referenceImages?: Buffer[];
}

export interface GenerateResult {
  buffer: Buffer;
  /** Provider-qualified model id, e.g. 'pollinations:sana'. */
  model: string;
  /** Some providers (DALL-E) rewrite the prompt and return what they used. */
  revisedPrompt?: string;
  /** Estimated USD cost of this call. 0 for free providers. Feeds the budget guard. */
  costUsd?: number;
}

export interface ImageProvider {
  readonly name: string;
  /** False when the provider's credentials are absent — it is then skipped. */
  isAvailable(): boolean;
  /**
   * Estimated USD cost per generation. 0 means free. Checked against the
   * monthly budget before this provider is used.
   */
  costPerImageUsd(): number;
  /**
   * Whether this backend can consume `referenceImages`. Used by generateImage
   * so the anchor prompt note is only attached when refs will actually be sent.
   */
  supportsReferences?: boolean;
  generate(req: GenerateRequest): Promise<GenerateResult>;
}
