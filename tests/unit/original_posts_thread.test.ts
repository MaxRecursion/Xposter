import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const TEST_DB_RELATIVE = 'data/test-original-thread.db';
const TEST_DB_PATH = path.resolve(process.cwd(), TEST_DB_RELATIVE);

function removeTestDb(): void {
  for (const suffix of ['', '-shm', '-wal']) {
    fs.rmSync(`${TEST_DB_PATH}${suffix}`, { force: true });
  }
}

describe('original post thread storage', () => {
  beforeEach(() => {
    vi.resetModules();
    removeTestDb();
    fs.mkdirSync(path.dirname(TEST_DB_PATH), { recursive: true });
    process.env.DB_PATH_OVERRIDE = TEST_DB_RELATIVE;
  });

  afterEach(() => {
    delete process.env.DB_PATH_OVERRIDE;
    removeTestDb();
  });

  it('stores thread parts and every chained tweet id', async () => {
    const storage = await import('../../src/storage/original_posts.js');
    const parts = [
      'Pune hiring is changing faster than job titles.',
      'The next advantage is judgment, not cheaper output. Who adapts first?',
    ];
    const post = storage.insertOriginalPost({
      content: parts.join(' '),
      threadParts: parts,
      language: 'english',
      topic: 'AI jobs in Pune',
    });

    storage.markOriginalPostPosted(
      post.id,
      ['1111111111111111', '2222222222222222'],
      [
        'https://x.com/i/web/status/1111111111111111',
        'https://x.com/i/web/status/2222222222222222',
      ],
    );

    const stored = storage.getOriginalPost(post.id)!;
    expect(JSON.parse(stored.thread_parts_json!)).toEqual(parts);
    expect(JSON.parse(stored.tweet_ids_json!)).toEqual([
      '1111111111111111',
      '2222222222222222',
    ]);
    expect(stored.tweet_id).toBe('1111111111111111');
  });

  it('stores quote-tweet source metadata', async () => {
    const storage = await import('../../src/storage/original_posts.js');
    const post = storage.insertOriginalPost({
      content: 'The local consequence matters more than the headline.',
      language: 'english',
      topic: 'quote:ai+jobs',
      postType: 'QUOTE_TWEET',
      quotedTweet: {
        id: '3333333333333333',
        url: 'https://x.com/source/status/3333333333333333',
        authorHandle: 'source',
      },
    });

    expect(storage.getOriginalPost(post.id)).toMatchObject({
      post_type: 'QUOTE_TWEET',
      quoted_tweet_id: '3333333333333333',
      quoted_tweet_url: 'https://x.com/source/status/3333333333333333',
      quoted_author_handle: 'source',
    });
  });
});
