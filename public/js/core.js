const API = '';
const API_KEY_STORAGE = 'xposter:apiKey';

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
    const key = prompt('Enter Xposter API key for this device. You should only see this if dashboard-origin trust is disabled or the request is not from the Xposter app URL.');
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
