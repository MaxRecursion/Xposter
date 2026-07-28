import { Request, RequestHandler, Response } from 'express';
import crypto from 'crypto';
import { logger } from '../utils/logger.js';
import { getAllowedDashboardOrigins } from '../utils/network.js';

import { getApiKey, isApiKeySet, getTrustDashboardOrigin, getActionTokenTTLSeconds } from '../config.js';

const PLACEHOLDER_API_KEY = 'change_me_generate_with_openssl_rand_hex_32';

export type ActionName = 'approve' | 'skip';

export function isLoopback(req: Request): boolean {
  const raw = (req.socket?.remoteAddress ?? '') || (req.ip ?? '');
  const ip = raw.replace('::ffff:', '');
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost' || ip === '';
}

export function hasConfiguredApiKey(): boolean {
  return isApiKeySet();
}

export function isValidApiKey(candidate: string): boolean {
  const expected = getApiKey();
  if (!expected || expected === PLACEHOLDER_API_KEY || !candidate) return false;
  return timingSafeEqual(candidate, expected);
}

export function requireApiKey(req: Request, res: Response, next: () => void): void {
  if (!hasConfiguredApiKey()) { next(); return; }
  if (isLoopback(req)) { next(); return; }
  if (isTrustedDashboardRequest(req)) { next(); return; }

  const provided = String(req.headers['x-api-key'] ?? req.query['key'] ?? '');
  if (isValidApiKey(provided)) { next(); return; }

  logger.warn('API request rejected - missing/invalid API key', {
    ip: req.ip,
    method: req.method,
    path: req.path,
  });
  res.status(401).json({ error: 'unauthorized' });
}

export function requireActionAuth(action: ActionName): RequestHandler {
  return (req, res, next) => {
    if (!hasConfiguredApiKey()) { next(); return; }
    if (isLoopback(req)) { next(); return; }
    if (isTrustedDashboardRequest(req)) { next(); return; }

    const provided = String(req.headers['x-api-key'] ?? req.query['key'] ?? '');
    if (isValidApiKey(provided)) { next(); return; }

    const token = String(req.query['token'] ?? '');
    const postId = String(req.params['id'] ?? '');
    if (verifyActionToken(action, postId, token)) { next(); return; }

    logger.warn('Action request rejected - invalid auth', {
      ip: req.ip,
      method: req.method,
      path: req.path,
      action,
    });
    res.status(401).json({ error: 'unauthorized' });
  };
}

export function callerLabel(req: Request): string {
  if (isLoopback(req)) return 'web';
  if (isTrustedDashboardRequest(req)) return 'web';
  if (req.headers['x-api-key'] || req.query['key'] || req.query['token']) return 'ntfy';
  return 'lan';
}

export function isTrustedDashboardRequest(req: Request): boolean {
  if (!getTrustDashboardOrigin()) return false;

  const origin = String(req.headers.origin ?? '');
  const referer = String(req.headers.referer ?? '');
  const candidate = origin || originFromReferer(referer);
  if (!candidate) return false;

  return getAllowedDashboardOrigins().some((allowed) => candidate === allowed);
}

export function createActionToken(action: ActionName, postId: string): string {
  const secret = getActionSecret();
  if (!secret) return '';

  const ttlSeconds = getActionTokenTTLSeconds();
  const safeTtl = Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds : 86400;
  const exp = Math.floor(Date.now() / 1000) + safeTtl;
  const signature = signAction(action, postId, exp, secret);
  return `${exp}.${signature}`;
}

export function verifyActionToken(action: ActionName, postId: string, token: string): boolean {
  const secret = getActionSecret();
  if (!secret || !postId || !token) return false;

  const [expRaw, signature] = token.split('.');
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || !signature || exp < Math.floor(Date.now() / 1000)) return false;

  const expected = signAction(action, postId, exp, secret);
  return timingSafeEqual(signature, expected);
}

function getActionSecret(): string | null {
  return hasConfiguredApiKey() ? getApiKey() : null;
}

function signAction(action: ActionName, postId: string, exp: number, secret: string): string {
  return crypto
    .createHmac('sha256', secret)
    .update(`${action}:${postId}:${exp}`)
    .digest('base64url');
}

function timingSafeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function originFromReferer(referer: string): string {
  if (!referer) return '';
  try {
    const url = new URL(referer);
    return url.origin;
  } catch {
    return '';
  }
}
