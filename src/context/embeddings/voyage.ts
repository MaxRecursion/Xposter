import axios, { AxiosError } from 'axios';
import { logger } from '../../utils/logger.js';
import type { EmbeddingClient, EmbeddingKind } from './client.js';

const ENDPOINT = 'https://api.voyageai.com/v1/embeddings';
const BATCH_SIZE = 64;
const TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;

interface VoyageResponse {
  data: Array<{ embedding: number[]; index: number }>;
  usage?: { total_tokens?: number };
}

export class VoyageEmbeddings implements EmbeddingClient {
  readonly dim: number;
  readonly modelId = 'voyage-3-lite';

  constructor(private readonly apiKey: string, dim = 512) {
    this.dim = dim;
  }

  async embed(inputs: string[], opts: { kind?: EmbeddingKind } = {}): Promise<Float32Array[]> {
    if (inputs.length === 0) return [];

    const out: Float32Array[] = new Array(inputs.length);
    for (let i = 0; i < inputs.length; i += BATCH_SIZE) {
      const slice = inputs.slice(i, i + BATCH_SIZE);
      const vectors = await this.embedBatch(slice, opts.kind ?? 'document');
      for (let j = 0; j < vectors.length; j++) out[i + j] = vectors[j];
    }
    return out;
  }

  private async embedBatch(batch: string[], kind: EmbeddingKind): Promise<Float32Array[]> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const resp = await axios.post<VoyageResponse>(
          ENDPOINT,
          {
            input: batch,
            model: this.modelId,
            input_type: kind,
            output_dimension: this.dim,
          },
          {
            headers: {
              Authorization: `Bearer ${this.apiKey}`,
              'Content-Type': 'application/json',
            },
            timeout: TIMEOUT_MS,
          },
        );

        const data = resp.data?.data;
        if (!Array.isArray(data) || data.length !== batch.length) {
          throw new Error(`Voyage returned ${data?.length ?? 0} vectors for ${batch.length} inputs`);
        }
        const ordered = [...data].sort((a, b) => a.index - b.index);
        return ordered.map((d) => Float32Array.from(d.embedding));
      } catch (err) {
        lastErr = err;
        const status = (err as AxiosError).response?.status;
        const retryable = !status || status >= 500 || status === 429;
        if (!retryable || attempt === MAX_RETRIES) break;
        const backoff = Math.min(8000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
        logger.warn('Voyage embed retrying', { attempt, status, backoff });
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
    throw new Error(`Voyage embed failed: ${formatErr(lastErr)}`);
  }
}

function formatErr(err: unknown): string {
  const ax = err as AxiosError;
  if (ax.response) return `${ax.response.status} ${JSON.stringify(ax.response.data)}`;
  return String(err);
}
