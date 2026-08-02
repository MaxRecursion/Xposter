import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import fs from 'fs';

const TEST_DB_RELATIVE = 'data/test-image-uploads.db';
const TEST_DB_PATH = path.resolve(process.cwd(), TEST_DB_RELATIVE);

function removeTestDb(): void {
  for (const suffix of ['', '-shm', '-wal']) fs.rmSync(`${TEST_DB_PATH}${suffix}`, { force: true });
}

const A = Buffer.from('anchor-one-contents');
const B = Buffer.from('anchor-two-contents');

describe('image reference upload cache', () => {
  beforeEach(() => {
    vi.resetModules();
    removeTestDb();
    fs.mkdirSync(path.dirname(TEST_DB_PATH), { recursive: true });
    process.env.DB_PATH_OVERRIDE = TEST_DB_RELATIVE;
  });

  afterEach(() => {
    delete process.env.DB_PATH_OVERRIDE;
    removeTestDb();
  });

  it('hashes buffer contents stably', async () => {
    const { hashBuffer } = await import('../../src/storage/image_uploads.js');
    expect(hashBuffer(A)).toBe(hashBuffer(Buffer.from('anchor-one-contents')));
    expect(hashBuffer(A)).toHaveLength(64);
  });

  it('changes the hash when a single byte changes', async () => {
    const { hashBuffer } = await import('../../src/storage/image_uploads.js');
    expect(hashBuffer(A)).not.toBe(hashBuffer(B));
  });

  it('misses before anything is stored', async () => {
    const u = await import('../../src/storage/image_uploads.js');
    expect(u.lookupUpload('fal', u.hashBuffer(A), 30)).toBeNull();
  });

  it('returns the cached url after remembering', async () => {
    const u = await import('../../src/storage/image_uploads.js');
    const hash = u.hashBuffer(A);
    u.rememberUpload('fal', hash, 'https://fal.media/a.jpg', A.length, 'image/jpeg');
    expect(u.lookupUpload('fal', hash, 30)).toBe('https://fal.media/a.jpg');
  });

  it('treats an entry past its TTL as a miss so it re-uploads', async () => {
    // Provider file retention is undocumented; a silently expired URL would
    // produce a bad image that still bills.
    const u = await import('../../src/storage/image_uploads.js');
    const { getDb } = await import('../../src/storage/db.js');
    const hash = u.hashBuffer(A);
    const old = Math.floor(Date.now() / 1000) - 31 * 86_400;
    getDb().prepare(
      `INSERT INTO image_ref_uploads (provider, hash, url, created_at) VALUES ('fal', ?, 'https://old', ?)`,
    ).run(hash, old);

    expect(u.lookupUpload('fal', hash, 30)).toBeNull();
    expect(u.lookupUpload('fal', hash, 60)).toBe('https://old');
  });

  it('leaves the old entry intact when an anchor is swapped', async () => {
    const u = await import('../../src/storage/image_uploads.js');
    u.rememberUpload('fal', u.hashBuffer(A), 'https://a.jpg');
    u.rememberUpload('fal', u.hashBuffer(B), 'https://b.jpg');

    expect(u.lookupUpload('fal', u.hashBuffer(A), 30)).toBe('https://a.jpg');
    expect(u.lookupUpload('fal', u.hashBuffer(B), 30)).toBe('https://b.jpg');
    expect(u.countUploads('fal')).toBe(2);
  });

  it('refreshes the url and timestamp on re-upload of the same bytes', async () => {
    const u = await import('../../src/storage/image_uploads.js');
    const hash = u.hashBuffer(A);
    u.rememberUpload('fal', hash, 'https://first.jpg');
    u.rememberUpload('fal', hash, 'https://second.jpg');
    expect(u.lookupUpload('fal', hash, 30)).toBe('https://second.jpg');
    expect(u.countUploads('fal')).toBe(1);
  });

  it('scopes entries per provider', async () => {
    const u = await import('../../src/storage/image_uploads.js');
    const hash = u.hashBuffer(A);
    u.rememberUpload('fal', hash, 'https://fal.jpg');
    expect(u.lookupUpload('other', hash, 30)).toBeNull();
  });

  it('purges by provider and reports the count', async () => {
    const u = await import('../../src/storage/image_uploads.js');
    u.rememberUpload('fal', u.hashBuffer(A), 'https://a.jpg');
    u.rememberUpload('other', u.hashBuffer(B), 'https://b.jpg');

    expect(u.purgeUploads('fal')).toBe(1);
    expect(u.countUploads('fal')).toBe(0);
    expect(u.countUploads('other')).toBe(1);
  });
});
