import type { Request, Response } from 'express';
import { clampInt } from '../utils/number.js';

export { clampInt };

export function paramString(req: Request, name: string): string {
  return String(req.params[name] ?? '');
}

export function paramInt(req: Request, name: string): number {
  return parseInt(String(req.params[name] ?? ''), 10);
}

export function wantsHtml(req: Request): boolean {
  if (req.method !== 'GET') return false;
  const accept = String(req.headers['accept'] ?? '');
  return !(accept.includes('application/json') && !accept.includes('text/html'));
}

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function sendActionResponse(
  req: Request,
  res: Response,
  status: number,
  title: string,
  message: string,
): void {
  if (!wantsHtml(req)) {
    res.status(status).json(status >= 400 ? { error: message } : { ok: true, message });
    return;
  }

  const headingColor = status >= 400 ? 'color:#ff6b6b;' : '';
  res.status(status).type('html').send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#101820;color:#f6f1e7;}
      main{max-width:520px;padding:28px;text-align:center;}
      h1{margin:0 0 10px;font-size:28px;${headingColor}}
      p{font-size:17px;line-height:1.45;color:#dccfb8;}
      a{color:#ffd166;font-weight:700;}
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
      <p><a href="/">Open Xposter dashboard</a></p>
    </main>
  </body>
</html>`);
}
