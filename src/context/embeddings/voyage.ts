import axios, { AxiosError } from 'axios';
import { logger } from '../../utils/logger.js';
import type { EmbeddingClient, EmbeddingKind } from './client.js';

const ENDPOINT = 'https://api.voyageai.com/v1/embeddings';
const BATCH_SIZE = 64;
const TIMEOUT_MS = 30_000;
const MAX_RETRIES = 4;

interface VoyageResponse {
  data: Array<{ embedding: number[]; index: number }>;
  usage?: { total_tokens?: number };
}

/**
 * Voyage embeddings client with a global request-rate limiter.
 *
 * The free tier without a payment method on file is capped at 3 RPM. We
 * default to 22s between requests (≈2.7 RPM) to stay safely under that.
 * Override via VOYAGE_RPM=N (we then space requests by 60/N seconds).
 */
export class VoyageEmbeddings implements EmbeddingClient {
  readonly dim: number;
  readonly modelId = 'voyage-3-lite';

  private readonly minIntervalMs: number;
  private nextSlot = 0;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly apiKey: string, dim = 512) {
    this.dim = dim;
    const rpm = parseFloat(process.env.VOYAGE_RPM ?? '');
    const safeRpm = Number.isFinite(rpm) && rpm > 0 ? rpm : 2.7;
    this.minIntervalMs = Math.ceil(60_000 / safeRpm);
  }

  /** Time in ms until the next slot is available, for /api/context/health. */
  msUntilNextSlot(): number {
    return Math.max(0, this.nextSlot - Date.now());
  }

  async embed(inputs: string[], opts: { kind?: EmbeddingKind } = {}): Promise<Float32Array[]> {
    if (inputs.length === 0) return [];

    const out: Float32Array[] = new Array(inputs.length);
    for (let i = 0; i < inputs.length; i += BATCH_SIZE) {
      const slice = inputs.slice(i, i + BATCH_SIZE);
      const vectors = await this.scheduleBatch(slice, opts.kind ?? 'document');
      for (let j = 0; j < vectors.length; j++) out[i + j] = vectors[j];
    }
    return out;
  }

  /**
   * Serializes batches and enforces minIntervalMs between requests, regardless
   * of how many concurrent callers (ingest sources, retrieval queries) are in
   * flight. Returns a promise that resolves with the batch's vectors.
   */
  private scheduleBatch(batch: string[], kind: EmbeddingKind): Promise<Float32Array[]> {
    const next = this.chain.then(async () => {
      const wait = Math.max(0, this.nextSlot - Date.now());
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.nextSlot = Date.now() + this.minIntervalMs;
      return this.embedBatch(batch, kind);
    });
    this.chain = next.catch(() => undefined);
    return next;
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
        // On 429, stretch the slot generously so the next batch waits longer.
        const backoff = status === 429
          ? Math.min(60_000, this.minIntervalMs * 2 + 500 * 2 ** (attempt - 1))
          : Math.min(8_000, 500 * 2 ** (attempt - 1));
        const jittered = backoff + Math.floor(Math.random() * 250);
        if (status === 429) this.nextSlot = Math.max(this.nextSlot, Date.now() + jittered);
        logger.warn('Voyage embed retrying', { attempt, status, backoff: jittered });
        await new Promise((r) => setTimeout(r, jittered));
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
