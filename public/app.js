/* ─────────────────────────────────────────────────────────────────────────
   Xposter Dashboard — vanilla JS, no build step
   - Theme engine (light/dark, persisted)
   - Hacker console (DOS-style live activity log)
   - iOS-style toggles
   ───────────────────────────────────────────────────────────────────────── */

const API = '';
const API_KEY_STORAGE = 'xposter:apiKey';

// ── Utilities ────────────────────────────────────────────────────────────────

function $(id) { return document.getElementById(id); }

function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

async function apiFetch(path, opts = {}) {
  const headers = authHeaders(opts.headers);
  let res = await fetch(API + path, {
    headers,
    ...opts,
  });

  if (res.status === 401) {
    localStorage.removeItem(API_KEY_STORAGE);
    const key = prompt('Enter Xposter API key for this device');
    if (key?.trim()) {
      localStorage.setItem(API_KEY_STORAGE, key.trim());
      res = await fetch(API + path, {
        headers: authHeaders(opts.headers),
        ...opts,
      });
    }
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? res.statusText);
  }
  return res.json();
}

function authHeaders(headers = {}) {
  const apiKey = localStorage.getItem(API_KEY_STORAGE);
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    ...(apiKey ? { 'X-API-Key': apiKey } : {}),
    ...headers,
  };
}

function timeAgo(unixSec) {
  const diff = Math.floor(Date.now() / 1000) - unixSec;
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escAttr(str) {
  return String(str ?? '').replace(/"/g, '&quot;');
}

function scoreBadgeClass(score) {
  if (score >= 65) return 'high';
  if (score >= 40) return 'mid';
  return 'low';
}

function statusBadge(status) {
  return `<span class="status-badge status-${status}">${status.replace('_', ' ')}</span>`;
}

// ── Theme Engine ─────────────────────────────────────────────────────────────

const THEME_KEY = 'xposter:theme';
const themeEngine = {
  get() {
    return localStorage.getItem(THEME_KEY) ||
      (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  },
  set(theme) {
    localStorage.setItem(THEME_KEY, theme);
    document.documentElement.setAttribute('data-theme', theme);
    const toggle = $('theme-toggle');
    if (toggle) toggle.checked = theme === 'light';
    const icon = $('theme-icon');
    if (icon) icon.textContent = theme === 'light' ? '☀️' : '🌙';
  },
  toggle() {
    this.set(this.get() === 'dark' ? 'light' : 'dark');
  },
  init() {
    this.set(this.get());
  },
};

// ── Post Card Renderer ────────────────────────────────────────────────────────

function renderPostCard(post, showActions = true) {
  const score = post.score ?? 0;
  const reply = post.final_reply ?? post.generated_reply ?? '';
  const ageText = timeAgo(post.ingested_at);
  const tweetAge = timeAgo(post.timestamp);
  const engagement = `♥ ${post.likes}  💬 ${post.replies}  🔁 ${post.retweets}`;

  const isPending = post.status === 'PENDING_APPROVAL';
  const canEdit = isPending;

  return `
    <div class="post-card" id="card-${post.id}">
      <div class="post-card-header">
        <div class="post-meta">
          <div class="post-author">${escHtml(post.author_name)}
            <span class="post-handle">@${escHtml(post.author_handle)}</span>
          </div>
          <div class="post-time">tweet: ${tweetAge} · ingested: ${ageText}</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;">
          ${statusBadge(post.status)}
          <span class="post-score-badge ${scoreBadgeClass(score)}">${score}/100</span>
        </div>
      </div>

      <div class="post-text">
        <span class="post-lang-tag">${post.language}</span><br/>
        ${escHtml(post.text)}
      </div>

      <div class="engagement-row">${engagement}</div>

      ${reply ? `
        <div class="reply-section">
          <div class="reply-label">Generated Reply</div>
          ${canEdit
            ? `<textarea class="reply-textarea" id="reply-${post.id}" rows="3" maxlength="280"
                oninput="updateCharCount('${post.id}')">${escHtml(reply)}</textarea>
               <div class="reply-char-count" id="cc-${post.id}">${reply.length}/280</div>`
            : `<div style="color:var(--text);font-size:13px;padding:8px 0;">${escHtml(reply)}</div>`
          }
        </div>
      ` : ''}

      ${showActions && isPending ? `
        <div class="post-actions">
          <button class="btn btn-success" onclick="approvePost('${post.id}')">✅ Approve</button>
          <button class="btn btn-danger"  onclick="skipPost('${post.id}')">❌ Skip</button>
          <button class="btn btn-ghost"   onclick="saveReply('${post.id}')">💾 Save Edit</button>
          <button class="btn btn-ghost"   onclick="regenerateReply('${post.id}')">🔄 Regenerate</button>
          <a class="btn btn-ghost" href="${escAttr(post.tweet_url)}" target="_blank" rel="noopener">🔗 View Tweet</a>
        </div>
      ` : `
        <div class="post-actions">
          <a class="btn btn-ghost" href="${escAttr(post.tweet_url)}" target="_blank" rel="noopener">🔗 View Tweet</a>
        </div>
      `}
    </div>
  `;
}

function updateCharCount(postId) {
  const ta = $(`reply-${postId}`);
  const cc = $(`cc-${postId}`);
  if (!ta || !cc) return;
  const len = ta.value.length;
  cc.textContent = `${len}/280`;
  cc.className = `reply-char-count${len > 240 ? ' warn' : ''}${len > 280 ? ' over' : ''}`;
}

// ── Post Actions (exposed on window for inline onclick) ───────────────────────

async function approvePost(postId) {
  const ta = $(`reply-${postId}`);
  if (ta) {
    try {
      await apiFetch(`/api/posts/${postId}/reply`, {
        method: 'PATCH',
        body: JSON.stringify({ reply: ta.value }),
      });
    } catch { /* ignore edit errors, proceed */ }
  }

  try {
    await apiFetch(`/api/actions/approve/${postId}`, { method: 'POST' });
    toast('Reply queued for posting!', 'success');
    removeCard(postId);
    setTimeout(refresh, 3000);
  } catch (e) {
    toast(`Approve failed: ${e.message}`, 'error');
  }
}

async function skipPost(postId) {
  try {
    await apiFetch(`/api/actions/skip/${postId}`, { method: 'POST' });
    toast('Post skipped');
    removeCard(postId);
  } catch (e) {
    toast(`Skip failed: ${e.message}`, 'error');
  }
}

async function saveReply(postId) {
  const ta = $(`reply-${postId}`);
  if (!ta) return;
  try {
    await apiFetch(`/api/posts/${postId}/reply`, {
      method: 'PATCH',
      body: JSON.stringify({ reply: ta.value }),
    });
    toast('Reply saved', 'success');
  } catch (e) {
    toast(`Save failed: ${e.message}`, 'error');
  }
}

async function regenerateReply(postId) {
  const btn = document.querySelector(`#card-${postId} .btn-ghost[onclick*="regenerate"]`);
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Generating…'; }
  try {
    const data = await apiFetch(`/api/posts/${postId}/regenerate`, { method: 'POST' });
    toast('Reply regenerated', 'success');
    const ta = $(`reply-${postId}`);
    if (ta && data.reply) { ta.value = data.reply; updateCharCount(postId); }
  } catch (e) {
    toast(`Regenerate failed: ${e.message}`, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🔄 Regenerate'; }
  }
}

function removeCard(postId) {
  $(`card-${postId}`)?.remove();
  loadStats();
}

// Expose for inline handlers
window.approvePost = approvePost;
window.skipPost = skipPost;
window.saveReply = saveReply;
window.regenerateReply = regenerateReply;
window.updateCharCount = updateCharCount;

// ── Data Loaders ──────────────────────────────────────────────────────────────

async function loadStats() {
  try {
    const stats = await apiFetch('/api/posts/stats');
    $('stat-pending').textContent = stats.PENDING_APPROVAL ?? 0;
    $('stat-posted').textContent  = stats.POSTED ?? 0;
    $('stat-skipped').textContent = stats.SKIPPED ?? 0;
    const total = Object.values(stats).reduce((s, v) => s + v, 0);
    $('stat-total').textContent   = total;
  } catch { /* ignore */ }
}

async function loadQueue() {
  try {
    const posts = await apiFetch('/api/posts/pending');
    const el = $('queue-list');
    if (posts.length === 0) {
      el.innerHTML = `<div class="empty-state"><div class="icon">📭</div><div>No posts pending approval</div></div>`;
      return;
    }
    el.innerHTML = posts.map((p) => renderPostCard(p, true)).join('');
  } catch (e) {
    $('queue-list').innerHTML = `<div class="empty-state">Error: ${escHtml(e.message)}</div>`;
  }
}

async function loadHistory() {
  try {
    const posts = await apiFetch('/api/posts?hours=24');
    const el = $('history-list');
    const nonPending = posts.filter((p) => p.status !== 'PENDING_APPROVAL').slice(0, 50);
    if (nonPending.length === 0) {
      el.innerHTML = `<div class="empty-state"><div class="icon">📋</div><div>No history yet</div></div>`;
      return;
    }
    el.innerHTML = nonPending.map((p) => renderPostCard(p, false)).join('');
  } catch (e) {
    $('history-list').innerHTML = `<div class="empty-state">Error: ${escHtml(e.message)}</div>`;
  }
}

async function loadSettings() {
  try {
    const s = await apiFetch('/api/posts/settings/all');
    if ($('s-keywords'))       $('s-keywords').value       = s.topic_keywords ?? '';
    if ($('s-min-score'))      $('s-min-score').value      = s.min_score ?? '40';
    if ($('s-max-candidates')) $('s-max-candidates').value = s.max_candidates_per_run ?? '3';
    if ($('s-timeout'))        $('s-timeout').value        = s.approval_timeout_min ?? '30';
    if ($('s-wit'))            { $('s-wit').value          = s.wit_level ?? '55'; updateWitDisplay(); }
    if ($('s-runs-per-day'))   $('s-runs-per-day').value   = s.random_runs_per_day ?? '5';
    if ($('s-window-start'))   $('s-window-start').value   = s.active_window_start_hour ?? '9';
    if ($('s-window-end'))     $('s-window-end').value     = s.active_window_end_hour ?? '22';
    if ($('s-class-ttl'))      $('s-class-ttl').value      = s.classification_ttl_days ?? '7';
    if ($('s-max-fb'))              $('s-max-fb').value              = s.max_follow_backs_per_day ?? '15';
    if ($('s-blocklist'))           $('s-blocklist').value           = s.blocklist_classifications ?? '';
    if ($('s-orig-per-day'))        $('s-orig-per-day').value        = s.original_posts_per_day ?? '5';
    if ($('s-orig-marathi-ratio'))  $('s-orig-marathi-ratio').value  = s.original_post_marathi_ratio ?? '40';
  } catch { /* ignore */ }
  await loadDiagnostics();
}

// ── Wit slider helpers ─────────────────────────────────────────────────────
function witTier(level) {
  if (level < 20) return { tier: 'serious',  help: 'serious — strictly factual, no humour' };
  if (level < 40) return { tier: 'measured', help: 'measured — warm and sincere, no jokes' };
  if (level < 60) return { tier: 'balanced', help: 'balanced — light Puneri wit when it fits' };
  if (level < 80) return { tier: 'witty',    help: 'witty — steady dry humour, observational' };
  return { tier: 'sharp', help: 'sharp & funny — punchy satirical edge (situation-as-joke only)' };
}

function updateWitDisplay() {
  const el = $('s-wit');
  if (!el) return;
  const v = parseInt(el.value, 10);
  $('wit-value').textContent = v;
  const { tier, help } = witTier(v);
  $('wit-tier').textContent = tier;
  $('wit-help').textContent = help;
  el.style.setProperty('--slider-fill', v + '%');
}

async function loadDiagnostics() {
  try {
    const d = await apiFetch('/api/diagnostics');
    const rows = [
      ['ntfy_topic',       d.ntfy_topic, d.ntfy_topic && d.ntfy_topic !== '(not set)' && d.ntfy_topic !== 'xposter-your-secret-topic'],
      ['ntfy_server',      d.ntfy_server, true],
      ['callback_base',    d.callback_base, true],
      ['groq_configured',  d.groq_configured ? 'yes' : 'no — set GROQ_API_KEY in .env', d.groq_configured],
      ['api_key_set',      d.api_key_set ? 'yes' : 'placeholder (auth disabled)', d.api_key_set],
      ['browser_headless', d.browser_headless, true],
    ];
    $('diag-table').innerHTML = rows.map(([k, v, ok]) => `
      <div class="diag-row">
        <div class="key">${escHtml(k)}</div>
        <div class="value ${ok ? 'ok' : 'bad'}">${escHtml(String(v))}</div>
      </div>
    `).join('');
  } catch (e) {
    $('diag-table').innerHTML = `<div class="diag-row"><div class="key">error</div><div class="value bad">${escHtml(e.message)}</div></div>`;
  }
}

async function loadSystemStatus() {
  try {
    const s = await apiFetch('/api/actions/status');
    const running = s.system_running;
    const ind = $('system-indicator');
    const lbl = $('system-label');
    const tgl = $('system-toggle');
    if (running) {
      ind.classList.add('running');
      lbl.textContent = 'Running';
    } else {
      ind.classList.remove('running');
      lbl.textContent = 'Paused';
    }
    if (tgl) tgl.checked = running;
  } catch { /* ignore */ }
}

// ──────────────────────────────────────────────────────────────────────────
// HACKER CONSOLE
// ──────────────────────────────────────────────────────────────────────────

const hc = {
  seenIds: new Set(),
  paused: false,
  pollTimer: null,
  bannerShown: false,

  banner() {
    const banner =
`╔════════════════════════════════════════════════════════════╗
║  XPOSTER ACTIVITY MONITOR · v1.0                           ║
║  Streaming live events from /api/posts/log/activity        ║
║  Status legend: GREEN=ok  AMBER=warn  RED=error            ║
╚════════════════════════════════════════════════════════════╝`;
    if (!this.bannerShown) {
      $('hc-banner').textContent = banner;
      this.bannerShown = true;
    }
  },

  classify(event) {
    const e = String(event).toUpperCase();
    if (e.includes('ERROR') || e.includes('FAILED') || e === 'POST_ERROR' ||
        e === 'PIPELINE_ERROR' || e === 'CANDIDATE_ERROR' || e === 'NOTIFICATION_FAILED') {
      return 'error';
    }
    if (e === 'EXPIRED' || e === 'SKIP' || e === 'EXPIRY' || e.includes('WARN') ||
        e.includes('RATE_LIMIT')) {
      return 'warn';
    }
    if (e === 'POSTED' || e === 'APPROVE' || e === 'NOTIFICATION_SENT') {
      return 'success';
    }
    return 'ok';
  },

  formatTime(unixSec) {
    const d = new Date(unixSec * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  },

  renderLine(entry) {
    const cls = this.classify(entry.event);
    const ts = this.formatTime(entry.created_at);
    const pid = entry.post_id ? ` <span class="pid">[${entry.post_id.slice(0, 8)}]</span>` : '';
    const det = entry.detail ? escHtml(entry.detail) : '';
    return `<div class="hc-line ${cls}">
      <span class="ts">${ts}</span>
      <span class="ev">${escHtml(entry.event)}</span>
      <span class="det">${det}${pid}</span>
    </div>`;
  },

  async tick() {
    if (this.paused) return;
    try {
      const entries = await apiFetch('/api/posts/log/activity?limit=200');
      const lines = $('hc-lines');
      if (!lines) return;

      // entries come newest-first; reverse for chronological display
      const chrono = entries.slice().reverse();
      const fresh = chrono.filter((e) => !this.seenIds.has(e.id));

      if (fresh.length === 0 && this.seenIds.size > 0) return;

      if (this.seenIds.size === 0) {
        // Initial load: render all
        lines.innerHTML = chrono.map((e) => this.renderLine(e)).join('');
        chrono.forEach((e) => this.seenIds.add(e.id));
      } else {
        // Append only new lines
        const html = fresh.map((e) => this.renderLine(e)).join('');
        lines.insertAdjacentHTML('beforeend', html);
        fresh.forEach((e) => this.seenIds.add(e.id));
      }

      // Auto-scroll to bottom
      const body = $('hc-body');
      if (body) body.scrollTop = body.scrollHeight;

      // Empty-state message
      if (chrono.length === 0 && !lines.querySelector('.hc-empty')) {
        lines.innerHTML = `<div class="hc-empty">[ no events yet — waiting for pipeline activity ]</div>`;
      }
    } catch (e) {
      const lines = $('hc-lines');
      if (lines) {
        lines.insertAdjacentHTML(
          'beforeend',
          `<div class="hc-line error"><span class="ts">${this.formatTime(Date.now()/1000)}</span><span class="ev">CONSOLE_ERR</span><span class="det">${escHtml(e.message)}</span></div>`,
        );
      }
    }
  },

  start() {
    this.banner();
    if (this.pollTimer) return;
    this.tick();
    this.pollTimer = setInterval(() => this.tick(), 2000);
  },

  stop() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  },

  togglePause() {
    this.paused = !this.paused;
    $('hc-status').textContent = this.paused ? '[ PAUSED ]' : '[ LIVE ]';
    $('hc-pause').textContent = this.paused ? 'RESUME' : 'PAUSE';
  },

  clear() {
    $('hc-lines').innerHTML = '';
    this.seenIds.clear();
    this.bannerShown = false;
    this.banner();
  },
};

// ── Followers tab ─────────────────────────────────────────────────────────────

async function loadFollowers() {
  try {
    const events = await apiFetch('/api/follow/pending');
    const el = $('followers-list');
    if (!el) return;
    if (events.length === 0) {
      el.innerHTML = `<div class="empty-state"><div class="icon">🤝</div><div>No pending follow-back decisions</div></div>`;
      return;
    }
    el.innerHTML = events.map(renderFollowerCard).join('');
    if ($('stat-followers')) $('stat-followers').textContent = events.length;
  } catch (e) {
    if ($('followers-list')) $('followers-list').innerHTML = `<div class="empty-state">Error: ${escHtml(e.message)}</div>`;
  }
}

function renderFollowerCard(event) {
  const detail = event.detail ?? '';
  return `
    <div class="follower-card" id="fevent-${event.id}">
      <div class="follower-info">
        <div class="follower-handle">@${escHtml(event.account_handle)}</div>
        <div class="follower-name">followed you · ${timeAgo(event.detected_at)}</div>
        <div class="follower-meta">${escHtml(detail)}</div>
      </div>
      <div class="follower-actions">
        <button class="btn btn-success" onclick="approveFollowBack(${event.id})">✅ Follow back</button>
        <button class="btn btn-ghost"   onclick="skipFollowBack(${event.id})">❌ Skip</button>
        <a class="btn btn-ghost" target="_blank" rel="noopener"
           href="https://x.com/${encodeURIComponent(event.account_handle)}">🔗 Profile</a>
      </div>
    </div>
  `;
}

async function approveFollowBack(eventId) {
  try {
    await apiFetch(`/api/follow/approve/${eventId}`, { method: 'POST' });
    toast('Follow-back queued', 'success');
    $(`fevent-${eventId}`)?.remove();
    setTimeout(loadFollowers, 4000);
  } catch (e) {
    toast(`Follow-back failed: ${e.message}`, 'error');
  }
}

async function skipFollowBack(eventId) {
  try {
    await apiFetch(`/api/follow/skip/${eventId}`, { method: 'POST' });
    toast('Follow-back skipped');
    $(`fevent-${eventId}`)?.remove();
  } catch (e) {
    toast(`Skip failed: ${e.message}`, 'error');
  }
}

window.approveFollowBack = approveFollowBack;
window.skipFollowBack = skipFollowBack;

// ── Accounts tab ──────────────────────────────────────────────────────────────

async function loadAccounts() {
  try {
    const cls = $('acc-filter-class')?.value;
    const marathiOnly = $('acc-filter-marathi')?.checked;
    const params = new URLSearchParams();
    if (cls) params.set('classification', cls);
    if (marathiOnly) params.set('marathiOnly', 'true');

    const [accounts, stats] = await Promise.all([
      apiFetch('/api/accounts?' + params.toString()),
      apiFetch('/api/accounts/_/stats').catch(() => null),
    ]);

    if (stats && $('accounts-stats')) {
      $('accounts-stats').innerHTML = `
        <div class="diag-row"><div class="key">Total interactions</div><div class="value">${stats.total}</div></div>
        <div class="diag-row"><div class="key">Likes received</div><div class="value">${stats.total_likes}</div></div>
        <div class="diag-row"><div class="key">Replies received</div><div class="value">${stats.total_replies}</div></div>
        <div class="diag-row"><div class="key">Retweets received</div><div class="value">${stats.total_retweets}</div></div>
        <div class="diag-row"><div class="key">Avg success score</div><div class="value">${stats.avg_success.toFixed(1)}</div></div>
      `;
    }

    const el = $('accounts-list');
    if (accounts.length === 0) {
      el.innerHTML = `<div class="empty-state"><div class="icon">👥</div><div>No accounts match this filter</div></div>`;
      return;
    }
    el.innerHTML = accounts.map(renderAccountCard).join('');
  } catch (e) {
    if ($('accounts-list')) $('accounts-list').innerHTML = `<div class="empty-state">Error: ${escHtml(e.message)}</div>`;
  }
}

function renderAccountCard(account) {
  const cls = account.classification ?? 'UNKNOWN';
  const conf = account.classification_confidence ? Math.round(account.classification_confidence * 100) + '%' : '-';
  const followers = account.follower_count_seen?.toLocaleString?.() ?? '0';
  const lastSeen = account.last_seen_at ? timeAgo(account.last_seen_at) : '?';
  const isMar = account.is_marathi_creator
    ? `<span class="marathi-badge">मराठी</span>`
    : '';

  return `
    <div class="account-card" id="account-${escAttr(account.handle)}">
      <div class="account-info">
        <div class="account-handle">
          @${escHtml(account.handle)} ${isMar}
          <span class="cls-badge cls-${cls}">${cls}</span>
        </div>
        <div class="account-name">${escHtml(account.display_name ?? '')}</div>
        ${account.bio ? `<div class="account-bio">${escHtml(account.bio)}</div>` : ''}
        <div class="account-meta">
          <span>👥 ${followers} followers</span>
          <span>🎯 conf ${conf}</span>
          <span>💬 ${account.total_replies_sent ?? 0} replies sent</span>
          <span>last seen ${lastSeen}</span>
          ${account.following_us ? '<span style="color:var(--green)">↩ follows you</span>' : ''}
          ${account.followed_by_us ? '<span style="color:var(--accent)">↪ you follow</span>' : ''}
        </div>
      </div>
      <div class="account-actions">
        <button class="btn btn-ghost" onclick="reclassifyAccount('${escAttr(account.handle)}')">🔄 Reclassify</button>
        <a class="btn btn-ghost" target="_blank" rel="noopener"
           href="https://x.com/${encodeURIComponent(account.handle)}">🔗 Profile</a>
      </div>
    </div>
  `;
}

async function reclassifyAccount(handle) {
  try {
    toast(`Reclassifying @${handle}…`);
    await apiFetch(`/api/accounts/${encodeURIComponent(handle)}/classify`, { method: 'POST' });
    toast('Classified ✓', 'success');
    loadAccounts();
  } catch (e) {
    toast(`Failed: ${e.message}`, 'error');
  }
}

window.reclassifyAccount = reclassifyAccount;

// ── Schedule strip ────────────────────────────────────────────────────────────

function renderScheduleTimes(runs, containerId, stripId) {
  const strip = $(stripId);
  const container = $(containerId);
  if (!strip || !container) return;
  if (!runs || runs.length === 0) { strip.style.display = 'none'; return; }
  const now = Math.floor(Date.now() / 1000);
  const sorted = [...runs].sort((a, b) => a.run_at - b.run_at);
  const upcomingId = sorted.find((r) => r.status === 'SCHEDULED' && r.run_at >= now)?.id;
  container.innerHTML = sorted.map((r) => {
    const t = new Date(r.run_at * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    let cls = 'schedule-time';
    if (r.status === 'FIRED' || r.status === 'SKIPPED') cls += ' fired';
    else if (r.id === upcomingId) cls += ' next';
    return `<span class="${cls}">${t}</span>`;
  }).join(' ');
  strip.style.display = 'flex';
}

async function loadSchedule() {
  try {
    const data = await apiFetch('/api/schedule/today');
    // API now returns { pipeline: { today, upcoming }, original_posts: { today, upcoming } }
    const pipelineToday = data.pipeline?.today ?? data.today ?? [];
    const originalsToday = data.original_posts?.today ?? [];
    renderScheduleTimes(pipelineToday, 'schedule-times', 'schedule-strip');
    renderScheduleTimes(originalsToday, 'originals-schedule-times', 'originals-schedule');
  } catch { /* ignore */ }
}

// ── Original Posts tab ────────────────────────────────────────────────────────

async function loadOriginals() {
  try {
    const [posts, performance] = await Promise.all([
      apiFetch('/api/original-posts'),
      apiFetch('/api/original-posts/topic-performance'),
    ]);

    // Topic performance mini-table
    const perfEl = $('originals-topic-perf');
    if (perfEl) {
      if (performance.length === 0) {
        perfEl.innerHTML = '';
      } else {
        perfEl.innerHTML = `
          <div class="diag-table">
            <div class="diag-row diag-header">
              <span>Topic</span><span>Posts</span><span>Avg Likes</span>
              <span>Avg Replies</span><span>Avg Views</span>
            </div>
            ${performance.slice(0, 8).map((p) => `
              <div class="diag-row">
                <span>${escHtml(p.topic)}</span>
                <span>${p.total_posts}</span>
                <span>${Math.round(p.avg_likes)}</span>
                <span>${Math.round(p.avg_replies)}</span>
                <span>${Math.round(p.avg_impressions).toLocaleString()}</span>
              </div>
            `).join('')}
          </div>`;
      }
    }

    // Posts list
    const listEl = $('originals-list');
    if (!listEl) return;
    if (posts.length === 0) {
      listEl.innerHTML = '<div class="empty-state">No original posts yet. Click "Post now" to generate one.</div>';
      return;
    }
    listEl.innerHTML = posts.map(renderOriginalPost).join('');
  } catch (e) {
    const listEl = $('originals-list');
    if (listEl) listEl.innerHTML = `<div class="empty-state" style="color:var(--error)">Failed to load: ${escHtml(e.message)}</div>`;
  }
}

function renderOriginalPost(post) {
  const statusCls = post.status === 'POSTED' ? 'posted' : post.status === 'ERROR' ? 'error' : '';
  const langBadge = post.language === 'marathi'
    ? `<span class="marathi-badge">मराठी</span>`
    : `<span class="lang-badge-en">EN</span>`;
  const when = post.posted_at ? timeAgo(post.posted_at) : timeAgo(post.created_at);
  const engHtml = post.status === 'POSTED' ? `
    <span title="Views">👁 ${(post.latest_impressions || 0).toLocaleString()}</span>
    <span title="Likes">❤️ ${post.latest_likes || 0}</span>
    <span title="Replies">💬 ${post.latest_replies || 0}</span>
    <span title="Retweets">🔁 ${post.latest_retweets || 0}</span>` : '';
  const viewLink = post.tweet_url
    ? `<a class="btn btn-ghost" href="${escAttr(post.tweet_url)}" target="_blank" rel="noopener">🔗 View</a>`
    : '';

  return `
    <div class="original-post-card ${statusCls}">
      <div class="op-header">
        <span class="op-topic">#${escHtml(post.topic)}</span>
        ${langBadge}
        <span class="op-status op-status-${post.status.toLowerCase()}">${post.status}</span>
        <span class="op-time">${when}</span>
      </div>
      <div class="op-content">${escHtml(post.content)}</div>
      <div class="op-footer">
        <div class="op-engagement">${engHtml}</div>
        <div class="op-actions">${viewLink}</div>
      </div>
    </div>`;
}

// ── Full refresh ──────────────────────────────────────────────────────────────

async function refresh() {
  await Promise.all([loadStats(), loadSystemStatus(), loadSchedule()]);
  const activeTab = document.querySelector('.tab-btn.active')?.dataset.tab;
  if (activeTab === 'queue')     await loadQueue();
  if (activeTab === 'history')   await loadHistory();
  if (activeTab === 'settings')  await loadSettings();
  if (activeTab === 'followers') await loadFollowers();
  if (activeTab === 'accounts')  await loadAccounts();
  if (activeTab === 'originals') await loadOriginals();
  // Console runs its own loop independently
}

// ── Event Wiring ──────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // Theme initialization
  themeEngine.init();

  // Theme toggle
  $('theme-toggle').addEventListener('change', () => {
    themeEngine.toggle();
  });

  // System toggle
  $('system-toggle').addEventListener('change', async () => {
    try {
      await apiFetch('/api/actions/toggle', { method: 'POST' });
      await loadSystemStatus();
      toast('System ' + ($('system-toggle').checked ? 'resumed' : 'paused'));
    } catch (e) {
      toast(`Toggle failed: ${e.message}`, 'error');
      // revert UI
      await loadSystemStatus();
    }
  });

  // Tabs
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
      btn.classList.add('active');
      $(`tab-${btn.dataset.tab}`)?.classList.add('active');

      if (btn.dataset.tab === 'console') {
        hc.start();
      }
      refresh();
    });
  });

  // Header buttons
  $('btn-refresh').addEventListener('click', refresh);

  $('btn-run').addEventListener('click', async () => {
    const btn = $('btn-run');
    btn.disabled = true;
    btn.textContent = '⏳ Running…';
    try {
      await apiFetch('/api/run', { method: 'POST' });
      toast('Pipeline started!', 'success');
      setTimeout(refresh, 2000);
    } catch (e) {
      toast(`Run failed: ${e.message}`, 'error');
    } finally {
      setTimeout(() => { btn.disabled = false; btn.textContent = '▶ Run Now'; }, 5000);
    }
  });

  // Settings save
  $('btn-save-settings').addEventListener('click', async () => {
    try {
      await apiFetch('/api/posts/settings/update', {
        method: 'PATCH',
        body: JSON.stringify({
          topic_keywords:           $('s-keywords').value,
          min_score:                $('s-min-score').value,
          max_candidates_per_run:   $('s-max-candidates').value,
          approval_timeout_min:     $('s-timeout').value,
          wit_level:                $('s-wit')?.value,
          random_runs_per_day:      $('s-runs-per-day')?.value,
          active_window_start_hour: $('s-window-start')?.value,
          active_window_end_hour:   $('s-window-end')?.value,
          classification_ttl_days:  $('s-class-ttl')?.value,
          max_follow_backs_per_day:     $('s-max-fb')?.value,
          blocklist_classifications:    $('s-blocklist')?.value,
          original_posts_per_day:       $('s-orig-per-day')?.value,
          original_post_marathi_ratio:  $('s-orig-marathi-ratio')?.value,
        }),
      });
      toast('Settings saved', 'success');
      await loadSchedule();
    } catch (e) {
      toast(`Save failed: ${e.message}`, 'error');
    }
  });

  // Wit slider live update
  if ($('s-wit')) {
    $('s-wit').addEventListener('input', updateWitDisplay);
  }

  // Followers tab buttons
  if ($('btn-sync-followers')) {
    $('btn-sync-followers').addEventListener('click', async () => {
      const btn = $('btn-sync-followers');
      btn.disabled = true;
      btn.textContent = '⏳ Syncing…';
      try {
        await apiFetch('/api/follow/sync', { method: 'POST' });
        toast('Follower sync started', 'success');
        setTimeout(loadFollowers, 4000);
      } catch (e) {
        toast(`Sync failed: ${e.message}`, 'error');
      } finally {
        setTimeout(() => { btn.disabled = false; btn.textContent = '🔄 Sync followers now'; }, 5000);
      }
    });
  }

  // Accounts tab filter
  if ($('btn-reload-accounts')) $('btn-reload-accounts').addEventListener('click', loadAccounts);
  if ($('acc-filter-class'))    $('acc-filter-class').addEventListener('change', loadAccounts);
  if ($('acc-filter-marathi'))  $('acc-filter-marathi').addEventListener('change', loadAccounts);

  // Original Posts tab buttons
  if ($('btn-post-now')) {
    $('btn-post-now').addEventListener('click', async () => {
      const btn = $('btn-post-now');
      btn.disabled = true;
      btn.textContent = '⏳ Generating…';
      try {
        const result = await apiFetch('/api/original-posts/trigger', { method: 'POST' });
        if (result.ok) {
          toast('Original post queued — posting to X now!', 'success');
          setTimeout(loadOriginals, 8000);
        } else {
          toast(`Post failed: ${result.error}`, 'error');
        }
      } catch (e) {
        toast(`Post failed: ${e.message}`, 'error');
      } finally {
        setTimeout(() => { btn.disabled = false; btn.textContent = '✍️ Post now'; }, 6000);
      }
    });
  }

  if ($('btn-sync-impressions')) {
    $('btn-sync-impressions').addEventListener('click', async () => {
      const btn = $('btn-sync-impressions');
      btn.disabled = true;
      btn.textContent = '⏳ Syncing…';
      try {
        const result = await apiFetch('/api/original-posts/sync-impressions', { method: 'POST' });
        toast(`Impression sync done — ${result.synced} updated`, 'success');
        setTimeout(loadOriginals, 2000);
      } catch (e) {
        toast(`Sync failed: ${e.message}`, 'error');
      } finally {
        setTimeout(() => { btn.disabled = false; btn.textContent = '📊 Sync impressions'; }, 4000);
      }
    });
  }

  // Test notification
  $('btn-test-notif').addEventListener('click', async () => {
    const btn = $('btn-test-notif');
    btn.disabled = true;
    btn.textContent = '⏳ Sending…';
    try {
      const result = await apiFetch('/api/test/notification', { method: 'POST' });
      if (result.ok) {
        toast(`Test notification sent to topic "${result.topic}". Check your iPhone.`, 'success');
      } else {
        toast(`Notification failed: ${result.error}`, 'error');
      }
    } catch (e) {
      toast(`Test failed: ${e.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '📱 Send Test Notification';
    }
  });

  // Hacker console controls
  $('hc-clear').addEventListener('click', () => hc.clear());
  $('hc-pause').addEventListener('click', () => hc.togglePause());

  // Initial load + auto-refresh every 30s
  refresh();
  setInterval(refresh, 30_000);
});
