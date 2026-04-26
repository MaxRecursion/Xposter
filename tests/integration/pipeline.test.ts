/**
 * Integration test: simulates the full pipeline from raw tweet ingestion
 * through filtering, scoring, LLM generation (mocked), and approval.
 * No real browser or network calls are made.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';

// ── Test DB setup ─────────────────────────────────────────────────────────────
// We set DB_PATH_OVERRIDE *before* any imports so the singleton picks it up.
// Vitest runs each test file in its own worker, so module state is isolated.

const TEST_DB_RELATIVE = 'data/test-pipeline.db';
const TEST_DB_PATH = path.resolve(process.cwd(), TEST_DB_RELATIVE);

// Set env var before any module is imported (top of file, before vi.mock calls)
fs.rmSync(TEST_DB_PATH, { force: true });
fs.mkdirSync(path.dirname(TEST_DB_PATH), { recursive: true });
process.env.DB_PATH_OVERRIDE = TEST_DB_RELATIVE;

afterAll(() => {
  fs.rmSync(TEST_DB_PATH, { force: true });
  delete process.env.DB_PATH_OVERRIDE;
});

// ── Mock LLM ──────────────────────────────────────────────────────────────────

vi.mock('groq-sdk', () => ({
  default: vi.fn().mockImplementation(function GroqMock() {
    return {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: 'Try Baner road — usually lighter at this time.' } }],
          }),
        },
      },
    };
  }),
}));

// ── Sample tweets ─────────────────────────────────────────────────────────────

const SAMPLE_TWEETS = [
  {
    tweet_id: '1723456789012345001',
    author_handle: 'pune_local',
    author_name: 'Pune Local',
    text: 'Massive traffic jam near Hinjewadi IT park Pune — any alternate routes?',
    timestamp: Math.floor(Date.now() / 1000) - 300,
    likes: 8, replies: 3, retweets: 1,
    tweet_url: 'https://x.com/pune_local/status/1723456789012345001',
  },
  {
    tweet_id: '1723456789012345002',
    author_handle: 'rain_watcher',
    author_name: 'Rain Watcher',
    text: 'पुण्यात आज रात्री पाऊस खूप होता, रस्त्यावर पाणी तुंबलं आहे',
    timestamp: Math.floor(Date.now() / 1000) - 900,
    likes: 15, replies: 5, retweets: 3,
    tweet_url: 'https://x.com/rain_watcher/status/1723456789012345002',
  },
  {
    tweet_id: '1723456789012345003',
    author_handle: 'random_user',
    author_name: 'Random User',
    text: 'Just watched an amazing movie last night! Highly recommend.',
    timestamp: Math.floor(Date.now() / 1000) - 1800,
    likes: 22, replies: 4, retweets: 7,
    tweet_url: 'https://x.com/random_user/status/1723456789012345003',
  },
];

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Pipeline integration', () => {
  it('upserts tweets without duplicates', async () => {
    const { upsertPost } = await import('../../src/storage/queries.js');

    const p1 = upsertPost(SAMPLE_TWEETS[0]);
    const p2 = upsertPost(SAMPLE_TWEETS[0]); // duplicate

    expect(p1).not.toBeNull();
    expect(p2).toBeNull(); // second insert returns null

    const invalid = upsertPost({
      ...SAMPLE_TWEETS[0],
      tweet_id: 'integ-should-not-insert',
      tweet_url: 'https://x.com/pune_local/status/integ-should-not-insert',
    });
    expect(invalid).toBeNull();
  });

  it('filter passes on-topic tweets and rejects off-topic', async () => {
    const { filterPost } = await import('../../src/pipeline/filter.js');

    const r1 = filterPost(SAMPLE_TWEETS[0].text); // traffic + pune
    const r2 = filterPost(SAMPLE_TWEETS[1].text); // Marathi + pune + rain
    const r3 = filterPost(SAMPLE_TWEETS[2].text); // off-topic

    expect(r1.pass).toBe(true);
    expect(r1.language).toBe('english');

    expect(r2.pass).toBe(true);
    expect(r2.language).toBe('marathi');

    expect(r3.pass).toBe(false);
  });

  it('scorer returns valid score for relevant post', async () => {
    const { upsertPost, updatePostLanguage } = await import('../../src/storage/queries.js');
    const { scorePost } = await import('../../src/pipeline/scorer.js');

    const post = upsertPost(SAMPLE_TWEETS[1]);
    if (!post) throw new Error('post should be new');

    updatePostLanguage(post.id, 'marathi');

    const { score, breakdown } = scorePost({ ...post, language: 'marathi' });

    expect(score).toBeGreaterThan(30);
    expect(breakdown.recency).toBeGreaterThan(0);
    expect(breakdown.topicRelevance).toBeGreaterThan(0);
  });

  it('generates a reply via mocked LLM', async () => {
    process.env.GROQ_API_KEY = 'mock-key';

    const { upsertPost, updatePostStatus } = await import('../../src/storage/queries.js');
    const { generateReply } = await import('../../src/pipeline/generator.js');

    // Use tweet 0 which was already upserted
    const { getPostByTweetId } = await import('../../src/storage/queries.js');
    const post = getPostByTweetId('1723456789012345001');
    if (!post) throw new Error('post not found in DB');

    const reply = await generateReply(post);
    expect(typeof reply).toBe('string');
    expect(reply.length).toBeGreaterThan(0);
  });

  it('full pipeline: upsert → filter → score → status update', async () => {
    const {
      upsertPost, updatePostLanguage, updatePostScore,
      updateGeneratedReply, updatePostStatus, getPost,
    } = await import('../../src/storage/queries.js');
    const { filterPost } = await import('../../src/pipeline/filter.js');
    const { scorePost } = await import('../../src/pipeline/scorer.js');
    const { generateReply } = await import('../../src/pipeline/generator.js');

    process.env.GROQ_API_KEY = 'mock-key';

    const tweet = {
      tweet_id: '1723456789012345999',
      author_handle: 'fulltest',
      author_name: 'Full Test',
      text: 'Waterlogging on FC Road Pune near Deccan — someone please fix these potholes!',
      timestamp: Math.floor(Date.now() / 1000) - 200,
      likes: 7, replies: 2, retweets: 0,
      tweet_url: 'https://x.com/fulltest/status/1723456789012345999',
    };

    const post = upsertPost(tweet);
    expect(post).not.toBeNull();

    const filterResult = filterPost(tweet.text);
    expect(filterResult.pass).toBe(true);
    updatePostLanguage(post!.id, filterResult.language);

    const freshPost = getPost(post!.id)!;
    const scored = scorePost(freshPost);
    expect(scored.score).toBeGreaterThan(40);
    updatePostScore(post!.id, scored.score, scored.breakdown as any);

    updatePostStatus(post!.id, 'GENERATING');
    const reply = await generateReply(getPost(post!.id)!);
    updateGeneratedReply(post!.id, reply);

    const final = getPost(post!.id)!;
    expect(final.status).toBe('PENDING_APPROVAL');
    expect(final.generated_reply).toBeTruthy();
    expect(final.final_reply).toBeTruthy();
    expect(final.score).toBeGreaterThan(40);
  });
});
