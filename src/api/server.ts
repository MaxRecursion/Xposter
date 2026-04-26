import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import path from 'path';
import { postsRouter } from './routes/posts.js';
import { actionsRouter } from './routes/actions.js';
import { runPipeline, isPipelineRunning } from '../scheduler/cron.js';
import { sendTestNotification } from '../notifications/ntfy.js';
import { getBindHost, getBrowserUrls, getCallbackBase } from '../utils/network.js';
import { logger } from '../utils/logger.js';

export function createServer(): express.Express {
  const app = express();

  app.use(cors());
  app.use(express.json());
  app.use(morgan('dev', {
    stream: { write: (msg) => logger.http(msg.trim()) },
  }));

  // Static dashboard
  app.use(express.static(path.resolve(process.cwd(), 'public')));

  // API routes
  app.use('/api/posts', postsRouter);
  app.use('/api/actions', actionsRouter);

  // Trigger manual run
  app.post('/api/run', async (_req, res) => {
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
  app.post('/api/test/notification', async (_req, res) => {
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
    });
  });

  // SPA fallback
  app.get('*', (_req, res) => {
    res.sendFile(path.resolve(process.cwd(), 'public', 'index.html'));
  });

  return app;
}
