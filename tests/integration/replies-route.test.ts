import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'path';
import fs from 'fs';
import type { Server } from 'node:http';

const TEST_DB_RELATIVE = 'data/test-replies-route.db';
const TEST_DB_PATH = path.resolve(process.cwd(), TEST_DB_RELATIVE);

function removeTestDb(): void {
  for (const suffix of ['', '-shm', '-wal']) {
    fs.rmSync(`${TEST_DB_PATH}${suffix}`, { force: true });
  }
}

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

describe('DELETE /api/replies/by-post/:id', () => {
  let server: Server | null = null;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    removeTestDb();
    fs.mkdirSync(path.dirname(TEST_DB_PATH), { recursive: true });
    process.env.DB_PATH_OVERRIDE = TEST_DB_RELATIVE;
    process.env.API_KEY = 'test-api-key';
  });

  afterEach(async () => {
    await stopServer(server);
    server = null;
    vi.doUnmock('../../src/browser/posting.js');
    delete process.env.DB_PATH_OVERRIDE;
    delete process.env.API_KEY;
    removeTestDb();
  });

  it('deletes the stored reply tweet id instead of the original source tweet id', async () => {
    const deleteReplyMock = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../../src/browser/posting.js', () => ({
      postReply: vi.fn(),
      deleteReply: deleteReplyMock,
    }));

    const [{ createServer }, queries] = await Promise.all([
      import('../../src/api/server.js'),
      import('../../src/storage/queries.js'),
    ]);

    const post = queries.upsertPost({
      tweet_id: '1723456789012347001',
      author_handle: 'movie_user',
      author_name: 'Movie User',
      text: 'Original tweet that we replied to.',
      timestamp: Math.floor(Date.now() / 1000) - 300,
      likes: 2,
      replies: 0,
      retweets: 0,
      tweet_url: 'https://x.com/movie_user/status/1723456789012347001',
    });
    expect(post).not.toBeNull();

    queries.markPostAsPosted(post!.id, '9999000011112222');

    const app = createServer();
    server = await startServer(app);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not expose a numeric port');

    const res = await fetch(`http://127.0.0.1:${address.port}/api/replies/by-post/${post!.id}`, {
      method: 'DELETE',
      headers: { 'X-API-Key': 'test-api-key' },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      postId: post!.id,
      tweetId: '9999000011112222',
    });

    expect(deleteReplyMock).toHaveBeenCalledTimes(1);
    expect(deleteReplyMock).toHaveBeenCalledWith('9999000011112222');
    expect(deleteReplyMock).not.toHaveBeenCalledWith('1723456789012347001');

    const deleted = queries.getPost(post!.id);
    expect(deleted?.status).toBe('DELETED');
    expect(deleted?.deleted_at).not.toBeNull();
  });
});
