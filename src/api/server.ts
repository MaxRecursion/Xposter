import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import path from 'path';
import { postsRouter } from './routes/posts.js';
import { actionsRouter } from './routes/actions.js';
import { accountsRouter } from './routes/accounts.js';
import { followRouter } from './routes/follow.js';
import { originalPostsRouter } from './routes/original_posts.js';
import { repliesRouter } from './routes/replies.js';
import { contextRouter } from './routes/context.js';
import { audienceRouter } from './routes/audience.js';
import { agentRouter } from './routes/agent.js';
import { analyticsRouter } from './routes/analytics.js';
import { isAgentEnabled, isClaudeCliFound, isGhCliFound, getAgentModel } from '../agent/client.js';
import { runPipeline, isPipelineRunning } from '../scheduler/cron.js';
import { sendTestNotification } from '../notifications/ntfy.js';
import { getBindHost, getBrowserUrls, getCallbackBase } from '../utils/network.js';
import { logger } from '../utils/logger.js';
import { requireApiKey } from './auth.js';
import { getNextRuns, getTodayPlan, ensureTodayPlan, getTodayMix } from '../scheduler/random_runs.js';
import { getTodayOriginalPlan, getNextOriginalRuns } from '../scheduler/original_posts.js';

export function createServer(): express.Express {
  const app = express();

  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    next();
  });

  app.use(cors({
    origin(origin, callback) {
      if (!origin) { callback(null, true); return; }
      try {
        const allowed = [
          'http://localhost',
          'http://127.0.0.1',
          getCallbackBase(),
          getBrowserUrls().lan,
          getBrowserUrls().tailscale,
        ].filter(Boolean) as string[];
        const parsed = new URL(origin);
        const ok = allowed.some((allowedOrigin) => origin === allowedOrigin) ||
          (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
        callback(ok ? null : new Error('CORS origin not allowed'), ok);
      } catch {
        callback(new Error('Invalid CORS origin'), false);
      }
    },
  }));
  app.use(express.json({ limit: '64kb' }));
  morgan.token('safe-url', (req) => sanitizeUrl(req.url ?? ''));
  app.use(morgan(':method :safe-url :status :response-time ms - :res[content-length]', {
    stream: { write: (msg) => logger.http(msg.trim()) },
  }));

  // Static dashboard
  app.use(express.static(path.resolve(process.cwd(), 'public')));

  // API routes
  app.use('/api/posts', postsRouter);
  app.use('/api/actions', actionsRouter);
  app.use('/api/accounts', accountsRouter);
  app.use('/api/follow', followRouter);
  app.use('/api/original-posts', originalPostsRouter);
  app.use('/api/replies', repliesRouter);
  app.use('/api/context', contextRouter);
  app.use('/api/audience', audienceRouter);
  app.use('/api/agent', agentRouter);
  app.use('/api/analytics', analyticsRouter);

  // Schedule visibility
  app.get('/api/schedule/today', (_req, res) => {
    res.json({
      pipeline: { today: ensureTodayPlan(), upcoming: getNextRuns(10), mix: getTodayMix() },
      original_posts: { today: getTodayOriginalPlan(), upcoming: getNextOriginalRuns(10) },
    });
  });
  app.get('/api/schedule/upcoming', (_req, res) => {
    res.json(getNextRuns(20));
  });

  // Trigger manual run
  app.post('/api/run', requireApiKey, async (_req, res) => {
    if (isPipelineRunning()) {
      return res.status(409).json({ error: 'pipeline already running' });
    }
    res.json({ ok: true, message: 'Pipeline started' });
    try {
      await runPipeline();
    } catch (err) {
      logger.error('Manual run failed', { err });
    }
  });

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', ts: new Date().toISOString() });
  });

  // Test notification — verifies ntfy delivery to user's iPhone
  app.post('/api/test/notification', requireApiKey, async (_req, res) => {
    const result = await sendTestNotification();
    res.json(result);
  });

  // Diagnostics — current configuration / connectivity info
  app.get('/api/diagnostics', (_req, res) => {
    res.json({
      ntfy_topic: process.env.NTFY_TOPIC ?? '(not set)',
      ntfy_server: process.env.NTFY_SERVER ?? 'https://ntfy.sh',
      ntfy_action_mode: process.env.NTFY_ACTION_MODE ?? 'view',
      callback_base: getCallbackBase(),
      callback_network: process.env.CALLBACK_NETWORK ?? 'lan',
      bind_host: getBindHost(),
      browser_urls: getBrowserUrls(),
      groq_configured: Boolean(process.env.GROQ_API_KEY) &&
        process.env.GROQ_API_KEY !== 'replace_me_with_groq_api_key',
      api_key_set: Boolean(process.env.API_KEY) &&
        process.env.API_KEY !== 'change_me_generate_with_openssl_rand_hex_32',
      browser_headless: process.env.BROWSER_HEADLESS ?? 'true',
      agent_enabled: isAgentEnabled(),
      agent_model: getAgentModel(),
      claude_cli_found: isClaudeCliFound(),
      gh_cli_found: isGhCliFound(),
    });
  });

  // Unknown API routes must return JSON 404, not the SPA shell — a silent
  // HTML 200 here masks broken client calls.
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'not found' });
  });

  // SPA fallback
  app.get('*', (_req, res) => {
    res.sendFile(path.resolve(process.cwd(), 'public', 'index.html'));
  });

  return app;
}

function sanitizeUrl(url: string): string {
  return url
    .replace(/([?&](?:key|token)=)[^&]+/gi, '$1[REDACTED]')
    .replace(/([?&]api_key=)[^&]+/gi, '$1[REDACTED]');
}
