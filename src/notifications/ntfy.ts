import axios, { AxiosError } from 'axios';
import { Post } from '../storage/queries.js';
import { Account } from '../storage/accounts.js';
import { getCallbackBase } from '../utils/network.js';
import { logger } from '../utils/logger.js';
import { createActionToken } from '../api/auth.js';

export interface NtfyResult {
  ok: boolean;
  status?: number;
  error?: string;
  topic?: string;
  callback?: string;
  hint?: string;
}

// ── Shared transport ─────────────────────────────────────────────────────────

interface NtfyConfig {
  topic: string;
  server: string;
  apiKey: string;
}

const PLACEHOLDER_TOPIC = 'xposter-your-secret-topic';

function getNtfyConfig(): NtfyConfig | null {
  const topic = process.env.NTFY_TOPIC;
  if (!topic || topic === PLACEHOLDER_TOPIC) return null;
  return {
    topic,
    server: (process.env.NTFY_SERVER ?? 'https://ntfy.sh').replace(/\/$/, ''),
    apiKey: process.env.API_KEY ?? '',
  };
}

async function postToNtfy(
  cfg: NtfyConfig,
  payload: Record<string, unknown>,
  logContext: Record<string, unknown> = {},
): Promise<NtfyResult> {
  const base = getCallbackBase();
  try {
    const res = await axios.post(cfg.server, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10_000,
      validateStatus: () => true,
    });

    if (res.status >= 200 && res.status < 300) {
      logger.info('ntfy notification sent', { ...logContext, topic: cfg.topic, status: res.status });
      return { ok: true, status: res.status, topic: cfg.topic, callback: base };
    }

    const errMsg = `ntfy returned HTTP ${res.status}: ${JSON.stringify(res.data)}`;
    logger.error(errMsg, { ...logContext, topic: cfg.topic });
    return { ok: false, status: res.status, error: errMsg, topic: cfg.topic, callback: base };
  } catch (err) {
    const errMsg = `ntfy request failed: ${(err as AxiosError).message}`;
    logger.error(errMsg, { ...logContext, topic: cfg.topic });
    return { ok: false, error: errMsg, topic: cfg.topic, callback: base };
  }
}

function notConfiguredResult(): NtfyResult {
  const msg = 'NTFY_TOPIC not configured (still placeholder) — skipping push';
  logger.warn(msg);
  return { ok: false, error: msg };
}

// ── Approval request ─────────────────────────────────────────────────────────

/** Sends an approval-request notification with Approve/Skip action buttons. */
export async function sendApprovalNotification(post: Post): Promise<NtfyResult> {
  const cfg = getNtfyConfig();
  if (!cfg) return notConfiguredResult();

  const base = getCallbackBase();
  const ageMin = Math.round((Date.now() / 1000 - post.timestamp) / 60);
  const lang = languageLabel(post.language);
  const actionMode = (process.env.NTFY_ACTION_MODE ?? 'view').toLowerCase();
  const approveUrl = actionMode === 'http'
    ? `${base}/api/actions/approve/${post.id}`
    : withActionToken(`${base}/api/actions/approve/${post.id}`, createActionToken('approve', post.id));
  const skipUrl = actionMode === 'http'
    ? `${base}/api/actions/skip/${post.id}`
    : withActionToken(`${base}/api/actions/skip/${post.id}`, createActionToken('skip', post.id));

  const message = [
    `@${post.author_handle} (${ageMin}m ago) [${lang}]`,
    '',
    'TWEET:',
    truncate(post.text, 220),
    '',
    'REPLY:',
    truncate(post.final_reply ?? post.generated_reply ?? '(none)', 220),
    '',
    `Score: ${post.score ?? '?'}/100`,
  ].join('\n');

  const actions = actionMode === 'http'
    ? [
      {
        action: 'http',
        label: 'Approve',
        url: approveUrl,
        method: 'POST',
        headers: cfg.apiKey ? { 'X-API-Key': cfg.apiKey } : {},
        clear: true,
      },
      {
        action: 'http',
        label: 'Skip',
        url: skipUrl,
        method: 'POST',
        headers: cfg.apiKey ? { 'X-API-Key': cfg.apiKey } : {},
        clear: true,
      },
    ]
    : [
      { action: 'view', label: 'Approve', url: approveUrl, clear: true },
      { action: 'view', label: 'Skip', url: skipUrl, clear: true },
      { action: 'view', label: 'Open App', url: base },
    ];

  return postToNtfy(cfg, {
    topic: cfg.topic,
    title: 'Xposter: Reply Candidate',
    message,
    priority: 4,
    tags: ['speech_balloon', 'white_check_mark'],
    actions,
    click: base,
  }, { postId: post.id });
}

// ── Reply-posted notification (auto-post flow) ───────────────────────────────

/**
 * Sent after we auto-post a reply to X. The notification carries the original
 * tweet, our reply, the live link, and a one-tap "Delete Reply" HTTP action
 * that calls our local DELETE /api/replies/by-post/:id endpoint.
 */
export async function sendReplyPostedNotification(
  post: Post,
  replyText: string,
  replyTweetId: string | null,
  classification: string | null,
): Promise<NtfyResult> {
  const cfg = getNtfyConfig();
  if (!cfg) return notConfiguredResult();

  const base = getCallbackBase();
  const ageMin = Math.round((Date.now() / 1000 - post.timestamp) / 60);
  const lang = languageLabel(post.language);
  const replyAppLink = replyTweetId ? toXAppStatusUrl(replyTweetId) : null;
  const replyLink = replyTweetId
    ? `https://x.com/i/web/status/${replyTweetId}`
    : null;
  const cls = classification ?? 'UNKNOWN';

  const message = [
    `Replied to @${post.author_handle} (${ageMin}m ago) [${lang}]`,
    `Score ${post.score ?? '?'}/100 · ${cls}`,
    '',
    'TWEET:',
    truncate(post.text, 200),
    '',
    'OUR REPLY:',
    truncate(replyText, 200),
    '',
    replyLink ? `Live: ${replyLink}` : '(reply id not captured)',
  ].join('\n');

  const actions: Array<Record<string, unknown>> = [];
  if (replyTweetId) {
    actions.push({
      action: 'http',
      label: '🗑 Delete Reply',
      url: `${base}/api/replies/by-post/${post.id}`,
      method: 'DELETE',
      headers: cfg.apiKey ? { 'X-API-Key': cfg.apiKey } : {},
      clear: true,
    });
  }
  if (replyLink) {
    actions.push({ action: 'view', label: 'Open on X', url: replyAppLink ?? replyLink });
  }
  actions.push({ action: 'view', label: 'Open dashboard', url: base });

  return postToNtfy(cfg, {
    topic: cfg.topic,
    title: '✅ Reply Posted',
    message,
    priority: 3,
    tags: ['white_check_mark'],
    actions,
    click: replyAppLink ?? replyLink ?? base,
  }, { postId: post.id });
}

// ── Test notification ────────────────────────────────────────────────────────

/** Send a simple test notification — no actions, just verify connectivity. */
export async function sendTestNotification(): Promise<NtfyResult> {
  const cfg = getNtfyConfig();
  if (!cfg) {
    return { ok: false, error: 'NTFY_TOPIC is not set or still has placeholder value' };
  }

  const result = await postToNtfy(cfg, {
    topic: cfg.topic,
    title: 'Xposter Test',
    message: `Test notification at ${new Date().toLocaleTimeString()} — if you see this on your iPhone, ntfy is working correctly.`,
    priority: 3,
    tags: ['test_tube'],
  });

  if (result.ok) {
    result.hint = 'If this does not appear on your iPhone, check that the ntfy app is subscribed to exactly this topic and notifications are allowed.';
  }
  return result;
}

// ── Follower-back notification ───────────────────────────────────────────────

/** Sends a notification asking the user to approve/skip following a new follower back. */
export async function sendFollowerNotification(
  eventId: number,
  handle: string,
  account: Account | null,
): Promise<NtfyResult> {
  const cfg = getNtfyConfig();
  if (!cfg) return { ok: false, error: 'NTFY_TOPIC not configured' };

  const base = getCallbackBase();
  const followUrl = `${base}/api/follow/approve/${eventId}`;
  const skipUrl = `${base}/api/follow/skip/${eventId}`;

  const cls = account?.classification ?? 'UNKNOWN';
  const followers = account?.follower_count_seen ?? 0;
  const isMar = account?.is_marathi_creator ? ' · Marathi creator' : '';

  const bioLine = account?.bio ? `Bio: ${truncate(account.bio, 200)}` : '';
  const message = [
    `@${handle} just followed you.`,
    '',
    `Class: ${cls}${isMar}`,
    `Followers: ${followers.toLocaleString()}`,
    bioLine,
  ].filter(Boolean).join('\n');

  return postToNtfy(cfg, {
    topic: cfg.topic,
    title: 'Xposter: New Follower',
    message,
    priority: 3,
    tags: ['handshake'],
    actions: [
      { action: 'view', label: 'Follow back', url: followUrl, clear: true },
      { action: 'view', label: 'Skip',        url: skipUrl,   clear: true },
      { action: 'view', label: 'Open profile', url: toXAppProfileUrl(handle) },
    ],
  }, { eventId, handle });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}

function languageLabel(language: string): string {
  switch (language) {
    case 'marathi':       return 'Marathi';
    case 'marathi-roman': return 'Marathi (Roman)';
    case 'hindi':         return 'Hindi';
    case 'english':       return 'English';
    default:              return language || 'unknown';
  }
}

function withActionToken(url: string, token: string): string {
  if (!token) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}token=${encodeURIComponent(token)}`;
}

export function toXAppStatusUrl(tweetId: string): string {
  return `twitter://status?status_id=${encodeURIComponent(tweetId)}`;
}

export function toXAppProfileUrl(handle: string): string {
  return `twitter://user?screen_name=${encodeURIComponent(handle.replace(/^@/, ''))}`;
}
