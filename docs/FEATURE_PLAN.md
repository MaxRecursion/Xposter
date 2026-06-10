# Xposter — Feature Roadmap

Written 2026-06-10, after a full-codebase audit. Items are grouped by priority;
each one names the existing code it builds on so the work is concrete.

> **Completed 2026-06-10:** All P0, P1, P2, and housekeeping items have been
> implemented. This document is retained as the delivery record.

## P0 — Finish half-built features (high value, low effort)

### 1. Reply engagement tracking
`updateInteractionMetrics()` in `src/storage/interactions.ts` computes a
success score (likes/replies/retweets/author-engaged) but **has no caller** —
only original posts get impression syncing today. Add a scheduled job
(mirror `runImpressionSync` in `src/scheduler/original_posts.ts`) that walks
recent `interactions` rows with an `our_tweet_url`, scrapes engagement via
`scrapeEngagement()` (`src/browser/impressions.ts`), and calls
`updateInteractionMetrics`. Payoff is large: `success_score` currently feeds
the neural memory (`src/context/neural_memory.ts`) as always-zero, so the
"learning" loop for replies is effectively disabled.

### 2. Wire up auto-follow-back
The 5-minute processor (`src/scheduler/follow_back_processor.ts`) and
`autoApproveFollowBack()` (`src/storage/follower_events.ts`) exist, but
nothing ever creates events with `auto_follow=true` in `detail` — the
processor can never fire. Add a setting (e.g.
`auto_follow_back_classifications = REGULAR,SERIOUS` + a min-confidence
threshold) so `runFollowerSync` schedules an auto follow at a randomized
delay for safe classifications, and only asks via ntfy for the ambiguous
ones.

### 3. Unfollow detection
`follower_events.event_type` already allows `UNFOLLOWED`, but the sync never
emits it. In `runFollowerSync`, diff `listFollowerHandles()` (accounts with
`following_us = 1`) against the freshly scraped list; for handles that
disappeared, set `following_us = 0` and enqueue an `UNFOLLOWED` event +
optional ntfy ping. Note: the scrape caps at ~200 followers, so only flag
unfollows when the scraped list is complete (scrape count < cap).

### 4. Approval-mode toggle (restore human-in-the-loop)
The reply pipeline now auto-posts (`processCandidate` in
`src/pipeline/reply_pipeline.ts` goes straight from GENERATING → POSTING),
yet the whole approval machinery still exists: `PENDING_APPROVAL` status,
`sendApprovalNotification()`, approve/skip endpoints + signed action tokens,
`expireOldPending()`. Add a `require_approval` setting; when true, the
pipeline stops at PENDING_APPROVAL and sends the approval notification
instead of posting. This also makes the README's "human-in-the-loop" claim
true again.

## P1 — Robustness and quality

### 5. Session-health watchdog
When X cookies expire, every scrape just degrades into timeouts. Add a small
periodic check using `isLoggedIn()` (`src/browser/session.ts`); on transition
to logged-out, send a high-priority ntfy alert and pause schedulers
(`system_running = false`) so the bot doesn't burn runs while logged out.

### 6. Duplicate-reply guard
`isDuplicate()` (Jaccard similarity, `src/pipeline/filter.ts`) is exported
and tested but unused in the pipeline. Before posting, compare the generated
reply against the last N `interactions.our_reply_text` rows and regenerate
(or skip) on >0.8 similarity. Same guard for original posts vs recent
`original_posts.content` — engagement-farm prompts especially tend to
converge on repeated phrasings.

### 7. Retry queue for transient posting failures
Posts marked `ERROR` are dead ends today. Distinguish transient failures
(timeout, compose box not found) from permanent ones (tweet deleted), and
retry transient ones once on the next scheduled run with a capped attempt
count stored in `score_breakdown`-style JSON or a new column.

### 8. Smarter candidate scoring
`scorePost()` is keyword-weight based. Two cheap upgrades, both using
infrastructure that already exists:
- Embedding similarity between the tweet and the context store
  (`semanticSearch` in `src/context/store/store.ts`) as a "topical heat"
  signal — tweets close to current local reporting score higher.
- Per-account history boost: accounts whose past replies earned engagement
  (`accounts.avg_reply_score`, `successful_replies` — currently always 0,
  unblocked by P0-1) get a bonus; accounts that never engage get demoted.

## P2 — New capabilities

### 9. Thread support for original posts
`generateOriginalPost()` hard-caps at 280 chars and compaction sometimes
fights the model. Allow 2–3 tweet threads: generate, split on sentence
boundaries, post sequentially with reply-chaining in
`src/browser/compose.ts` (the CreateTweet capture already returns the new
tweet id needed to chain).

### 10. Quote-tweet mode
A third content type next to ORIGINAL / ENGAGEMENT_FARM: pick a
high-velocity ingested post (trends infra in `src/context/trends.ts`) and
quote-tweet it with a take. Reuses the scorer, generator, and compose flow.

### 11. Analytics dashboard page
Data already collected but not visualized: follower growth
(`follower_events` over time), reply success by classification
(`interactions` × `accounts`), topic performance trend
(`post_impressions` time series rather than the current latest-only view),
best-performing posting hours (join `posted_at` with engagement).

### 12. Weekly digest notification
A Sunday ntfy summary: replies posted, approval rate, top reply by
engagement, follower delta, best topic. All queries exist or are trivial
aggregates; reuse the shared `postToNtfy` helper in
`src/notifications/ntfy.ts`.

## Housekeeping
- `node-cron` is in `package.json` but never imported — remove it.
- `@types/express` is v5 while `express` is v4 — pin types to `^4`.
- `dist/` is checked into the repo — add to `.gitignore` and remove.
- Backups land in `Backups/` untracked — either gitignore or move out of the
  repo; `.xposter_backup_run.sh` should live in `scripts/` and be committed.
- The deprecated `RUST_MIGRATION_PLAN.md` (37 KB) predates the current
  architecture; archive or delete to keep the repo navigable.
