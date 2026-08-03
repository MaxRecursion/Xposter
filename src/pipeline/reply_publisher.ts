import { postReply } from '../browser/posting.js';
import { sendReplyPostedNotification } from '../notifications/ntfy.js';
import { recordInteraction } from '../storage/interactions.js';
import {
  getPost, incrementPostingAttempt, logEvent, markPostAsPosted,
  markPostPostingError, MAX_POSTING_ATTEMPTS, Post, schedulePostRetry,
} from '../storage/queries.js';
import { logger } from '../utils/logger.js';
import { classifyPostingError } from '../browser/errors.js';

export type PublishReplyOutcome = 'posted' | 'retry_scheduled' | 'error';

export async function publishReply(
  post: Post,
  replyText: string,
  classification: string | null,
  options: { attemptAlreadyCounted?: boolean; contentStructure?: string } = {},
): Promise<PublishReplyOutcome> {
  const attempts = options.attemptAlreadyCounted
    ? (getPost(post.id)?.posting_attempts ?? post.posting_attempts)
    : incrementPostingAttempt(post.id);

  let replyTweetId: string | null;
  try {
    ({ replyTweetId } = await postReply(post.tweet_url, replyText));
  } catch (err) {
    const failure = classifyPostingError(err);
    const detail = `${failure.code}: ${failure.message}`;
    if (failure.transient && attempts < MAX_POSTING_ATTEMPTS) {
      schedulePostRetry(post.id, detail);
      logEvent('POST_RETRY_SCHEDULED', `attempt=${attempts}; ${detail}`, post.id);
      logger.warn('Transient reply posting failure scheduled for retry', {
        postId: post.id,
        attempt: attempts,
        code: failure.code,
      });
      return 'retry_scheduled';
    }

    markPostPostingError(post.id, detail);
    logEvent('POST_ERROR', `attempt=${attempts}; ${detail}`, post.id);
    logger.error('Reply posting failed permanently', {
      postId: post.id,
      attempt: attempts,
      code: failure.code,
    });
    return 'error';
  }

  markPostAsPosted(post.id, replyTweetId);
  recordInteraction(post.id, post.author_handle, replyText, {
    tweetId: replyTweetId ?? undefined,
    tweetUrl: replyTweetId ? `https://x.com/i/web/status/${replyTweetId}` : undefined,
    contentStructure: options.contentStructure,
  });
  logEvent('POSTED', `reply_id=${replyTweetId ?? 'unknown'} attempt=${attempts}`, post.id);

  const notification = await sendReplyPostedNotification(
    post,
    replyText,
    replyTweetId,
    classification,
  );
  logEvent(
    notification.ok ? 'NOTIFICATION_SENT' : 'NOTIFICATION_FAILED',
    notification.ok ? `topic=${notification.topic}` : (notification.error ?? 'unknown error'),
    post.id,
  );
  return 'posted';
}
