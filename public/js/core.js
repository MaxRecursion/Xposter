const API = '';
const API_KEY_STORAGE = 'xposter:apiKey';

function $(id) { return document.getElementById(id); }

const TOAST_ICONS = { info: 'ℹ️', success: '✓', error: '✕', warn: '⚠' };

function toast(msg, type = 'info') {
  const container = $('toast-container');
  if (!container) return;

  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="toast-icon">${TOAST_ICONS[type] ?? TOAST_ICONS.info}</span> ${escHtml(msg)}`;
  container.appendChild(el);

  const dismiss = () => {
    if (!el.isConnected) return;
    el.classList.add('toast-out');
    setTimeout(() => el.remove(), 320);
  };
  setTimeout(dismiss, 4500);
  el.addEventListener('click', dismiss);
}

function animateCounter(el, target, duration = 600) {
  if (!el) return;
  const end = Number(target) || 0;
  const start = Number(el.dataset.value) || 0;
  if (start === end) {
    el.textContent = String(end);
    el.dataset.value = String(end);
    return;
  }
  const t0 = performance.now();
  const step = (now) => {
    const p = Math.min((now - t0) / duration, 1);
    const eased = 1 - Math.pow(1 - p, 3);
    const val = Math.round(start + (end - start) * eased);
    el.textContent = String(val);
    if (p < 1) requestAnimationFrame(step);
    else el.dataset.value = String(end);
  };
  requestAnimationFrame(step);
}

function switchTab(tabId) {
  document.querySelectorAll('.nav-item, .tab-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  });
  document.querySelectorAll('.tab-content').forEach((panel) => {
    const isActive = panel.id === `tab-${tabId}`;
    panel.classList.toggle('active', isActive);
    if (isActive) panel.classList.add('panel-morph-in');
  });
  syncNavCapsule();
  closeSidebar();
}

function syncNavCapsule() {
  const capsule = $('nav-capsule');
  const active = document.querySelector('.nav-item.active');
  const nav = document.querySelector('.sidebar-nav');
  if (!capsule || !active || !nav) return;
  const navRect = nav.getBoundingClientRect();
  const btnRect = active.getBoundingClientRect();
  capsule.style.width = `${btnRect.width}px`;
  capsule.style.height = `${btnRect.height}px`;
  capsule.style.transform = `translate3d(${btnRect.left - navRect.left}px, ${btnRect.top - navRect.top + nav.scrollTop}px, 0)`;
}

function initSpecularTracking() {
  const chrome = document.querySelectorAll('.lg-chrome, .topbar, .toast, .icon-btn');
  chrome.forEach((el) => {
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * 100;
      const y = ((e.clientY - r.top) / r.height) * 100;
      el.style.setProperty('--lg-specular-x', `${x}%`);
      el.style.setProperty('--lg-specular-y', `${y}%`);
    });
    el.addEventListener('pointerleave', () => {
      el.style.setProperty('--lg-specular-x', '14%');
      el.style.setProperty('--lg-specular-y', '10%');
    });
  });
}

function initScrollAdaptiveTint() {
  const main = $('content-area');
  if (!main) return;
  const onScroll = () => {
    const y = Math.min(main.scrollTop / 120, 1);
    document.documentElement.style.setProperty('--lg-scroll-adapt', String(y));
  };
  main.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
}

function toggleSidebarCollapsed() {
  const shell = $('app-shell');
  if (!shell) return;
  shell.classList.toggle('sidebar-collapsed');
}

function openSidebar() {
  $('sidebar')?.classList.add('open');
  $('sidebar-overlay')?.classList.add('visible');
}
function closeSidebar() {
  $('sidebar')?.classList.remove('open');
  $('sidebar-overlay')?.classList.remove('visible');
}

function initShell() {
  $('sidebar-toggle')?.addEventListener('click', () => {
    if ($('sidebar')?.classList.contains('open')) closeSidebar();
    else openSidebar();
  });
  $('sidebar-overlay')?.addEventListener('click', closeSidebar);

  const wireNav = (btn) => {
    btn.addEventListener('click', () => {
      if (!btn.dataset.tab) return;
      switchTab(btn.dataset.tab);
      document.dispatchEvent(new CustomEvent('xposter:tab', { detail: { tab: btn.dataset.tab } }));
    });
  };
  document.querySelectorAll('.nav-item, .tab-btn').forEach(wireNav);

  $('sidebar-brand')?.addEventListener('dblclick', (e) => {
    e.preventDefault();
    toggleSidebarCollapsed();
    requestAnimationFrame(syncNavCapsule);
  });

  initSpecularTracking();
  initScrollAdaptiveTint();
  requestAnimationFrame(syncNavCapsule);
  window.addEventListener('resize', () => requestAnimationFrame(syncNavCapsule));
}

async function apiFetch(path, opts = {}) {
  // Pull headers out of opts so the spread below cannot clobber the merged
  // auth headers with the caller's raw (auth-less) headers object.
  const { headers: extraHeaders, ...rest } = opts;
  let res = await fetch(API + path, {
    ...rest,
    headers: authHeaders(extraHeaders),
  });

  if (res.status === 401) {
    localStorage.removeItem(API_KEY_STORAGE);
    const key = prompt('Enter Xposter API key for this device. You should only see this if dashboard-origin trust is disabled or the request is not from the Xposter app URL.');
    if (key?.trim()) {
      localStorage.setItem(API_KEY_STORAGE, key.trim());
      res = await fetch(API + path, {
        ...rest,
        headers: authHeaders(extraHeaders),
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
    document.dispatchEvent(new CustomEvent('xposter:theme', { detail: { theme } }));
  },
  toggle() {
    this.set(this.get() === 'dark' ? 'light' : 'dark');
  },
  init() {
    this.set(this.get());
  },
};
