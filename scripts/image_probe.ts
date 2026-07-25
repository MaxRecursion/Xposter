/**
 * Dry-run: generate one image with the current prompt template and geometry,
 * run it through the vision QA gate, and report the verdict. No DB write, no
 * post — the file is left in data/images/ for inspection.
 *
 *   npm run image:probe               # random scene
 *   npm run image:probe -- cafe_window_rain
 *   npm run image:probe -- --judge data/images/some_existing.jpg
 */
import '../src/env.js';
import path from 'path';
import { getDb } from '../src/storage/db.js';
import {
  allScenes, buildPrompt, generateImage, getScene, imageAspectRatio, imageDimensions, pickScene,
} from '../src/images/generator.js';
import { resolveIdentity } from '../src/images/identity.js';
import { listAnchorPaths } from '../src/images/anchors.js';
import { buildImageProviders } from '../src/images/providers/index.js';
import { budgetStatus } from '../src/storage/image_budget.js';
import { isRejected, judgeImage, rejectionReason } from '../src/images/vision_qa.js';

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

async function main(): Promise<void> {
  getDb();

  const args = process.argv.slice(2);
  const judgeIdx = args.indexOf('--judge');
  if (judgeIdx !== -1) {
    await judgeOnly(args[judgeIdx + 1]);
    return;
  }

  const sceneId = args[0];
  const scene = sceneId ? getScene(sceneId) : pickScene();
  if (!scene) {
    process.stdout.write(`Unknown scene "${sceneId}". Available:\n`);
    for (const s of allScenes()) process.stdout.write(`  ${s.id} (${s.framing}, hands: ${s.handState})\n`);
    process.exitCode = 1;
    return;
  }

  const { width, height } = imageDimensions();
  const providers = buildImageProviders();
  const budget = budgetStatus();
  const anchors = listAnchorPaths();

  process.stdout.write(`Providers: ${providers.map((p) => `${p.name}($${p.costPerImageUsd()})`).join(' -> ') || '(none)'}\n`);
  process.stdout.write(`Budget:    $${budget.spentUsd} / $${budget.budgetUsd} spent this month (${budget.generations} generations)\n`);
  process.stdout.write(`Anchors:   ${anchors.length} style reference(s)${anchors.length ? ` — ${anchors.map((a) => a.split('/').pop()).join(', ')}` : ' (text-only identity)'}\n`);
  process.stdout.write(`Scene:     ${scene.id} (${scene.framing}, hands: ${scene.handState})\n`);
  process.stdout.write(`Geometry:  ${width}x${height} (${imageAspectRatio()})\n`);
  process.stdout.write(`Identity: ${JSON.stringify(resolveIdentity(), null, 2)}\n\n`);
  process.stdout.write(`Prompt (no detail sentence):\n${buildPrompt(scene)}\n\n`);

  const image = await generateImage(scene);
  process.stdout.write(`Generated: ${image.filePath}\n`);
  process.stdout.write(`  model:   ${image.model}\n`);
  process.stdout.write(`  seed:    ${image.seed}\n`);
  process.stdout.write(`  decoded: ${image.width}x${image.height}`);
  process.stdout.write(image.width === width && image.height === height ? ' (as requested)\n\n' : ' ** RESIZED BY PROVIDER **\n\n');
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
