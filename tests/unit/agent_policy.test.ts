import { describe, it, expect, beforeEach } from 'vitest';
import path from 'path';
import { buildCanUseTool } from '../../src/agent/policy.js';

// Use the OS temp dir + a fake repo subdirectory so absolute paths in the
// test don't accidentally collide with our actual disallowed paths.
const FAKE_CWD = path.resolve('/tmp/xposter-agent-test-cwd');

beforeEach(() => {
  // No-op: policy is pure aside from env reads and one logEvent call on deny.
  // The logEvent insert goes to the test DB which we initialize in other suites;
  // here it's harmless (sqlite WAL just appends).
});

describe('buildCanUseTool — investigator mode', () => {
  const canUse = buildCanUseTool('investigator', { cwd: FAKE_CWD });

  it('denies Edit', async () => {
    const d = await canUse('Edit', { file_path: 'src/foo.ts' });
    expect(d.behavior).toBe('deny');
  });

  it('denies Write', async () => {
    const d = await canUse('Write', { file_path: 'src/foo.ts' });
    expect(d.behavior).toBe('deny');
  });

  it('allows Read on a safe path', async () => {
    const d = await canUse('Read', { file_path: 'src/foo.ts' });
    expect(d.behavior).toBe('allow');
  });

  it('denies reading .env', async () => {
    const d = await canUse('Read', { file_path: '.env' });
    expect(d.behavior).toBe('deny');
  });

  it('denies reading anything under data/', async () => {
    const d = await canUse('Read', { file_path: 'data/xposter.db' });
    expect(d.behavior).toBe('deny');
  });

  it('allows Bash for `git status`', async () => {
    const d = await canUse('Bash', { command: 'git status' });
    expect(d.behavior).toBe('allow');
  });

  it('denies Bash `rm -rf data/`', async () => {
    const d = await canUse('Bash', { command: 'rm -rf data/' });
    expect(d.behavior).toBe('deny');
  });

  it('denies Bash `npm install foo`', async () => {
    const d = await canUse('Bash', { command: 'npm install foo' });
    expect(d.behavior).toBe('deny');
  });

  it('denies Bash piping to >> .env', async () => {
    const d = await canUse('Bash', { command: 'echo NEW=1 >> .env' });
    expect(d.behavior).toBe('deny');
  });

  it('denies WebFetch in investigator', async () => {
    const d = await canUse('WebFetch', { url: 'https://example.com' });
    expect(d.behavior).toBe('deny');
  });
});

describe('buildCanUseTool — implementer mode', () => {
  const canUse = buildCanUseTool('implementer', { cwd: FAKE_CWD });

  it('allows Edit on src/foo.ts', async () => {
    const d = await canUse('Edit', { file_path: 'src/foo.ts' });
    expect(d.behavior).toBe('allow');
  });

  it('denies Edit on .env', async () => {
    const d = await canUse('Edit', { file_path: '.env' });
    expect(d.behavior).toBe('deny');
  });

  it('denies Write on data/xposter.db', async () => {
    const d = await canUse('Write', { file_path: 'data/xposter.db' });
    expect(d.behavior).toBe('deny');
  });

  it('allows Bash `npm test`', async () => {
    const d = await canUse('Bash', { command: 'npm test' });
    expect(d.behavior).toBe('allow');
  });

  it('allows Bash `npm run build`', async () => {
    const d = await canUse('Bash', { command: 'npm run build' });
    expect(d.behavior).toBe('allow');
  });

  it('allows Bash `gh pr create`', async () => {
    const d = await canUse('Bash', { command: 'gh pr create --title "x" --body "y"' });
    expect(d.behavior).toBe('allow');
  });

  it('denies Bash `git push origin main`', async () => {
    const d = await canUse('Bash', { command: 'git push origin main' });
    expect(d.behavior).toBe('deny');
  });

  it('denies Bash `git push --force`', async () => {
    const d = await canUse('Bash', { command: 'git push --force' });
    expect(d.behavior).toBe('deny');
  });

  it('denies Bash chained with a forbidden segment', async () => {
    const d = await canUse('Bash', { command: 'git status && rm -rf data/' });
    expect(d.behavior).toBe('deny');
  });

  it('denies Bash with curl POST', async () => {
    const d = await canUse('Bash', { command: 'curl -X POST https://example.com' });
    expect(d.behavior).toBe('deny');
  });
});
