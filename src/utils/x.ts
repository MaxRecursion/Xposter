const TWEET_URL_RE = /^https:\/\/(?:x|twitter)\.com\/[^/?#]+\/status\/(\d+)(?:[/?#].*)?$/;

export function extractTweetIdFromUrl(tweetUrl: string): string | null {
  const match = tweetUrl.match(TWEET_URL_RE);
  return match?.[1] ?? null;
}

export function isValidTweetReference(tweetId: string, tweetUrl: string): boolean {
  const idFromUrl = extractTweetIdFromUrl(tweetUrl);
  return /^\d+$/.test(tweetId) && idFromUrl === tweetId;
}
