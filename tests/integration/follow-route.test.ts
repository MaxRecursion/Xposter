import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';

async function startServer(app: { listen: Function }): Promise<Server> {
  return await new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function stopServer(server: Server | null): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

describe('POST /api/follow/sync', () => {
  let server: Server | null = null;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.API_KEY = 'test-api-key';
  });

  afterEach(async () => {
    await stopServer(server);
    server = null;
    vi.doUnmock('../../src/scheduler/follower_sync.js');
    delete process.env.API_KEY;
  });

  it('returns the completed sync result to the dashboard', async () => {
    vi.doMock('../../src/scheduler/follower_sync.js', () => ({
      runFollowerSync: vi.fn().mockResolvedValue({
        ok: true,
        handle: 'my_handle',
        total: 12,
        newFollowers: 2,
        notFollowedBack: 2,
        queued: 2,
      }),
    }));

    const { createServer } = await import('../../src/api/server.js');
    server = await startServer(createServer());
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not expose a numeric port');

    const res = await fetch(`http://127.0.0.1:${address.port}/api/follow/sync`, {
      method: 'POST',
      headers: { 'X-API-Key': 'test-api-key' },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      handle: 'my_handle',
      total: 12,
      newFollowers: 2,
      notFollowedBack: 2,
      queued: 2,
      message: 'Follower sync complete: 12 followers scanned, 2 not followed back, 2 pending.',
    });
  });

  it('returns a visible error when sync cannot run', async () => {
    vi.doMock('../../src/scheduler/follower_sync.js', () => ({
      runFollowerSync: vi.fn().mockResolvedValue({
        ok: false,
        reason: 'missing_handle',
        message: 'Could not determine your X handle.',
        total: 0,
        newFollowers: 0,
        queued: 0,
      }),
    }));

    const { createServer } = await import('../../src/api/server.js');
    server = await startServer(createServer());
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not expose a numeric port');

    const res = await fetch(`http://127.0.0.1:${address.port}/api/follow/sync`, {
      method: 'POST',
      headers: { 'X-API-Key': 'test-api-key' },
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      ok: false,
      reason: 'missing_handle',
      error: 'Could not determine your X handle.',
    });
  });
});
