import { Router, Request, Response } from 'express';
import { getPost, getPostByPostedTweetId, markReplyDeleted, logEvent } from '../../storage/queries.js';
import { deleteReply } from '../../browser/posting.js';
import { runReplyMetricsSync } from '../../scheduler/reply_metrics_sync.js';
import { logger } from '../../utils/logger.js';
import { requireApiKey } from '../auth.js';

export const repliesRouter = Router();

// Manually trigger an engagement sync for recently posted replies
repliesRouter.post('/sync-metrics', requireApiKey, async (_req: Request, res: Response) => {
  const result = await runReplyMetricsSync('manual');
  res.json({ ok: true, ...result });
});

async function deletePostedReply(postId: string, res: Response): Promise<void> {
  const post = getPost(postId);
  if (!post) {
    res.status(404).json({ error: 'post not found' });
    return;
  }
  if (!post.posted_tweet_id || !/^\d+$/.test(post.posted_tweet_id)) {
    res.status(409).json({ error: 'post does not have a deletable reply tweet id' });
    return;
  }
  if (post.deleted_at) {
    res.status(409).json({ error: 'already deleted', deleted_at: post.deleted_at });
    return;
  }

  const replyTweetId = post.posted_tweet_id;
  logger.info('Delete reply requested', { postId: post.id, replyTweetId, originalTweetId: post.tweet_id });
  logEvent('DELETE_REQUESTED', `reply_tweet=${replyTweetId}`, post.id);

  try {
    await deleteReply(replyTweetId);
    markReplyDeleted(post.id);
    logEvent('DELETED', `reply_tweet=${replyTweetId}`, post.id);
    res.json({ ok: true, postId: post.id, tweetId: replyTweetId });
  } catch (err) {
    logger.error('Delete reply failed', { postId: post.id, replyTweetId, err });
    logEvent('DELETE_ERROR', String(err), post.id);
    res.status(500).json({ error: String(err) });
  }
}

/**
 * DELETE /api/replies/by-post/:id
 *
 * Preferred deletion path. The client sends our internal post id, and the
 * server resolves the stored reply tweet id before deleting on X.
 */
repliesRouter.delete('/by-post/:id', requireApiKey, async (req: Request, res: Response) => {
  await deletePostedReply(String(req.params['id'] ?? '').trim(), res);
});

/**
 * DELETE /api/replies/:tweetId
 *
 * Triggered from the ntfy notification's Delete action button. Looks up the
 * post by the posted-reply tweet id, deletes the reply on X via Playwright,
 * and marks the row as deleted in the DB.
 */
repliesRouter.delete('/:tweetId', requireApiKey, async (req: Request, res: Response) => {
  const tweetId = String(req.params['tweetId'] ?? '').trim();
  if (!/^\d+$/.test(tweetId)) {
    return res.status(400).json({ error: 'invalid tweet id' });
  }

  const post = getPostByPostedTweetId(tweetId);
  if (!post) {
    return res.status(404).json({ error: 'no posted reply with that tweet id' });
  }
  await deletePostedReply(post.id, res);
});
