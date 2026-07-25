/**
 * Dry-run: run an X search through the Playwright session and show what the
 * extractor, trend filter and trend scorer make of the results. Posts nothing.
 *
 *   npm run trends:search -- "artificial intelligence"
 */
import '../src/env.js';
import { getDb } from '../src/storage/db.js';
import { searchTweets } from '../src/browser/ingestion.js';
import { closeBrowser } from '../src/browser/session.js';
import { filterTrendPost } from '../src/pipeline/filter.js';
import { scoreTrendPost } from '../src/pipeline/scorer.js';
import { classifyTrendSafety } from '../src/trends/trend_filter.js';
import type { Post } from '../src/storage/queries.js';

const query = process.argv.slice(2).join(' ').trim();

if (!query) {
  process.stdout.write('usage: npm run trends:search -- "<query>"\n');
  process.exit(1);
}

/** Shapes a scraped tweet like a Post so the scorer can read it, without a DB write. */
function asPost(t: Awaited<ReturnType<typeof searchTweets>>[number]): Post {
  return {
    id: t.tweet_id, tweet_id: t.tweet_id,
    author_handle: t.author_handle, author_name: t.author_name,
    text: t.text, language: 'english', timestamp: t.timestamp,
    likes: t.likes, replies: t.replies, retweets: t.retweets,
    tweet_url: t.tweet_url, status: 'INGESTED',
    score: null, score_breakdown: null, generated_reply: null, final_reply: null,
    posted_tweet_id: null, source: 'TREND_GLOBAL', stance: null, trend_key: null,
    deleted_at: null, posting_attempts: 0, retry_after: null, last_error: null,
    ingested_at: t.timestamp, updated_at: t.timestamp,
  };
}

async function main(): Promise<void> {
  getDb();
  process.stdout.write(`Searching X for: ${query}\n\n`);

  const results = await searchTweets(query, { mode: 'Top', max: 25 });
  process.stdout.write(`Extracted ${results.length} tweets\n\n`);

  if (results.length === 0) {
    process.stdout.write('No results. Either the session is logged out or the search DOM changed.\n');
    return;
  }

  const rows = results.map((t) => {
    const post = asPost(t);
    const filtered = filterTrendPost(t.text);
    const scored = scoreTrendPost(post, { trendHeat: 8 });
    const safety = classifyTrendSafety(t.text);
    return { t, filtered, scored, safety };
  }).sort((a, b) => b.scored.score - a.scored.score);

  for (const { t, filtered, scored, safety } of rows) {
    const ageMin = Math.round((Date.now() / 1000 - t.timestamp) / 60);
    process.stdout.write(
      `[${scored.score.toFixed(1).padStart(5)}] @${t.author_handle} · ${ageMin}m old · `
      + `${t.likes}L/${t.replies}R/${t.retweets}RT\n`
      + `        ${filtered.pass ? 'PASS' : `SKIP (${filtered.reason})`} · safety=${safety.class}\n`
      + `        ${JSON.stringify(scored.breakdown)}\n`
      + `        ${t.text.replace(/\s+/g, ' ').slice(0, 150)}\n\n`,
    );
  }

  const usable = rows.filter((r) => r.filtered.pass && r.safety.class !== 'SKIP').length;
  process.stdout.write(`${usable}/${rows.length} usable as reply candidates\n`);
}

main()
  .catch((err) => {
    process.stdout.write(`search probe failed: ${String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeBrowser().catch(() => {});
    process.exit(process.exitCode ?? 0);
  });
