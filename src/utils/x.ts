// Matches all known X/Twitter URL shapes:
//   https://x.com/<handle>/status/<id>
//   https://twitter.com/<handle>/status/<id>
//   https://x.com/i/web/status/<id>   ← returned by X when handle isn't known
const TWEET_URL_RE =
  /^https:\/\/(?:x|twitter)\.com\/(?:[^/?#]+\/status|i\/web\/status)\/(\d+)(?:[/?#].*)?$/;

export function extractTweetIdFromUrl(tweetUrl: string): string | null {
  const match = tweetUrl.match(TWEET_URL_RE);
  return match?.[1] ?? null;
}

export function isValidTweetReference(tweetId: string, tweetUrl: string): boolean {
  const idFromUrl = extractTweetIdFromUrl(tweetUrl);
  return /^\d+$/.test(tweetId) && idFromUrl === tweetId;
}
