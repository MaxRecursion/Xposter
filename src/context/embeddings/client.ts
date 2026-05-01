export type EmbeddingKind = 'document' | 'query';

export interface EmbeddingClient {
  readonly dim: number;
  readonly modelId: string;
  embed(inputs: string[], opts?: { kind?: EmbeddingKind }): Promise<Float32Array[]>;
}
