/* ─────────────────────────────────────────────────────────────────────────
   Xposter Dashboard — vanilla JS, no build step
   Shared utilities (API, theme, helpers) are in /js/core.js loaded before this.
   ───────────────────────────────────────────────────────────────────────── */

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
    if ($('s-require-approval')) $('s-require-approval').checked = s.require_approval !== 'false';
    if ($('s-timeout'))        $('s-timeout').value        = s.approval_timeout_min ?? '30';
    if ($('s-wit'))            { $('s-wit').value          = s.wit_level ?? '55'; updateWitDisplay(); }
    if ($('s-runs-per-day'))   $('s-runs-per-day').value   = s.random_runs_per_day ?? '5';
    if ($('s-window-start'))   $('s-window-start').value   = s.active_window_start_hour ?? '9';
    if ($('s-window-end'))     $('s-window-end').value     = s.active_window_end_hour ?? '22';
    if ($('s-class-ttl'))      $('s-class-ttl').value      = s.classification_ttl_days ?? '7';
    if ($('s-max-fb'))              $('s-max-fb').value              = s.max_follow_backs_per_day ?? '15';
    if ($('s-blocklist'))           $('s-blocklist').value           = s.blocklist_classifications ?? '';
    if ($('s-orig-per-day'))        $('s-orig-per-day').value        = s.original_posts_per_day ?? '7';
    if ($('s-orig-marathi-ratio'))  $('s-orig-marathi-ratio').value  = s.original_post_marathi_ratio ?? '40';
    if ($('s-agent-enabled'))       $('s-agent-enabled').checked     = s.agent_enabled === 'true';
    if ($('s-agent-threshold'))     $('s-agent-threshold').value     = s.agent_error_threshold ?? '3';
    if ($('s-weekly-digest'))       $('s-weekly-digest').checked     = s.weekly_digest_enabled !== 'false';
    if ($('s-weekly-digest-hour'))  $('s-weekly-digest-hour').value  = s.weekly_digest_hour ?? '9';
  } catch { /* ignore */ }
  await loadDiagnostics();
  await refreshAgentSettingsNote();
}

async function refreshAgentSettingsNote() {
  const el = $('agent-settings-note');
  if (!el) return;
  try {
    const s = await apiFetch('/api/agent/status');
    const pieces = [];
    if (s.infraDisabled) pieces.push('⚠ AGENT_ENABLED=false in env — toggle has no effect');
    if (!s.claudeCliFound) pieces.push('⚠ `claude` CLI not on PATH');
    if (!s.ghFound) pieces.push('⚠ `gh` CLI not on PATH (PR creation will fail)');
    if (pieces.length === 0) {
      el.textContent = s.enabled
        ? `Agent is on · model ${s.model} · ${s.runsToday}/${s.maxRunsPerDay} runs used today`
        : 'Agent ready to enable. Save settings to turn on.';
    } else {
      el.innerHTML = pieces.map((p) => `<div>${escHtml(p)}</div>`).join('');
    }
  } catch { /* ignore */ }
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
    if ($('stat-followers')) $('stat-followers').textContent = events.length;
    if (events.length === 0) {
      el.innerHTML = `<div class="empty-state"><div class="icon">🤝</div><div>No pending follow-back decisions</div></div>`;
      return;
    }
    el.innerHTML = events.map(renderFollowerCard).join('');
  } catch (e) {
    if ($('followers-list')) $('followers-list').innerHTML = `<div class="empty-state">Error: ${escHtml(e.message)}</div>`;
  }
}

function setFollowerSyncStatus(message, kind = '') {
  const el = $('followers-sync-status');
  if (!el) return;
  el.textContent = message;
  el.className = `sync-status ${kind}`.trim();
  el.style.display = message ? 'block' : 'none';
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
  const isEF = post.post_type === 'ENGAGEMENT_FARM';
  const isQuote = post.post_type === 'QUOTE_TWEET';
  let parts = [post.content];
  try {
    const parsed = JSON.parse(post.thread_parts_json || '[]');
    if (Array.isArray(parsed) && parsed.length > 0) parts = parsed;
  } catch { /* use legacy content */ }
  const typeBadge = isEF
    ? `<span class="post-type-badge post-type-badge-engagement-farm">Engagement Farm</span>`
    : isQuote
      ? `<span class="post-type-badge post-type-badge-quote">Quote Tweet</span>`
      : `<span class="post-type-badge post-type-badge-original">Original</span>`;
  const threadBadge = parts.length > 1
    ? `<span class="post-type-badge post-type-badge-thread">${parts.length}-post thread</span>`
    : '';
  const when = post.posted_at ? timeAgo(post.posted_at) : timeAgo(post.created_at);
  const engHtml = post.status === 'POSTED' ? `
    <span title="Views">👁 ${(post.latest_impressions || 0).toLocaleString()}</span>
    <span title="Likes">❤️ ${post.latest_likes || 0}</span>
    <span title="Replies">💬 ${post.latest_replies || 0}</span>
    <span title="Retweets">🔁 ${post.latest_retweets || 0}</span>` : '';
  const viewLink = post.tweet_url
    ? `<a class="btn btn-ghost" href="${escAttr(post.tweet_url)}" target="_blank" rel="noopener">🔗 View</a>`
    : '';
  const quoteSource = isQuote && post.quoted_tweet_url
    ? `<a class="op-quote-source" href="${escAttr(post.quoted_tweet_url)}" target="_blank" rel="noopener">Quoted @${escHtml(post.quoted_author_handle || 'source')}</a>`
    : '';

  return `
    <div class="original-post-card ${statusCls}">
      <div class="op-header">
        <span class="op-topic">#${escHtml(post.topic)}</span>
        ${langBadge}
        ${typeBadge}
        ${threadBadge}
        <span class="op-status op-status-${post.status.toLowerCase()}">${post.status}</span>
        <span class="op-time">${when}</span>
      </div>
      <div class="op-content">${parts.map((part, index) => `
        <div class="op-thread-part">
          ${parts.length > 1 ? `<span class="op-thread-index">${index + 1}/${parts.length}</span>` : ''}
          <span>${escHtml(part)}</span>
        </div>
      `).join('')}</div>
      ${quoteSource}
      <div class="op-footer">
        <div class="op-engagement">${engHtml}</div>
        <div class="op-actions">${viewLink}</div>
      </div>
    </div>`;
}

// ── Analytics dashboard ──────────────────────────────────────────────────────

async function loadAnalytics() {
  const empty = $('analytics-empty');
  try {
    const data = await apiFetch('/api/analytics/overview?days=30');
    const summary = data.summary || {};
    $('analytics-summary').innerHTML = [
      ['Follower delta', formatSigned(summary.follower_delta || 0)],
      ['Replies posted', summary.replies || 0],
      ['Successful replies', summary.successful_replies || 0],
      ['Original posts', summary.originals || 0],
    ].map(([label, value]) => `
      <div class="analytics-summary-card">
        <div class="analytics-summary-value">${escHtml(value)}</div>
        <div class="analytics-summary-label">${escHtml(label)}</div>
      </div>
    `).join('');

    const hasData = (data.reply_by_classification?.length || 0) +
      (data.topic_trends?.length || 0) +
      (data.posting_hours?.length || 0) +
      (data.follower_growth?.some((row) => row.net !== 0) ? 1 : 0);
    empty.style.display = hasData ? 'none' : 'block';

    renderFollowerGrowth(data.follower_growth || []);
    renderReplyClassPerformance(data.reply_by_classification || []);
    renderTopicTrends(data.topic_trends || []);
    renderPostingHours(data.posting_hours || []);
  } catch (e) {
    empty.style.display = 'block';
    empty.textContent = `Analytics failed to load: ${e.message}`;
  }
}

function formatSigned(value) {
  const n = Number(value) || 0;
  return n > 0 ? `+${n}` : String(n);
}

function analyticsSvg(id, height = 230) {
  const svg = d3.select(`#${id}`);
  svg.selectAll('*').remove();
  const width = 760;
  svg.attr('viewBox', `0 0 ${width} ${height}`).attr('width', '100%').attr('height', height);
  return { svg, width, height };
}

function renderFollowerGrowth(rows) {
  const { svg, width, height } = analyticsSvg('analytics-followers');
  if (!rows.length) return;
  const margin = { top: 18, right: 20, bottom: 32, left: 42 };
  const x = d3.scaleTime()
    .domain(d3.extent(rows, (d) => new Date(`${d.day}T12:00:00`)))
    .range([margin.left, width - margin.right]);
  const extent = d3.extent(rows, (d) => d.cumulative);
  const y = d3.scaleLinear()
    .domain([Math.min(0, extent[0] || 0), Math.max(1, extent[1] || 0)])
    .nice()
    .range([height - margin.bottom, margin.top]);

  svg.append('path')
    .datum(rows)
    .attr('fill', 'none')
    .attr('stroke', '#1d8bf0')
    .attr('stroke-width', 3)
    .attr('d', d3.line()
      .x((d) => x(new Date(`${d.day}T12:00:00`)))
      .y((d) => y(d.cumulative)));
  svg.selectAll('.analytics-follower-dot')
    .data(rows.filter((d) => d.net !== 0))
    .join('circle')
    .attr('cx', (d) => x(new Date(`${d.day}T12:00:00`)))
    .attr('cy', (d) => y(d.cumulative))
    .attr('r', 3.5)
    .attr('fill', (d) => d.net >= 0 ? '#34c759' : '#ff453a');
  addAnalyticsAxes(svg, x, y, height, margin, d3.timeFormat('%d %b'));
}

function renderReplyClassPerformance(rows) {
  const el = $('analytics-reply-classes');
  if (!rows.length) {
    el.innerHTML = '<div class="analytics-no-data">No reply engagement data yet.</div>';
    return;
  }
  const maxScore = Math.max(...rows.map((row) => row.avg_success_score || 0), 1);
  el.innerHTML = rows.map((row) => `
    <div class="analytics-bar-row">
      <div class="analytics-bar-label">${escHtml(row.classification)}</div>
      <div class="analytics-bar-track">
        <div class="analytics-bar-fill" style="width:${Math.max(2, (row.avg_success_score / maxScore) * 100)}%"></div>
      </div>
      <div class="analytics-bar-value">${row.avg_success_score} avg · ${row.success_rate}% success · ${row.total_replies}</div>
    </div>
  `).join('');
}

function renderTopicTrends(rows) {
  const { svg, width, height } = analyticsSvg('analytics-topics', 260);
  if (!rows.length) return;
  const byTopic = d3.group(rows, (d) => d.topic);
  const topics = [...byTopic.entries()]
    .sort((a, b) => d3.max(b[1], (d) => d.engagement_score) - d3.max(a[1], (d) => d.engagement_score))
    .slice(0, 5);
  const shown = topics.flatMap(([, values]) => values);
  const margin = { top: 22, right: 150, bottom: 34, left: 46 };
  const x = d3.scaleTime()
    .domain(d3.extent(shown, (d) => new Date(d.checked_at * 1000)))
    .range([margin.left, width - margin.right]);
  const y = d3.scaleLinear()
    .domain([0, d3.max(shown, (d) => d.engagement_score) || 1])
    .nice()
    .range([height - margin.bottom, margin.top]);
  const colors = d3.scaleOrdinal(d3.schemeTableau10).domain(topics.map(([topic]) => topic));

  for (const [topic, values] of topics) {
    const sorted = [...values].sort((a, b) => a.checked_at - b.checked_at);
    svg.append('path')
      .datum(sorted)
      .attr('fill', 'none')
      .attr('stroke', colors(topic))
      .attr('stroke-width', 2.5)
      .attr('d', d3.line()
        .x((d) => x(new Date(d.checked_at * 1000)))
        .y((d) => y(d.engagement_score)));
  }
  addAnalyticsAxes(svg, x, y, height, margin, d3.timeFormat('%d %b'));
  const legend = svg.append('g').attr('transform', `translate(${width - margin.right + 12}, ${margin.top})`);
  topics.forEach(([topic], index) => {
    const row = legend.append('g').attr('transform', `translate(0, ${index * 24})`);
    row.append('circle').attr('r', 5).attr('fill', colors(topic));
    row.append('text').attr('x', 10).attr('y', 4).attr('class', 'analytics-axis-text')
      .text(topic.length > 18 ? `${topic.slice(0, 17)}…` : topic);
  });
}

function renderPostingHours(rows) {
  const { svg, width, height } = analyticsSvg('analytics-hours', 240);
  const allHours = Array.from({ length: 24 }, (_, hour) => {
    const row = rows.find((item) => item.hour === hour);
    return row || { hour, posts: 0, avg_engagement_score: 0 };
  });
  const margin = { top: 18, right: 20, bottom: 36, left: 44 };
  const x = d3.scaleBand().domain(allHours.map((d) => d.hour)).range([margin.left, width - margin.right]).padding(0.18);
  const y = d3.scaleLinear()
    .domain([0, d3.max(allHours, (d) => d.avg_engagement_score) || 1])
    .nice()
    .range([height - margin.bottom, margin.top]);
  svg.selectAll('.analytics-hour-bar')
    .data(allHours)
    .join('rect')
    .attr('x', (d) => x(d.hour))
    .attr('y', (d) => y(d.avg_engagement_score))
    .attr('width', x.bandwidth())
    .attr('height', (d) => y(0) - y(d.avg_engagement_score))
    .attr('rx', 2)
    .attr('fill', (d) => d.posts > 0 ? '#8b5cf6' : 'var(--border)');
  svg.append('g')
    .attr('transform', `translate(0, ${height - margin.bottom})`)
    .call(d3.axisBottom(x).tickValues([0, 3, 6, 9, 12, 15, 18, 21]).tickFormat((d) => `${String(d).padStart(2, '0')}:00`))
    .call((g) => g.selectAll('text').attr('class', 'analytics-axis-text'));
  svg.append('g')
    .attr('transform', `translate(${margin.left}, 0)`)
    .call(d3.axisLeft(y).ticks(5))
    .call((g) => g.selectAll('text').attr('class', 'analytics-axis-text'));
}

function addAnalyticsAxes(svg, x, y, height, margin, formatX) {
  svg.append('g')
    .attr('transform', `translate(0, ${height - margin.bottom})`)
    .call(d3.axisBottom(x).ticks(5).tickFormat(formatX))
    .call((g) => g.selectAll('text').attr('class', 'analytics-axis-text'));
  svg.append('g')
    .attr('transform', `translate(${margin.left}, 0)`)
    .call(d3.axisLeft(y).ticks(5))
    .call((g) => g.selectAll('text').attr('class', 'analytics-axis-text'));
}

// ── Audience Activity tab ─────────────────────────────────────────────────────

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_NAMES_SHORT = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
// Five-bucket blue palette matching X's analytics chart (light → dark).
const AUDIENCE_PALETTE = ['#e6f0fa', '#c8def7', '#9ec4f2', '#62a3eb', '#1d8bf0'];

async function loadAudience() {
  try {
    const [data, schedule] = await Promise.all([
      apiFetch('/api/audience/heatmap'),
      apiFetch('/api/schedule/today').catch(() => ({})),
    ]);

    renderAudienceLegend();

    const emptyEl = $('audience-empty');
    const fetchedEl = $('audience-fetched');

    if (!data.heatmap) {
      if (emptyEl) emptyEl.style.display = 'flex';
      const msg = $('audience-empty-msg');
      if (msg) msg.textContent = 'No audience data yet — click "Refresh now" to fetch it from X analytics';
      if (fetchedEl) fetchedEl.textContent = 'Last 28 days · never fetched';
      renderAudienceHeatmap(null, []);
      renderAudienceScheduledTimes([], []);
      return;
    }

    if (emptyEl) emptyEl.style.display = 'none';
    if (fetchedEl) {
      fetchedEl.textContent = `Last 28 days · fetched ${timeAgo(data.fetched_at)}`;
    }

    const pipelineToday = schedule.pipeline?.today ?? [];
    const originalsToday = schedule.original_posts?.today ?? [];
    renderAudienceHeatmap(data.heatmap, [
      ...pipelineToday.map((r) => ({ ...r, kind: 'reply' })),
      ...originalsToday.map((r) => ({ ...r, kind: 'original' })),
    ]);
    renderAudienceScheduledTimes(pipelineToday, originalsToday);
  } catch (e) {
    const emptyEl = $('audience-empty');
    if (emptyEl) emptyEl.style.display = 'flex';
    const msg = $('audience-empty-msg');
    if (msg) msg.textContent = `Failed to load audience data: ${e.message}`;
  }
}

function renderAudienceLegend() {
  const el = $('audience-legend-swatches');
  if (!el) return;
  el.innerHTML = AUDIENCE_PALETTE.map(
    (c) => `<span class="audience-legend-swatch" style="background:${c}"></span>`,
  ).join('');
}

function bucketIntensity(value) {
  if (typeof value !== 'number' || !isFinite(value)) return 0;
  return Math.max(0, Math.min(4, Math.floor(value * 5)));
}

function renderAudienceHeatmap(matrix, scheduledRuns) {
  const svg = d3.select('#audience-heatmap');
  svg.selectAll('*').remove();
  if (!matrix) return;

  const wrap = $('audience-heatmap-wrap');
  const W = (wrap?.clientWidth ?? 760);
  const H = 460;
  const margin = { top: 18, right: 56, bottom: 28, left: 36 };
  const innerW = W - margin.left - margin.right;
  const innerH = H - margin.top - margin.bottom;
  const cellW = innerW / 7;
  const cellH = innerH / 24;

  svg.attr('viewBox', `0 0 ${W} ${H}`).attr('width', '100%').attr('height', H);

  const g = svg.append('g').attr('transform', `translate(${margin.left}, ${margin.top})`);

  // Day-of-week order to match X's chart: Mon → Sun (column 0..6)
  const colToDow = [1, 2, 3, 4, 5, 6, 0];

  // Cells
  for (let col = 0; col < 7; col++) {
    const dow = colToDow[col];
    for (let hour = 0; hour < 24; hour++) {
      const intensity = matrix[dow]?.[hour] ?? 0;
      const bucket = bucketIntensity(intensity);
      g.append('rect')
        .attr('x', col * cellW + 1)
        .attr('y', hour * cellH + 1)
        .attr('width', Math.max(0, cellW - 2))
        .attr('height', Math.max(0, cellH - 2))
        .attr('rx', 2)
        .attr('fill', AUDIENCE_PALETTE[bucket])
        .append('title')
        .text(`${DAY_NAMES[dow]} · ${formatHourLabel(hour)} — intensity ${Math.round(intensity * 100)}%`);
    }
  }

  // Hour gridline labels every 4 hours on the right
  for (let hour = 0; hour <= 24; hour += 4) {
    g.append('text')
      .attr('x', innerW + 8)
      .attr('y', hour * cellH + 4)
      .attr('class', 'audience-axis')
      .text(formatHourLabel(hour % 24));
  }

  // Day labels at bottom
  for (let col = 0; col < 7; col++) {
    g.append('text')
      .attr('x', col * cellW + cellW / 2)
      .attr('y', innerH + 18)
      .attr('text-anchor', 'middle')
      .attr('class', 'audience-axis')
      .text(DAY_NAMES_SHORT[colToDow[col]]);
  }

  // Overlay scheduled runs as small dots
  if (Array.isArray(scheduledRuns)) {
    for (const run of scheduledRuns) {
      if (!run?.run_at || run.status !== 'SCHEDULED') continue;
      const d = new Date(run.run_at * 1000);
      const runDow = d.getDay();
      const runHour = d.getHours();
      const col = colToDow.indexOf(runDow);
      if (col < 0) continue;
      const minuteFrac = d.getMinutes() / 60;
      const cx = col * cellW + cellW / 2;
      const cy = (runHour + minuteFrac) * cellH + cellH / 2;
      g.append('circle')
        .attr('cx', cx)
        .attr('cy', cy)
        .attr('r', 4)
        .attr('class', `audience-run-dot audience-run-${run.kind}`)
        .append('title')
        .text(`${run.kind === 'reply' ? '💬 reply pipeline' : '✍️ original post'} at ${formatTimeHM(d)}`);
    }
  }
}

function formatHourLabel(hour) {
  if (hour === 0) return '12am';
  if (hour === 12) return '12pm';
  if (hour < 12) return `${hour}am`;
  return `${hour - 12}pm`;
}

function formatTimeHM(d) {
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function renderAudienceScheduledTimes(pipeline, originals) {
  const el = $('audience-today-times');
  if (!el) return;
  const merged = [
    ...pipeline.map((r) => ({ ...r, kind: 'reply' })),
    ...originals.map((r) => ({ ...r, kind: 'original' })),
  ]
    .filter((r) => r.run_at && r.status === 'SCHEDULED')
    .sort((a, b) => a.run_at - b.run_at);

  if (merged.length === 0) {
    el.innerHTML = '<div class="empty-state" style="padding:14px">No more runs scheduled today.</div>';
    return;
  }
  el.innerHTML = merged
    .map((r) => {
      const d = new Date(r.run_at * 1000);
      const icon = r.kind === 'reply' ? '💬' : '✍️';
      const label = r.kind === 'reply'
        ? 'Reply pipeline'
        : r.detail === 'ENGAGEMENT_FARM'
          ? 'Engagement farm'
          : r.detail === 'QUOTE_TWEET'
            ? 'Quote tweet'
            : 'Original post';
      return `
        <div class="audience-time-pill audience-time-${r.kind}">
          <span class="audience-time-icon">${icon}</span>
          <span class="audience-time-hm">${formatTimeHM(d)}</span>
          <span class="audience-time-label">${label}</span>
        </div>`;
    })
    .join('');
}

// ── Agent tab ─────────────────────────────────────────────────────────────────

let _agentRunStream = null;
let _agentActiveRunId = null;

async function loadAgent() {
  await Promise.all([loadAgentStatus(), loadAgentInvestigations(), loadAgentFeatures()]);
}

async function loadAgentStatus() {
  try {
    const s = await apiFetch('/api/agent/status');
    const pill = $('agent-enabled-pill');
    if (pill) {
      pill.textContent = s.enabled ? 'enabled' : 'disabled';
      pill.className = `status-badge ${s.enabled ? 'status-POSTED' : 'status-SKIPPED'}`;
    }
    const line = $('agent-status-line');
    if (line) {
      const checks = [];
      checks.push(`model ${s.model}`);
      checks.push(`${s.runsToday}/${s.maxRunsPerDay} runs today`);
      if (!s.claudeCliFound) checks.push('⚠ no claude CLI');
      if (!s.ghFound) checks.push('⚠ no gh CLI');
      if (s.lastWatchTickAt > 0) checks.push(`last watch ${timeAgo(s.lastWatchTickAt)}`);
      line.textContent = checks.join(' · ');
    }
    const disabledCard = $('agent-disabled-card');
    if (disabledCard) disabledCard.style.display = s.enabled ? 'none' : '';
  } catch (e) {
    if ($('agent-status-line')) $('agent-status-line').textContent = `error: ${e.message}`;
  }
}

async function loadAgentInvestigations() {
  const el = $('agent-investigations-list');
  if (!el) return;
  try {
    const list = await apiFetch('/api/agent/investigations');
    if (!list.length) {
      el.innerHTML = '<div class="empty-state" style="padding:18px">No investigations yet.</div>';
      return;
    }
    el.innerHTML = list.map(renderInvestigationCard).join('');
  } catch (e) {
    el.innerHTML = `<div class="empty-state">Failed to load: ${escHtml(e.message)}</div>`;
  }
}

function renderInvestigationCard(inv) {
  const fix = inv.proposed_fix ? safeParse(inv.proposed_fix) : null;
  const files = fix?.files_to_change?.length
    ? `<div class="agent-card-meta">files: ${fix.files_to_change.slice(0,5).map((f) => `<code>${escHtml(f)}</code>`).join(' ')}</div>`
    : '';
  const actions = inv.status === 'PROPOSED'
    ? `<div class="agent-card-actions">
         <button class="btn btn-success" onclick="applyInvestigation('${inv.id}')">▶ Apply</button>
         <button class="btn btn-ghost" onclick="dismissInvestigation('${inv.id}')">Dismiss</button>
       </div>`
    : '';
  return `
    <div class="agent-inv-card agent-status-${inv.status}">
      <div class="agent-inv-header">
        <span class="agent-inv-event">${escHtml(inv.event_name)}</span>
        <span class="status-badge status-${inv.status}">${inv.status}</span>
        <span class="agent-inv-meta">×${inv.occurrences} · last ${timeAgo(inv.last_seen_at)}</span>
      </div>
      ${inv.summary ? `<div class="agent-inv-summary">${escHtml(inv.summary)}</div>` : ''}
      ${inv.root_cause ? `<div class="agent-inv-rc">${escHtml(inv.root_cause)}</div>` : ''}
      ${files}
      ${actions}
    </div>`;
}

window.applyInvestigation = async (id) => {
  try {
    const r = await apiFetch(`/api/agent/investigations/${id}/apply`, { method: 'POST' });
    toast('Implementer started — opening live stream', 'success');
    if (r.runId) attachAgentRunStream(r.runId);
    setTimeout(loadAgentInvestigations, 1500);
  } catch (e) {
    toast(`Apply failed: ${e.message}`, 'error');
  }
};

window.dismissInvestigation = async (id) => {
  try {
    await apiFetch(`/api/agent/investigations/${id}/dismiss`, { method: 'POST' });
    await loadAgentInvestigations();
  } catch (e) {
    toast(`Dismiss failed: ${e.message}`, 'error');
  }
};

async function loadAgentFeatures() {
  const el = $('agent-features-list');
  if (!el) return;
  try {
    const list = await apiFetch('/api/agent/features');
    if (!list.length) {
      el.innerHTML = '<div class="audience-sub">No feature requests yet.</div>';
      return;
    }
    el.innerHTML = list.map(renderFeatureCard).join('');
  } catch (e) {
    el.innerHTML = `<div class="empty-state">Failed to load: ${escHtml(e.message)}</div>`;
  }
}

function renderFeatureCard(task) {
  const pr = task.pr_url
    ? `<a class="btn btn-ghost" href="${escAttr(task.pr_url)}" target="_blank" rel="noopener">🔗 PR</a>`
    : '';
  return `
    <div class="agent-feat-card agent-status-${task.status}">
      <div class="agent-inv-header">
        <span class="agent-feat-title">${escHtml(task.title)}</span>
        <span class="status-badge status-${task.status}">${task.status}</span>
        <span class="agent-inv-meta">${timeAgo(task.created_at)}</span>
      </div>
      <div class="agent-feat-desc">${escHtml((task.description || '').slice(0, 240))}${(task.description||'').length>240?'…':''}</div>
      <div class="agent-card-actions">
        ${task.branch ? `<code>${escHtml(task.branch)}</code>` : ''}
        ${pr}
      </div>
    </div>`;
}

async function submitAgentFeature() {
  const title = ($('agent-feat-title')?.value ?? '').trim();
  const description = ($('agent-feat-desc')?.value ?? '').trim();
  if (!title || !description) {
    toast('Provide both title and description', 'error');
    return;
  }
  try {
    const r = await apiFetch('/api/agent/features', {
      method: 'POST',
      body: JSON.stringify({ title, description }),
    });
    toast('Feature request submitted — agent starting', 'success');
    $('agent-feat-title').value = '';
    $('agent-feat-desc').value = '';
    await loadAgentFeatures();
    // Best-effort: peek at the latest run to attach the stream
    setTimeout(async () => {
      try {
        const runs = await apiFetch('/api/agent/runs?limit=5');
        const latest = runs.find((r) => r.source_kind === 'feature' && r.source_id === r.source_id);
        if (latest) attachAgentRunStream(latest.id);
      } catch { /* ignore */ }
    }, 2000);
  } catch (e) {
    toast(`Submit failed: ${e.message}`, 'error');
  }
}

function attachAgentRunStream(runId) {
  if (_agentRunStream) {
    try { _agentRunStream.close(); } catch { /* ignore */ }
  }
  _agentActiveRunId = runId;
  const body = $('agent-run-stream-body');
  const status = $('agent-run-status');
  if (body) body.innerHTML = '';
  if (status) status.textContent = `Streaming run ${runId.slice(0, 8)}…`;

  const apiKey = localStorage.getItem('xposter_api_key') ?? '';
  const url = `/api/agent/runs/${encodeURIComponent(runId)}/stream${apiKey ? `?key=${encodeURIComponent(apiKey)}` : ''}`;
  const es = new EventSource(url);
  _agentRunStream = es;
  es.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      const line = renderAgentStreamLine(msg);
      if (body) {
        body.insertAdjacentHTML('beforeend', line);
        body.scrollTop = body.scrollHeight;
      }
      if (msg.kind === 'end') {
        es.close();
        _agentRunStream = null;
        if (status) status.textContent = `Run ${runId.slice(0, 8)} complete.`;
        loadAgentInvestigations();
        loadAgentFeatures();
      }
    } catch { /* ignore */ }
  };
  es.onerror = () => {
    // EventSource auto-retries; surface a hint
    if (status) status.textContent = `Stream interrupted (reconnecting)…`;
  };
}

function renderAgentStreamLine(msg) {
  const ts = new Date(msg.ts * 1000).toLocaleTimeString('en-GB');
  const cls = `agent-line agent-line-${msg.kind}`;
  return `<div class="${cls}"><span class="ts">${ts}</span><span class="kind">${msg.kind}</span><span class="text">${escHtml(msg.text)}</span></div>`;
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
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
  if (activeTab === 'analytics') await loadAnalytics();
  if (activeTab === 'audience')  await loadAudience();
  if (activeTab === 'agent')     await loadAgent();
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
          require_approval:         $('s-require-approval')?.checked ? 'true' : 'false',
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
          agent_enabled:                $('s-agent-enabled')?.checked ? 'true' : 'false',
          agent_error_threshold:        $('s-agent-threshold')?.value,
          weekly_digest_enabled:        $('s-weekly-digest')?.checked ? 'true' : 'false',
          weekly_digest_hour:           $('s-weekly-digest-hour')?.value,
        }),
      });
      toast('Settings saved', 'success');
      await loadSchedule();
      await refreshAgentSettingsNote();
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
      setFollowerSyncStatus('Syncing followers from X…');
      try {
        const result = await apiFetch('/api/follow/sync', { method: 'POST' });
        const message = result.message ??
          `Follower sync complete: ${result.total ?? 0} followers scanned, ${result.notFollowedBack ?? 0} not followed back.`;
        setFollowerSyncStatus(message, 'success');
        toast(message, 'success');
        await loadFollowers();
      } catch (e) {
        setFollowerSyncStatus(e.message, 'error');
        toast(`Sync failed: ${e.message}`, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = '🔄 Sync followers now';
      }
    });
  }

  // Accounts tab filter
  if ($('btn-reload-accounts')) $('btn-reload-accounts').addEventListener('click', loadAccounts);
  if ($('acc-filter-class'))    $('acc-filter-class').addEventListener('change', loadAccounts);
  if ($('acc-filter-marathi'))  $('acc-filter-marathi').addEventListener('change', loadAccounts);
  if ($('btn-analytics-refresh')) $('btn-analytics-refresh').addEventListener('click', loadAnalytics);
  if ($('btn-weekly-digest')) {
    $('btn-weekly-digest').addEventListener('click', async () => {
      const btn = $('btn-weekly-digest');
      btn.disabled = true;
      try {
        const result = await apiFetch('/api/analytics/weekly-digest/send', { method: 'POST' });
        toast(result.sent ? 'Weekly digest sent' : (result.skipped || 'Digest not sent'), result.sent ? 'success' : 'info');
      } catch (e) {
        toast(`Digest failed: ${e.message}`, 'error');
      } finally {
        btn.disabled = false;
      }
    });
  }

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

  // Agent: feature form
  if ($('agent-feature-form')) {
    $('agent-feature-form').addEventListener('submit', (e) => {
      e.preventDefault();
      submitAgentFeature();
    });
  }

  // Agent: watcher tick now
  if ($('btn-agent-tick')) {
    $('btn-agent-tick').addEventListener('click', async () => {
      const btn = $('btn-agent-tick');
      btn.disabled = true;
      btn.textContent = '⏳ Scanning…';
      try {
        const r = await apiFetch('/api/agent/watch/tick', { method: 'POST' });
        toast(`Watcher scanned · ${r.investigated} new, ${r.skipped} skipped`, 'success');
        await loadAgent();
      } catch (e) {
        toast(`Watcher failed: ${e.message}`, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = '↻ Watch now';
      }
    });
  }

  // Audience refresh
  if ($('btn-audience-refresh')) {
    $('btn-audience-refresh').addEventListener('click', async () => {
      const btn = $('btn-audience-refresh');
      btn.disabled = true;
      btn.textContent = '⏳ Fetching from X…';
      try {
        const result = await apiFetch('/api/audience/refresh', { method: 'POST' });
        if (result.ok) {
          toast(`Audience heatmap refreshed (${result.cells ?? 0} cells)`, 'success');
          await loadAudience();
        } else {
          toast(`Refresh failed: ${result.error}`, 'error');
        }
      } catch (e) {
        toast(`Refresh failed: ${e.message}`, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = '🔄 Refresh now';
      }
    });
  }

  // Memory tab
  initMemoryTab();

  // Initial load + auto-refresh every 30s
  refresh();
  setInterval(refresh, 30_000);
});

/* ═══════════════════════════════════════════════════════════
   MEMORY MIND MAP
   ═══════════════════════════════════════════════════════════ */

function initMemoryTab() {
  const btn = document.getElementById('btn-memory-refresh');
  const btnQ = document.getElementById('btn-memory-query');
  const qInput = document.getElementById('memory-query');

  // Load when tab first opened
  document.querySelector('[data-tab="memory"]').addEventListener('click', () => {
    if (!memoryLoaded) loadMemory();
  });

  btn.addEventListener('click', () => loadMemory());
  btnQ.addEventListener('click', () => activateMemoryQuery(qInput.value.trim()));
  qInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') activateMemoryQuery(qInput.value.trim());
  });
}

let memoryLoaded = false;
let memoryData = null;
let memSim = null;

// Concept → color bucket
function conceptColor(key) {
  const k = key.toLowerCase();
  if (/\b(ai|tech|software|developer|coding|automation|saas|it |gcc|startup|startups|founders|funding)\b/.test(k)) return '#4a9eff';
  if (/\b(finance|economy|gdp|inflation|rbi|salary|salaries|rupee|bank|market|stock|invest)\b/.test(k)) return '#34d399';
  if (/\b(politics|political|election|government|policy|minister|modi|bjp|congress|vote)\b/.test(k)) return '#f87171';
  if (/\b(pune|maharashtra|hinjewadi|mumbai|india|local|city)\b/.test(k)) return '#fb923c';
  if (/\b(social|education|school|college|student|women|jobs|hiring|layoff|skill|upskill)\b/.test(k)) return '#a78bfa';
  if (/\b(startup|entrepreneur|product|growth|vc|angel)\b/.test(k)) return '#fbbf24';
  return '#6b7280';
}

async function loadMemory() {
  memoryLoaded = true;
  const emptyEl = document.getElementById('memory-empty');
  emptyEl.style.display = 'none';

  try {
    const [nmData, ctxData, trendsData] = await Promise.all([
      fetch('/api/context/neural-memory').then(r => r.json()),
      fetch('/api/context/health').then(r => r.json()),
      fetch('/api/context/trends').then(r => r.json()),
    ]);

    memoryData = nmData;
    renderMemoryStats(nmData.stats);
    renderMemorySources(ctxData);
    renderMemoryTrends(trendsData);
    renderMemoryGraph(nmData);
  } catch (e) {
    console.error('Memory load failed', e);
    emptyEl.style.display = 'flex';
    emptyEl.querySelector('div:last-child').textContent = 'Failed to load memory: ' + e.message;
  }
}

function renderMemoryStats(stats) {
  const s = stats || {};
  document.getElementById('ms-events').textContent = s.totalEvents ?? '–';
  document.getElementById('ms-nodes').textContent = s.totalNodes ?? '–';
  document.getElementById('ms-edges').textContent = s.totalEdges ?? '–';
  document.getElementById('ms-originals').textContent = s.originals ?? '–';
}

function renderMemorySources(ctxData) {
  const list = document.getElementById('mem-sources-list');
  const sources = ctxData?.stats?.by_source ?? [];
  const health = ctxData?.sources ?? {};
  const total = ctxData?.stats?.total_items ?? 0;

  if (!sources.length) {
    list.innerHTML = '<div class="mem-source-loading" style="color:var(--text3)">Context disabled or no items yet</div>';
    return;
  }

  const sourceColors = {
    'rss:indianexpress': '#fb923c',
    'reddit': '#ff6314',
    'weather': '#4a9eff',
  };

  list.innerHTML = sources.map(src => {
    const color = sourceColors[src.source] || '#6b7280';
    const hSrc = health[src.source] ?? {};
    const isActive = hSrc.last_ok_at && (Date.now() / 1000 - hSrc.last_ok_at) < 7200;
    const label = src.source.replace(/^rss:/, '').replace('indianexpress', 'Indian Express');
    const newestAgo = src.newest_at
      ? Math.round((Date.now() / 1000 - src.newest_at) / 60)
      : null;
    const agoStr = newestAgo !== null
      ? (newestAgo < 60 ? `${newestAgo}m ago` : `${Math.round(newestAgo / 60)}h ago`)
      : 'no items';

    return `
      <div class="mem-source-item">
        <div class="mem-source-dot ${isActive ? 'active' : ''}" style="background:${color}"></div>
        <div class="mem-source-info">
          <div class="mem-source-name">${label}</div>
          <div class="mem-source-meta">Latest: ${agoStr}</div>
        </div>
        <div class="mem-source-count">${src.count}</div>
      </div>`;
  }).join('');

  document.getElementById('mem-context-total').textContent =
    `${total} items · ${ctxData.stats?.total_vectors ?? 0} vectors`;
}

function renderMemoryTrends(trends) {
  const list = document.getElementById('mem-trends-list');
  const top = (trends || []).slice(0, 8);
  if (!top.length) {
    list.innerHTML = '<div style="font-size:12px;color:var(--text3)">No trend data yet</div>';
    return;
  }
  const maxVel = Math.max(...top.map(t => Math.abs(t.velocity ?? t.count ?? 1)), 1);
  list.innerHTML = top.map(t => {
    const name = t.topic || t.name || '?';
    const vel = t.velocity ?? t.count ?? 0;
    const pct = Math.round((Math.abs(vel) / maxVel) * 100);
    const velStr = vel > 0 ? `+${vel.toFixed(1)}` : vel.toFixed(1);
    return `
      <div class="mem-trend-item">
        <div class="mem-trend-label-row">
          <span class="mem-trend-name">${name}</span>
          <span class="mem-trend-vel">${velStr}</span>
        </div>
        <div class="mem-trend-bar-bg">
          <div class="mem-trend-bar-fill" style="width:${pct}%"></div>
        </div>
      </div>`;
  }).join('');
}

function renderMemoryGraph(data) {
  const nodes = (data.nodes || []).map(n => ({ ...n, id: n.key }));
  const edges = (data.edges || []).map(e => ({ source: e.from, target: e.to, weight: e.weight }));

  if (!nodes.length) {
    document.getElementById('memory-empty').style.display = 'flex';
    return;
  }

  const svg = d3.select('#memory-svg');
  svg.selectAll('*').remove();

  const wrap = document.getElementById('memory-svg').parentElement;
  const W = wrap.clientWidth || 700;
  const H = wrap.clientHeight || 500;

  svg.attr('viewBox', `0 0 ${W} ${H}`);

  // Zoom behaviour
  const g = svg.append('g').attr('class', 'mem-zoom-g');
  svg.call(
    d3.zoom().scaleExtent([0.3, 3]).on('zoom', (event) => {
      g.attr('transform', event.transform);
    })
  );

  // Weight scales
  const maxW = d3.max(nodes, d => d.weight) || 1;
  const rScale = d3.scaleSqrt().domain([0, maxW]).range([6, 28]);
  const maxEW = d3.max(edges, d => d.weight) || 1;
  const strokeScale = d3.scaleLinear().domain([0, maxEW]).range([0.5, 4]);

  // Build adjacency for interaction
  const adjacency = new Map();
  nodes.forEach(n => adjacency.set(n.id, new Set()));
  edges.forEach(e => {
    const src = typeof e.source === 'object' ? e.source.id : e.source;
    const tgt = typeof e.target === 'object' ? e.target.id : e.target;
    if (adjacency.has(src)) adjacency.get(src).add(tgt);
    if (adjacency.has(tgt)) adjacency.get(tgt).add(src);
  });

  // Force simulation
  if (memSim) memSim.stop();
  memSim = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(edges).id(d => d.id).strength(d => 0.1 + d.weight / maxEW * 0.4).distance(d => 80 - d.weight / maxEW * 40))
    .force('charge', d3.forceManyBody().strength(d => -120 - rScale(d.weight) * 4))
    .force('center', d3.forceCenter(W / 2, H / 2))
    .force('collision', d3.forceCollide().radius(d => rScale(d.weight) + 6))
    .alphaDecay(0.025);

  // Edges
  const link = g.append('g').selectAll('line')
    .data(edges).join('line')
    .attr('class', 'mem-link')
    .attr('stroke', d => {
      const srcId = typeof d.source === 'object' ? d.source.id : d.source;
      return conceptColor(srcId);
    })
    .attr('stroke-width', d => strokeScale(d.weight));

  // Nodes
  const node = g.append('g').selectAll('g')
    .data(nodes).join('g')
    .attr('class', 'mem-node')
    .call(
      d3.drag()
        .on('start', (event, d) => { if (!event.active) memSim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
        .on('drag', (event, d) => { d.fx = event.x; d.fy = event.y; })
        .on('end', (event, d) => { if (!event.active) memSim.alphaTarget(0); d.fx = null; d.fy = null; })
    )
    .on('click', (event, d) => {
      event.stopPropagation();
      highlightNode(d, node, link, adjacency, data);
    });

  node.append('circle')
    .attr('r', d => rScale(d.weight))
    .attr('fill', d => conceptColor(d.key) + '33')
    .attr('stroke', d => conceptColor(d.key));

  node.append('text')
    .attr('dy', d => rScale(d.weight) + 12)
    .attr('text-anchor', 'middle')
    .text(d => d.key)
    .style('font-size', d => Math.max(9, Math.min(12, rScale(d.weight) * 0.7)) + 'px');

  // Tick
  memSim.on('tick', () => {
    link
      .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
    node.attr('transform', d => `translate(${d.x},${d.y})`);
  });

  // Click background to clear selection
  svg.on('click', () => clearHighlight(node, link));
}

function highlightNode(d, node, link, adjacency, data) {
  const connectedIds = adjacency.get(d.id) || new Set();

  node.classed('highlighted', n => n.id === d.id || connectedIds.has(n.id));
  node.classed('dimmed', n => n.id !== d.id && !connectedIds.has(n.id));
  link.classed('highlighted', l => {
    const s = typeof l.source === 'object' ? l.source.id : l.source;
    const t = typeof l.target === 'object' ? l.target.id : l.target;
    return s === d.id || t === d.id;
  });
  link.classed('dimmed', l => {
    const s = typeof l.source === 'object' ? l.source.id : l.source;
    const t = typeof l.target === 'object' ? l.target.id : l.target;
    return s !== d.id && t !== d.id;
  });

  // Show detail card
  showNodeDetail(d, connectedIds, data);
}

function clearHighlight(node, link) {
  node.classed('highlighted dimmed', false);
  link.classed('highlighted dimmed', false);
  document.getElementById('mem-detail-card').style.display = 'none';
}

function showNodeDetail(d, connectedIds, data) {
  const card = document.getElementById('mem-detail-card');
  card.style.display = 'block';
  document.getElementById('mem-detail-title').textContent = `"${d.key}"`;

  const lastSeen = d.lastSeenAt
    ? new Date(d.lastSeenAt * 1000).toLocaleDateString()
    : 'unknown';

  // Find events that mention this concept
  const relEvents = (data.recentEvents || [])
    .filter(e => (e.concepts || []).includes(d.key))
    .slice(0, 3);

  const connected = [...connectedIds].slice(0, 8);

  document.getElementById('mem-detail-body').innerHTML = `
    <div class="mem-detail-concept" style="color:${conceptColor(d.key)}">${d.key}</div>
    <div class="mem-detail-stat-row">
      <div class="mem-detail-stat"><strong>${d.activations}</strong> activations</div>
      <div class="mem-detail-stat"><strong>${d.weight.toFixed(2)}</strong> weight</div>
      <div class="mem-detail-stat">Last: <strong>${lastSeen}</strong></div>
    </div>
    ${connected.length ? `
      <div class="mem-card-title" style="margin-top:8px">Co-occurs with</div>
      <div class="mem-connected-list">
        ${connected.map(c => `<span class="mem-connected-chip">${c}</span>`).join('')}
      </div>` : ''}
    ${relEvents.length ? `
      <div class="mem-card-title" style="margin-top:8px">Recent signals</div>
      <div class="mem-detail-events">
        ${relEvents.map(e => `
          <div class="mem-detail-event ${e.kind === 'reply' ? 'reply-event' : ''}">
            <span style="color:var(--text3);font-size:10px">[${e.kind}]</span> ${e.text}
          </div>`).join('')}
      </div>` : ''}
  `;

  // Clicking a connected chip highlights that node
  card.querySelectorAll('.mem-connected-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.getElementById('memory-query').value = chip.textContent;
      activateMemoryQuery(chip.textContent);
    });
  });
}

async function activateMemoryQuery(query) {
  if (!query) return;
  if (!memoryLoaded) await loadMemory();

  // Visually activate matching nodes
  const nodeEls = d3.selectAll('.mem-node');
  const linkEls = d3.selectAll('.mem-link');

  // Fetch which concepts get activated
  try {
    const res = await fetch(`/api/context/preview?q=${encodeURIComponent(query)}&k=5`);
    const data = await res.json();
    const detectedTopics = new Set(data.detected_topics || []);

    // Also match by keyword
    const qWords = query.toLowerCase().split(/\s+/);

    nodeEls.classed('activated', false).classed('dimmed', false).classed('highlighted', false);
    linkEls.classed('dimmed', false).classed('highlighted', false);

    const activatedIds = new Set();
    nodeEls.each(function(d) {
      const matches = detectedTopics.has(d.key) ||
        qWords.some(w => d.key.toLowerCase().includes(w));
      if (matches) {
        activatedIds.add(d.id);
        d3.select(this).classed('activated', true).classed('highlighted', true);
      } else {
        d3.select(this).classed('dimmed', true);
      }
    });

    linkEls.each(function(d) {
      const s = typeof d.source === 'object' ? d.source.id : d.source;
      const t = typeof d.target === 'object' ? d.target.id : d.target;
      if (activatedIds.has(s) && activatedIds.has(t)) {
        d3.select(this).classed('highlighted', true).classed('dimmed', false);
      } else {
        d3.select(this).classed('dimmed', true);
      }
    });

    // Remove activation glow after 3s
    setTimeout(() => {
      nodeEls.classed('activated highlighted dimmed', false);
      linkEls.classed('highlighted dimmed', false);
    }, 4000);

  } catch (e) {
    console.error('Memory query failed', e);
  }
}
