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
}

export interface GenerateResult {
  buffer: Buffer;
  /** Provider-qualified model id, e.g. 'pollinations:sana'. */
  model: string;
  /** Some providers (DALL-E) rewrite the prompt and return what they used. */
  revisedPrompt?: string;
}

export interface ImageProvider {
  readonly name: string;
  /** False when the provider's credentials are absent — it is then skipped. */
  isAvailable(): boolean;
  generate(req: GenerateRequest): Promise<GenerateResult>;
}
