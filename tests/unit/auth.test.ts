import { afterEach, describe, expect, it } from 'vitest';

describe('action auth tokens', () => {
  const originalApiKey = process.env.API_KEY;

  afterEach(() => {
    if (originalApiKey === undefined) delete process.env.API_KEY;
    else process.env.API_KEY = originalApiKey;
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
});
