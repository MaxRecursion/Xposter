let worker = null;
let nextId = 1;
const pending = new Map();

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker('./worker/query-engine.worker.js', { type: 'module' });
  worker.onmessage = (event) => {
    const { id, ok, payload, error } = event.data;
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (ok) entry.resolve(payload);
    else entry.reject(new Error(error || 'Worker error'));
  };
  worker.onerror = (err) => {
    for (const [, entry] of pending) entry.reject(err);
    pending.clear();
  };
  return worker;
}

function callWorker(type, data = {}) {
  const id = nextId++;
  const w = ensureWorker();
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, type, ...data });
  });
}

export async function initialize() {
  const result = await callWorker('initialize');
  return result;
}

export async function queryJson(sql) {
  return JSON.stringify(await callWorker('query', { sql }));
}

export async function runFullSuite() {
  return JSON.stringify(await callWorker('runFullSuite'));
}

export function dispose() {
  if (worker) {
    worker.terminate();
    worker = null;
  }
}

export function downloadJson(fileName, jsonText) {
  const blob = new Blob([jsonText], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

export function renderBarChart(canvas, labels, values) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (!values.length) return;
  const max = Math.max(...values, 1);
  const barW = Math.max(4, (w - 40) / values.length - 4);
  ctx.fillStyle = '#20c997';
  values.forEach((v, i) => {
    const barH = (v / max) * (h - 50);
    const x = 30 + i * (barW + 4);
    const y = h - 20 - barH;
    ctx.fillRect(x, y, barW, barH);
  });
}
