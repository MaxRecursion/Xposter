import { afterEach, describe, expect, it } from 'vitest';
import type { Request } from 'express';

describe('action auth tokens', () => {
  const originalEnv = {
    API_KEY: process.env.API_KEY,
    PORT: process.env.PORT,
    TRUST_DASHBOARD_ORIGIN: process.env.TRUST_DASHBOARD_ORIGIN,
    TAILSCALE_IP: process.env.TAILSCALE_IP,
    CALLBACK_NETWORK: process.env.CALLBACK_NETWORK,
    CALLBACK_BASE_URL: process.env.CALLBACK_BASE_URL,
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('creates scoped tokens without exposing the API key', async () => {
    process.env.API_KEY = 'super-secret-test-api-key';
    const { createActionToken, verifyActionToken } = await import('../../src/api/auth.js');

    const token = createActionToken('approve', 'post-123');

    expect(token).toBeTruthy();
    expect(token).not.toContain(process.env.API_KEY);
    expect(verifyActionToken('approve', 'post-123', token)).toBe(true);
    expect(verifyActionToken('skip', 'post-123', token)).toBe(false);
    expect(verifyActionToken('approve', 'post-456', token)).toBe(false);
  });

  it('trusts dashboard requests from configured LAN or Tailscale origins', async () => {
    process.env.API_KEY = 'super-secret-test-api-key';
    process.env.PORT = '3000';
    process.env.TRUST_DASHBOARD_ORIGIN = 'true';
    process.env.TAILSCALE_IP = '100.80.12.34';
    process.env.CALLBACK_NETWORK = 'tailscale';
    process.env.CALLBACK_BASE_URL = '';

    const { isTrustedDashboardRequest } = await import('../../src/api/auth.js');

    expect(isTrustedDashboardRequest({
      headers: { origin: 'http://100.80.12.34:3000' },
    } as unknown as Request)).toBe(true);
    expect(isTrustedDashboardRequest({
      headers: { origin: 'https://example.com' },
    } as unknown as Request)).toBe(false);
  });
});
