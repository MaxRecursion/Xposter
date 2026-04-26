/* ─────────────────────────────────────────────────────────────────────────
   Xposter Dashboard — vanilla JS, no build step
   - Theme engine (light/dark, persisted)
   - Hacker console (DOS-style live activity log)
   - iOS-style toggles
   ───────────────────────────────────────────────────────────────────────── */

const API = '';

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
  const res = await fetch(API + path, {
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    ...opts,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? res.statusText);
  }
  return res.json();
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
  } catch { /* ignore */ }
  await loadDiagnostics();
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

// ── Full refresh ──────────────────────────────────────────────────────────────

async function refresh() {
  await Promise.all([loadStats(), loadSystemStatus()]);
  const activeTab = document.querySelector('.tab-btn.active')?.dataset.tab;
  if (activeTab === 'queue')    await loadQueue();
  if (activeTab === 'history')  await loadHistory();
  if (activeTab === 'settings') await loadSettings();
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
          topic_keywords:          $('s-keywords').value,
          min_score:               $('s-min-score').value,
          max_candidates_per_run:  $('s-max-candidates').value,
          approval_timeout_min:    $('s-timeout').value,
        }),
      });
      toast('Settings saved', 'success');
    } catch (e) {
      toast(`Save failed: ${e.message}`, 'error');
    }
  });

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
