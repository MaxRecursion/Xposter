import axios, { AxiosError } from 'axios';
import { logger } from '../../utils/logger.js';
import { getVoyageRpm } from '../../config.js';
import type { EmbeddingClient, EmbeddingKind } from './client.js';
const ENDPOINT = 'https://api.voyageai.com/v1/embeddings';
const BATCH_SIZE = 64;
const TIMEOUT_MS = 30_000;
const MAX_RETRIES = 4;

interface VoyageResponse {
  data: Array<{ embedding: number[]; index: number }>;
  usage?: { total_tokens?: number };
}

interface QueuedBatch {
  batch: string[];
  kind: EmbeddingKind;
  resolve: (vectors: Float32Array[]) => void;
  reject: (err: unknown) => void;
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
  private queue: QueuedBatch[] = [];
  private draining = false;

  constructor(private readonly apiKey: string, dim = 512) {
    this.dim = dim;
    const safeRpm = getVoyageRpm();
    this.minIntervalMs = Math.ceil(60_000 / safeRpm);
  }

  /** Time in ms until the next slot is available, for /api/context/health. */
  msUntilNextSlot(): number {
    return Math.max(0, this.nextSlot - Date.now());
  }

  /** Batches waiting on a rate-limit slot, split by kind, for /api/context/health. */
  queueDepth(): { query: number; document: number } {
    return {
      query: this.queue.filter((entry) => entry.kind === 'query').length,
      document: this.queue.filter((entry) => entry.kind === 'document').length,
    };
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
   *
   * Queries are placed ahead of any queued ingest work. The rate limit is a
   * few requests per minute shared by both, and a cold-start backfill can hold
   * dozens of document batches — strict FIFO makes a reply-pipeline lookup wait
   * out the entire backlog, which is minutes of a scoring run blocked on a
   * signal that is only a scoring boost. Ingest is throughput work and can
   * wait; a query has a caller sitting on it.
   */
  private scheduleBatch(batch: string[], kind: EmbeddingKind): Promise<Float32Array[]> {
    return new Promise<Float32Array[]>((resolve, reject) => {
      const entry: QueuedBatch = { batch, kind, resolve, reject };
      if (kind === 'query') {
        // Insert before the first queued document batch, after any queries
        // already waiting, so queries stay FIFO relative to each other.
        const firstDoc = this.queue.findIndex((queued) => queued.kind === 'document');
        if (firstDoc === -1) this.queue.push(entry);
        else this.queue.splice(firstDoc, 0, entry);
      } else {
        this.queue.push(entry);
      }
      void this.drain();
    });
  }

  /** Single consumer: one in-flight request at a time, spaced by minIntervalMs. */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const entry = this.queue.shift()!;
        const wait = Math.max(0, this.nextSlot - Date.now());
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        this.nextSlot = Date.now() + this.minIntervalMs;
        try {
          entry.resolve(await this.embedBatch(entry.batch, entry.kind));
        } catch (err) {
          entry.reject(err);
        }
      }
    } finally {
      this.draining = false;
    }
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
