export type PostingErrorCode =
  | 'INVALID_TWEET_URL'
  | 'NAVIGATION_FAILED'
  | 'SOURCE_UNAVAILABLE'
  | 'TWEET_NOT_LOADED'
  | 'REPLY_CONTROL_NOT_FOUND'
  | 'COMPOSE_NOT_FOUND'
  | 'SUBMIT_NOT_FOUND'
  | 'X_REJECTED'
  | 'UNKNOWN';

export class PostingError extends Error {
  constructor(
    message: string,
    public readonly code: PostingErrorCode,
    public readonly transient: boolean,
  ) {
    super(message);
    this.name = 'PostingError';
  }
}

export function classifyPostingError(error: unknown): PostingError {
  if (error instanceof PostingError) return error;

  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();

  if (/invalid tweet url/.test(normalized)) {
    return new PostingError(message, 'INVALID_TWEET_URL', false);
  }
  if (/deleted|does not exist|post is unavailable|tweet is unavailable/.test(normalized)) {
    return new PostingError(message, 'SOURCE_UNAVAILABLE', false);
  }
  if (/compose (box|textarea).*not found/.test(normalized)) {
    return new PostingError(message, 'COMPOSE_NOT_FOUND', true);
  }
  if (/reply button.*not found/.test(normalized)) {
    return new PostingError(message, 'REPLY_CONTROL_NOT_FOUND', true);
  }
  if (/submit button.*not found/.test(normalized)) {
    return new PostingError(message, 'SUBMIT_NOT_FOUND', true);
  }
  if (/timeout|timed out|net::|navigation|target closed|browser.*closed/.test(normalized)) {
    return new PostingError(message, 'NAVIGATION_FAILED', true);
  }
  if (/tweet article not found/.test(normalized)) {
    return new PostingError(message, 'TWEET_NOT_LOADED', true);
  }

  return new PostingError(message, 'UNKNOWN', false);
}
