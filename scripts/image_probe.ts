/**
 * Generate one image with the current prompt template and geometry, run it
 * through the vision QA gate, and report the verdict. No DB write, no post —
 * the file is left in data/images/ for inspection.
 *
 *   npm run image:probe                     # random scene, REAL generation (may cost money)
 *   npm run image:probe -- cafe_window_rain
 *   npm run image:probe -- --dry            # print the resolved config + request body, spend $0
 *   npm run image:probe -- --free           # force the free provider, spend $0
 *   npm run image:probe -- --judge data/images/existing.jpg
 */
import '../src/env.js';
import path from 'path';
import { getDb } from '../src/storage/db.js';
import {
  allScenes, buildPrompt, generateImage, getScene, imageAspectRatio, imageDimensions, pickScene,
} from '../src/images/generator.js';
import { resolveIdentity } from '../src/images/identity.js';
import { ANCHOR_PROMPT_NOTE, listAnchorPaths, loadAnchors } from '../src/images/anchors.js';
import { buildImageProviders } from '../src/images/providers/index.js';
import { buildRequestBody, priceFor } from '../src/images/providers/fal.js';
import { countCachedAnchors } from '../src/images/providers/fal_references.js';
import {
  getFalImageModel, getFalImageResolution, getFalKey, getFalReferenceMode,
} from '../src/config.js';
import { budgetStatus } from '../src/storage/image_budget.js';
import { isRejected, judgeImage, rejectionReason } from '../src/images/vision_qa.js';
import type { Scene } from '../src/images/generator.js';

async function judgeOnly(file: string): Promise<void> {
  const abs = path.resolve(process.cwd(), file);
  process.stdout.write(`Judging existing image: ${abs}\n\n`);

  const verdict = await judgeImage(abs);
  if (!verdict) {
    process.stdout.write('QA gate unavailable (Claude CLI missing or disabled)\n');
    return;
  }
  process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n\n`);
  process.stdout.write(isRejected(verdict) ? `REJECTED: ${rejectionReason(verdict)}\n` : 'ACCEPTED\n');
}

/** Parses W:H into a numeric ratio, or null. */
function ratioOf(aspect: string): number | null {
  const [w, h] = aspect.split(':').map(Number);
  return Number.isFinite(w) && Number.isFinite(h) && h > 0 ? w / h : null;
}

function printHeader(scene: Scene): void {
  const { width, height } = imageDimensions();
  const providers = buildImageProviders();
  const budget = budgetStatus();
  const anchors = listAnchorPaths();

  const chain = providers.map((p) => `${p.name}($${p.costPerImageUsd()})`).join(' -> ') || '(none)';
  process.stdout.write(`Providers: ${chain}\n`);
  process.stdout.write(
    `Budget:    $${budget.spentUsd} of $${budget.budgetUsd} this month · `
    + `today $${budget.spentTodayUsd} of $${budget.dailyAllowanceUsd} allowance · `
    + `${budget.daysRemaining}d left · ${budget.generations} generations\n`,
  );
  process.stdout.write(
    `Anchors:   ${anchors.length} style reference(s)`
    + `${anchors.length ? ` — ${anchors.map((a) => a.split('/').pop()).join(', ')}` : ' (text-only identity)'}\n`,
  );

  if (getFalKey()) {
    const buffers = loadAnchors();
    const cached = countCachedAnchors(buffers);
    process.stdout.write(
      `fal:       model=${getFalImageModel()} resolution=${getFalImageResolution()} `
      + `refMode=${getFalReferenceMode()} · ${cached}/${buffers.length} anchors cached, `
      + `${buffers.length - cached} to upload\n`,
    );
  }

  process.stdout.write(`Scene:     ${scene.id} (${scene.framing}, hands: ${scene.handState})\n`);
  process.stdout.write(`Geometry:  ${width}x${height} (${imageAspectRatio()})\n`);
  process.stdout.write(`Identity:  ${JSON.stringify(resolveIdentity(), null, 2)}\n\n`);
}

/** Everything short of actually spending money. */
function dryRun(scene: Scene): void {
  const { width, height } = imageDimensions();
  const anchors = loadAnchors();
  const basePrompt = buildPrompt(scene);
  const prompt = anchors.length > 0 ? `${basePrompt}\n\n${ANCHOR_PROMPT_NOTE}` : basePrompt;

  process.stdout.write(`Prompt that would be sent:\n${prompt}\n\n`);

  if (!getFalKey()) {
    process.stdout.write('No FAL_KEY set — nothing to preview for fal. Set it in .env to see the request body.\n');
    return;
  }

  const resolution = getFalImageResolution();
  const body = buildRequestBody(
    { prompt, width, height, seed: 123456, aspectRatio: imageAspectRatio() },
    { resolution, imageUrls: anchors.map((_, i) => `<uploaded-anchor-${i + 1}>`) },
  );
  const preview = { ...body, prompt: `${String(body.prompt).slice(0, 100)}… (${String(body.prompt).length} chars)` };

  process.stdout.write(`Request body (fal):\n${JSON.stringify(preview, null, 2)}\n\n`);
  process.stdout.write(`Would cost: $${priceFor(getFalImageModel(), resolution)} per attempt\n`);
  if (getFalReferenceMode() === 'upload' && anchors.length > 0) {
    process.stdout.write(
      'Style anchors would upload via fal CDN (rest.fal.ai initiate + PUT) '
      + 'and must resolve to https:// URLs before image_urls is set.\n',
    );
  }
  process.stdout.write('DRY RUN — nothing generated, nothing spent.\n');
}

async function main(): Promise<void> {
  getDb();

  const args = process.argv.slice(2);
  const judgeIdx = args.indexOf('--judge');
  if (judgeIdx !== -1) {
    await judgeOnly(args[judgeIdx + 1]);
    return;
  }

  const dry = args.includes('--dry');
  const free = args.includes('--free');
  // Pin the free provider before the chain is built.
  if (free) process.env.IMAGE_PROVIDER = 'pollinations';

  const sceneId = args.find((a) => !a.startsWith('--'));
  const scene = sceneId ? getScene(sceneId) : pickScene();
  if (!scene) {
    process.stdout.write(`Unknown scene "${sceneId}". Available:\n`);
    for (const s of allScenes()) process.stdout.write(`  ${s.id} (${s.framing}, hands: ${s.handState})\n`);
    process.exitCode = 1;
    return;
  }

  printHeader(scene);

  if (dry) { dryRun(scene); return; }

  const chain = buildImageProviders();
  const cost = chain[0]?.costPerImageUsd() ?? 0;
  process.stdout.write(cost > 0
    ? `This run will spend ~$${cost} on ${chain[0].name}.\n\n`
    : 'This run is free.\n\n');

  const image = await generateImage(scene);
  process.stdout.write(`Generated: ${image.filePath}\n`);
  process.stdout.write(`  model:   ${image.model}\n`);
  process.stdout.write(`  seed:    ${image.seed}\n`);

  // Ratio-based providers (fal, Gemini) take an aspect + size tier, not pixels,
  // so an exact pixel match is not expected — only the ratio should hold.
  const wanted = ratioOf(imageAspectRatio());
  const got = image.height > 0 ? image.width / image.height : null;
  const ratioOk = wanted !== null && got !== null && Math.abs(got - wanted) / wanted <= 0.02;
  process.stdout.write(`  decoded: ${image.width}x${image.height}`);
  process.stdout.write(ratioOk
    ? ` (${imageAspectRatio()} as requested)\n\n`
    : ` ** RATIO MISMATCH — wanted ${imageAspectRatio()} **\n\n`);

  process.stdout.write(`Final prompt:\n${image.prompt}\n\n`);

  const verdict = await judgeImage(image.filePath);
  if (!verdict) {
    process.stdout.write('QA gate unavailable (Claude CLI missing or disabled) — image would post as-is\n');
    return;
  }
  process.stdout.write(`QA verdict: ${JSON.stringify(verdict, null, 2)}\n\n`);
  process.stdout.write(isRejected(verdict)
    ? `REJECTED (${rejectionReason(verdict)}) — would retry with a safer framing\n`
    : 'ACCEPTED — would post\n');
}

main().catch((err) => {
  process.stdout.write(`image probe failed: ${String(err)}\n`);
  process.exit(1);
});
