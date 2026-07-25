import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// The identity resolver reads a DB setting; stub it so these stay pure.
vi.mock('../../src/storage/settings.js', () => ({
  getSetting: () => '',
  getBooleanSetting: () => true,
  getIntSetting: (_k: string, fallback: number) => fallback,
  getListSetting: () => [],
  getFloatSetting: (_k: string, fallback: number) => fallback,
}));

const { allScenes, buildPrompt, imageDimensions, pickSafeScene, SAFE_SCENE_IDS } =
  await import('../../src/images/generator.js');
const { DEFAULT_IDENTITY, renderIdentity, resolveIdentity } =
  await import('../../src/images/identity.js');

describe('scene catalogue', () => {
  it('has no scene that puts hands, food or text in frame', () => {
    // These are the exact compositions that produced merged fingers and garbled
    // signage in the original catalogue.
    const banned = /\b(eating|rickshaw|book|bookstore|sign|signage|mirror|typing|bicycle|sticky note|screen text)\b/i;
    for (const scene of allScenes()) {
      expect(scene.description, `scene ${scene.id}`).not.toMatch(banned);
    }
  });

  it('never uses a framing that could show a face', () => {
    const faceless = ['back-three-quarter', 'from-behind', 'silhouette', 'crop-below-chin', 'detail-crop', 'no-person'];
    for (const scene of allScenes()) {
      expect(faceless, `scene ${scene.id}`).toContain(scene.framing);
    }
  });

  it('includes no-person fallback scenes for the QA retry ladder', () => {
    const ids = allScenes().map((s) => s.id);
    for (const safe of SAFE_SCENE_IDS) expect(ids).toContain(safe);
    expect(pickSafeScene().framing).toBe('no-person');
  });
});

describe('buildPrompt', () => {
  it('carries the identity, a framing clause and the exclusions for every scene', () => {
    for (const scene of allScenes()) {
      const prompt = buildPrompt(scene);
      expect(prompt, scene.id).toContain('The frame excludes her face entirely');
      expect(prompt, scene.id).toContain('no signage, lettering or readable text');
      expect(prompt, scene.id).toContain('She is the only person in the frame');
      expect(prompt, scene.id).toContain(DEFAULT_IDENTITY.film);
      expect(prompt, scene.id).toContain(DEFAULT_IDENTITY.lens);
    }
  });

  it('includes the wardrobe and props on scenes with a person', () => {
    const withPerson = allScenes().filter((s) => s.framing !== 'no-person');
    for (const scene of withPerson) {
      expect(buildPrompt(scene), scene.id).toContain(DEFAULT_IDENTITY.hair);
      expect(buildPrompt(scene), scene.id).toContain(DEFAULT_IDENTITY.accessory);
    }
  });

  it('drops the person entirely for no-person scenes', () => {
    const stillLife = allScenes().find((s) => s.framing === 'no-person')!;
    const prompt = buildPrompt(stillLife);
    expect(prompt).toContain('still life');
    expect(prompt).not.toContain('A young Indian woman');
  });

  it('lets the QA retry ladder override framing and hands', () => {
    const scene = allScenes().find((s) => s.framing === 'back-three-quarter')!;
    const prompt = buildPrompt(scene, { framing: 'silhouette', handState: 'hidden' });
    expect(prompt).toContain('dark silhouette');
    expect(prompt).toContain('hands not visible');
  });

  it('slots a detail sentence in without breaking the exclusions', () => {
    const scene = allScenes()[0];
    const prompt = buildPrompt(scene, { detail: 'amber streetlight halos on wet asphalt' });
    expect(prompt).toContain('amber streetlight halos on wet asphalt');
    expect(prompt).toContain('The frame excludes her face entirely');
  });

  it('never emits a doubled period from the template joins', () => {
    for (const scene of allScenes()) {
      expect(buildPrompt(scene), scene.id).not.toMatch(/\.\./);
    }
  });
});

describe('identity resolution', () => {
  const originalEnv = process.env.IMAGE_CHARACTER_PROMPT;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.IMAGE_CHARACTER_PROMPT;
    else process.env.IMAGE_CHARACTER_PROMPT = originalEnv;
  });

  it('falls back to the built-in card', () => {
    delete process.env.IMAGE_CHARACTER_PROMPT;
    expect(resolveIdentity()).toEqual(DEFAULT_IDENTITY);
  });

  it('honours IMAGE_CHARACTER_PROMPT, which the old prompt builder ignored', () => {
    process.env.IMAGE_CHARACTER_PROMPT = 'a tall man in a linen shirt';
    const identity = resolveIdentity();
    expect(renderIdentity(identity)).toContain('a tall man in a linen shirt');
    expect(renderIdentity(identity)).not.toContain(DEFAULT_IDENTITY.wardrobe);
  });
});

describe('geometry', () => {
  const originals = { w: process.env.IMAGE_WIDTH, h: process.env.IMAGE_HEIGHT };
  beforeEach(() => {
    delete process.env.IMAGE_WIDTH;
    delete process.env.IMAGE_HEIGHT;
  });
  afterEach(() => {
    if (originals.w === undefined) delete process.env.IMAGE_WIDTH; else process.env.IMAGE_WIDTH = originals.w;
    if (originals.h === undefined) delete process.env.IMAGE_HEIGHT; else process.env.IMAGE_HEIGHT = originals.h;
  });

  it('defaults to a 4:5 portrait under the provider pixel budget', () => {
    const { width, height } = imageDimensions();
    expect(width / height).toBeCloseTo(0.8, 5);
    // Pollinations downscales anything above roughly 590k pixels.
    expect(width * height).toBeLessThan(590_000);
    // SANA's latent grid is 32px.
    expect(width % 32).toBe(0);
    expect(height % 32).toBe(0);
  });

  it('is overridable by env', () => {
    process.env.IMAGE_WIDTH = '512';
    process.env.IMAGE_HEIGHT = '512';
    expect(imageDimensions()).toEqual({ width: 512, height: 512 });
  });

  it('ignores garbage env values', () => {
    process.env.IMAGE_WIDTH = 'abc';
    process.env.IMAGE_HEIGHT = '-5';
    expect(imageDimensions()).toEqual({ width: 640, height: 800 });
  });
});
