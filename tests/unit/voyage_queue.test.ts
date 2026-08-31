import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The scheduler inside VoyageEmbeddings decides whether a reply-scoring lookup
 * waits behind a cold-start ingest backfill. These tests drive it through the
 * public `embed` API with the HTTP layer stubbed, so dispatch order is
 * observable without touching the network.
 *
 * Ordering here is deterministic rather than timing-dependent: `embed` hands
 * the first batch to the transport and yields, so every later call is queued by
 * the time the first one resolves.
 */

const postMock = vi.fn();
vi.mock('axios', () => ({
  default: { post: (...args: unknown[]) => postMock(...args) },
}));

/** Near-zero pacing so the test exercises ordering, not the rate limit. */
async function loadClient() {
  process.env.VOYAGE_RPM = '60000';
  vi.resetModules();
  const { VoyageEmbeddings } = await import('../../src/context/embeddings/voyage.js');
  return new VoyageEmbeddings('test-key', 4);
}

function recordingTransport(): string[] {
  const seen: string[] = [];
  postMock.mockImplementation((_url: string, body: { input: string[]; input_type: string }) => {
    seen.push(`${body.input_type}:${body.input.join(',')}`);
    return Promise.resolve({
      data: { data: body.input.map((_v, index) => ({ embedding: [0, 0, 0, 0], index })) },
    });
  });
  return seen;
}

describe('Voyage embedding queue', () => {
  beforeEach(() => {
    postMock.mockReset();
  });

  afterEach(() => {
    delete process.env.VOYAGE_RPM;
  });

  it('serves a query ahead of ingest batches already queued', async () => {
    const client = await loadClient();
    const seen = recordingTransport();

    // doc-a takes the in-flight slot; the rest queue behind it.
    const work = [
      client.embed(['doc-a'], { kind: 'document' }),
      client.embed(['doc-b'], { kind: 'document' }),
      client.embed(['doc-c'], { kind: 'document' }),
      client.embed(['needle'], { kind: 'query' }),
    ];
    await Promise.all(work);

    // The query overtakes the queued backfill instead of waiting it out.
    expect(seen).toEqual([
      'document:doc-a',
      'query:needle',
      'document:doc-b',
      'document:doc-c',
    ]);
  });

  it('keeps queries in arrival order relative to each other', async () => {
    const client = await loadClient();
    const seen = recordingTransport();

    await Promise.all([
      client.embed(['doc-a'], { kind: 'document' }),
      client.embed(['q1'], { kind: 'query' }),
      client.embed(['q2'], { kind: 'query' }),
    ]);

    expect(seen).toEqual(['document:doc-a', 'query:q1', 'query:q2']);
  });

  it('reports queue depth by kind while work is pending, then drains', async () => {
    const client = await loadClient();
    recordingTransport();

    const work = [
      client.embed(['doc-a'], { kind: 'document' }),
      client.embed(['doc-b'], { kind: 'document' }),
      client.embed(['needle'], { kind: 'query' }),
    ];
    // doc-a is in flight; doc-b and the query are still queued.
    expect(client.queueDepth()).toEqual({ query: 1, document: 1 });

    await Promise.all(work);
    expect(client.queueDepth()).toEqual({ query: 0, document: 0 });
  });

  it('a failing batch rejects only its own caller and the queue keeps draining', async () => {
    const client = await loadClient();
    const seen: string[] = [];
    postMock.mockImplementation((_url: string, body: { input: string[] }) => {
      seen.push(body.input.join(','));
      if (body.input[0] === 'doc-a') {
        // 4xx is non-retryable, so this fails without burning the retry ladder.
        return Promise.reject(Object.assign(new Error('bad request'), {
          response: { status: 400, data: { detail: 'nope' } },
        }));
      }
      return Promise.resolve({
        data: { data: body.input.map((_v, index) => ({ embedding: [0, 0, 0, 0], index })) },
      });
    });

    const failing = client.embed(['doc-a'], { kind: 'document' });
    const healthy = client.embed(['doc-b'], { kind: 'document' });

    await expect(failing).rejects.toThrow(/Voyage embed failed/);
    await expect(healthy).resolves.toHaveLength(1);
    expect(seen).toEqual(['doc-a', 'doc-b']);
    expect(client.queueDepth()).toEqual({ query: 0, document: 0 });
  });
});
