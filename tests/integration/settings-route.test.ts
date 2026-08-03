import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'path';
import fs from 'fs';
import type { Server } from 'node:http';

const TEST_DB_RELATIVE = 'data/test-settings-route.db';
const TEST_DB_PATH = path.resolve(process.cwd(), TEST_DB_RELATIVE);

function removeTestDb(): void {
  for (const suffix of ['', '-shm', '-wal']) {
    fs.rmSync(`${TEST_DB_PATH}${suffix}`, { force: true });
  }
}

async function startServer(app: { listen: Function }): Promise<Server> {
  return await new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function stopServer(server: Server | null): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

describe('settings and activity routes', () => {
  let server: Server | null = null;
  let port = 0;

  beforeEach(async () => {
    vi.resetModules();
    removeTestDb();
    fs.mkdirSync(path.dirname(TEST_DB_PATH), { recursive: true });
    process.env.DB_PATH_OVERRIDE = TEST_DB_RELATIVE;
    process.env.API_KEY = 'test-api-key';

    const { createServer } = await import('../../src/api/server.js');
    server = await startServer(createServer());
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not expose a numeric port');
    port = address.port;
  });

  afterEach(async () => {
    await stopServer(server);
    server = null;
    delete process.env.DB_PATH_OVERRIDE;
    delete process.env.API_KEY;
    removeTestDb();
  });

  it('GET /api/settings/all returns seeded settings', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/settings/all`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, string>;
    expect(body.min_score).toBe('40');
    expect(body.topic_category_weights).toContain('pune-tech-economy');
  });

  it('PATCH /api/settings/update normalizes writable settings', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/settings/update`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'test-api-key' },
      body: JSON.stringify({ min_score: '999', agent_last_watched_at: '42' }),
    });
    expect(res.status).toBe(200);

    const all = await fetch(`http://127.0.0.1:${port}/api/settings/all`);
    const body = await all.json() as Record<string, string>;
    expect(body.min_score).toBe('100');
    expect(body.agent_last_watched_at).toBe('0');
  });

  it('GET /api/activity returns activity log entries', async () => {
    const { logEvent } = await import('../../src/storage/queries.js');
    logEvent('TEST_EVENT', 'hello');

    const res = await fetch(`http://127.0.0.1:${port}/api/activity?limit=10`);
    expect(res.status).toBe(200);
    const entries = await res.json() as Array<{ event: string }>;
    expect(entries.some((e) => e.event === 'TEST_EVENT')).toBe(true);
  });

  it('keeps backward-compat paths under /api/posts', async () => {
    const settingsRes = await fetch(`http://127.0.0.1:${port}/api/posts/settings/all`);
    expect(settingsRes.status).toBe(200);

    const activityRes = await fetch(`http://127.0.0.1:${port}/api/posts/log/activity?limit=5`);
    expect(activityRes.status).toBe(200);
  });
});
