/**
 * Manage the style anchor set.
 *
 *   npm run image:anchor                 # list current anchors
 *   npm run image:anchor -- add <file>   # promote an image to an anchor
 *   npm run image:anchor -- clear        # remove all anchors
 *
 * Anchors pin wardrobe, hair and colour grade across generations. Two or three
 * good frames is the sweet spot — more dilutes the prompt.
 *
 * Typical bootstrap: run `npm run image:probe` a few times, pick the frames you
 * like, then `add` them.
 */
import '../src/env.js';
import fs from 'fs';
import path from 'path';
import { getDb } from '../src/storage/db.js';
import { ANCHORS_DIR, ensureAnchorsDir, listAnchorPaths, promoteToAnchor } from '../src/images/anchors.js';
import { readImageSize } from '../src/images/dimensions.js';
import { countUploads, hashBuffer, lookupUpload, purgeUploads } from '../src/storage/image_uploads.js';
import { getFalUploadTtlDays } from '../src/config.js';

function list(): void {
  const paths = listAnchorPaths();
  process.stdout.write(`Anchor directory: ${ANCHORS_DIR}\n\n`);
  if (paths.length === 0) {
    process.stdout.write('No anchors set. Generation will fall back to the text-only identity card.\n');
    process.stdout.write('Add one with:  npm run image:anchor -- add data/images/<file>.jpg\n');
    return;
  }
  const ttlDays = getFalUploadTtlDays();
  for (const p of paths) {
    const buf = fs.readFileSync(p);
    const size = readImageSize(buf);
    const cached = lookupUpload('fal', hashBuffer(buf), ttlDays) ? 'cached' : 'not uploaded';
    process.stdout.write(
      `  ${path.basename(p)}  ${size ? `${size.width}x${size.height}` : '?'}  `
      + `${Math.round(buf.length / 1024)}KB  [${cached}]\n`,
    );
  }
  process.stdout.write(`\n${paths.length} anchor(s). The first 3 are sent as style references.\n`);
  process.stdout.write(`${countUploads('fal')} upload(s) cached for fal (TTL ${ttlDays}d).\n`);
}

function main(): void {
  getDb();
  ensureAnchorsDir();

  const [cmd, arg] = process.argv.slice(2);

  if (!cmd || cmd === 'list') { list(); return; }

  if (cmd === 'add') {
    if (!arg) { process.stdout.write('usage: npm run image:anchor -- add <file>\n'); process.exitCode = 1; return; }
    const src = path.resolve(process.cwd(), arg);
    if (!fs.existsSync(src)) { process.stdout.write(`not found: ${src}\n`); process.exitCode = 1; return; }
    const dest = promoteToAnchor(src);
    process.stdout.write(`Added anchor: ${dest}\n\n`);
    list();
    return;
  }

  if (cmd === 'clear') {
    for (const p of listAnchorPaths()) fs.rmSync(p, { force: true });
    process.stdout.write('All anchors removed.\n');
    return;
  }

  if (cmd === 'purge-cache') {
    // Forces a re-upload on the next generation. Useful if a provider expires
    // hosted files earlier than the configured TTL.
    const n = purgeUploads('fal');
    process.stdout.write(`Cleared ${n} cached anchor upload(s). They will re-upload on next use.\n`);
    return;
  }

  process.stdout.write(`unknown command "${cmd}" — use list | add <file> | clear | purge-cache\n`);
  process.exitCode = 1;
}

main();
