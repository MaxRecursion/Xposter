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

/** Sends an approval-request notification with Approve/Skip action buttons. */
export async function sendApprovalNotification(post: Post): Promise<NtfyResult> {
  const topic = process.env.NTFY_TOPIC;
  const server = (process.env.NTFY_SERVER ?? 'https://ntfy.sh').replace(/\/$/, '');
  const apiKey = process.env.API_KEY ?? '';

  if (!topic || topic === 'xposter-your-secret-topic') {
    const msg = 'NTFY_TOPIC not configured (still placeholder) — skipping push';
    logger.warn(msg);
    return { ok: false, error: msg };
  }

  const base = getCallbackBase();
  const ageMin = Math.round((Date.now() / 1000 - post.timestamp) / 60);
  const lang = post.language === 'marathi' ? 'Marathi' : 'English';
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
        headers: apiKey ? { 'X-API-Key': apiKey } : {},
        clear: true,
      },
      {
        action: 'http',
        label: 'Skip',
        url: skipUrl,
        method: 'POST',
        headers: apiKey ? { 'X-API-Key': apiKey } : {},
        clear: true,
      },
    ]
    : [
      {
        action: 'view',
        label: 'Approve',
        url: approveUrl,
        clear: true,
      },
      {
        action: 'view',
        label: 'Skip',
        url: skipUrl,
        clear: true,
      },
      {
        action: 'view',
        label: 'Open App',
        url: base,
      },
    ];

  const payload: Record<string, unknown> = {
    topic,
    title: 'Xposter: Reply Candidate',
    message,
    priority: 4,
    tags: ['speech_balloon', 'white_check_mark'],
    actions,
    click: base,
  };

  try {
    const res = await axios.post(server, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10_000,
      validateStatus: () => true,
    });

    if (res.status >= 200 && res.status < 300) {
      logger.info('ntfy notification sent', { postId: post.id, topic, status: res.status });
      return { ok: true, status: res.status, topic, callback: base };
    }

    const errMsg = `ntfy returned HTTP ${res.status}: ${JSON.stringify(res.data)}`;
    logger.error(errMsg, { postId: post.id, topic });
    return { ok: false, status: res.status, error: errMsg, topic, callback: base };
  } catch (err) {
    const ax = err as AxiosError;
    const errMsg = `ntfy request failed: ${ax.message}`;
    logger.error(errMsg, { postId: post.id, topic });
    return { ok: false, error: errMsg, topic, callback: base };
  }
}

/** Send a simple test notification — no actions, just verify connectivity. */
export async function sendTestNotification(): Promise<NtfyResult> {
  const topic = process.env.NTFY_TOPIC;
  const server = (process.env.NTFY_SERVER ?? 'https://ntfy.sh').replace(/\/$/, '');

  if (!topic || topic === 'xposter-your-secret-topic') {
    return { ok: false, error: 'NTFY_TOPIC is not set or still has placeholder value' };
  }

  try {
    const res = await axios.post(
      server,
      {
        topic,
        title: 'Xposter Test',
        message: `Test notification at ${new Date().toLocaleTimeString()} — if you see this on your iPhone, ntfy is working correctly.`,
        priority: 3,
        tags: ['test_tube'],
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10_000,
        validateStatus: () => true,
      },
    );

    if (res.status >= 200 && res.status < 300) {
      logger.info('ntfy test notification sent', { topic, status: res.status });
      return {
        ok: true,
        status: res.status,
        topic,
        callback: getCallbackBase(),
        hint: 'If this does not appear on your iPhone, check that the ntfy app is subscribed to exactly this topic and notifications are allowed.',
      };
    }
    return {
      ok: false,
      status: res.status,
      error: `ntfy returned HTTP ${res.status}: ${JSON.stringify(res.data)}`,
      topic,
    };
  } catch (err) {
    const ax = err as AxiosError;
    return { ok: false, error: ax.message, topic };
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}

function withActionToken(url: string, token: string): string {
  if (!token) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}token=${encodeURIComponent(token)}`;
}

// ──────────────────────────────────────────────────────────────────────────
// Follower-back notification
// ──────────────────────────────────────────────────────────────────────────

/** Sends a notification asking the user to approve/skip following a new follower back. */
export async function sendFollowerNotification(
  eventId: number,
  handle: string,
  account: Account | null,
): Promise<NtfyResult> {
  const topic = process.env.NTFY_TOPIC;
  const server = (process.env.NTFY_SERVER ?? 'https://ntfy.sh').replace(/\/$/, '');

  if (!topic || topic === 'xposter-your-secret-topic') {
    return { ok: false, error: 'NTFY_TOPIC not configured' };
  }

  const base = getCallbackBase();
  const followUrl = `${base}/api/follow/approve/${eventId}`;
  const skipUrl = `${base}/api/follow/skip/${eventId}`;

  const cls = account?.classification ?? 'UNKNOWN';
  const followers = account?.follower_count_seen ?? 0;
  const isMar = account?.is_marathi_creator ? ' · Marathi creator' : '';

  const message = [
    `@${handle} just followed you.`,
    '',
    `Class: ${cls}${isMar}`,
    `Followers: ${followers.toLocaleString()}`,
    account?.bio ? '' : '',
    account?.bio ? `Bio: ${truncate(account.bio, 200)}` : '',
  ].filter(Boolean).join('\n');

  const payload = {
    topic,
    title: 'Xposter: New Follower',
    message,
    priority: 3,
    tags: ['handshake'],
    actions: [
      { action: 'view', label: 'Follow back', url: followUrl, clear: true },
      { action: 'view', label: 'Skip',        url: skipUrl,   clear: true },
      { action: 'view', label: 'Open profile', url: `https://x.com/${encodeURIComponent(handle)}` },
    ],
  };

  try {
    const res = await axios.post(server, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10_000,
      validateStatus: () => true,
    });
    if (res.status >= 200 && res.status < 300) {
      return { ok: true, status: res.status, topic, callback: base };
    }
    return { ok: false, status: res.status, error: `HTTP ${res.status}: ${JSON.stringify(res.data)}`, topic };
  } catch (err) {
    return { ok: false, error: (err as AxiosError).message, topic };
  }
}
