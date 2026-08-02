import { describe, expect, it, vi } from 'vitest';

// The scheduler pulls in the DB via settings; stub the storage layer so this
// stays a pure test of the ladder.
vi.mock('../../src/storage/settings.js', () => ({
  getBooleanSetting: () => true,
  getIntSetting: (_k: string, fallback: number) => fallback,
  getFloatSetting: (_k: string, fallback: number) => fallback,
  getListSetting: () => [],
  getSetting: (_k: string, fallback: string) => fallback,
}));

const { attemptOptions } = await import('../../src/scheduler/image_posts.js');
const { allScenes, SAFE_SCENE_IDS } = await import('../../src/images/generator.js');

const scene = allScenes().find((s) => s.framing === 'back-three-quarter')!;

describe('attemptOptions', () => {
  it('uses the scene unchanged on the first attempt', () => {
    const out = attemptOptions(1, 3, scene);
    expect(out.scene.id).toBe(scene.id);
    expect(out.options).toEqual({});
  });

  it('forces a silhouette with hidden hands on the middle attempt', () => {
    // The failures are systematic — the model cannot draw hands — so a retry
    // removes what it keeps getting wrong rather than just rerolling.
    const out = attemptOptions(2, 3, scene);
    expect(out.scene.id).toBe(scene.id);
    expect(out.options).toEqual({ framing: 'silhouette', handState: 'hidden' });
  });

  it('falls back to a no-person still life on the last attempt', () => {
    const out = attemptOptions(3, 3, scene);
    expect(SAFE_SCENE_IDS).toContain(out.scene.id);
    expect(out.scene.framing).toBe('no-person');
  });

  it('still reaches the safe scene when only two attempts are configured', () => {
    // The whole point of keying to maxAttempts: with a hardcoded `attempt === 2`
    // check, lowering image_qa_max_attempts to 2 silently dropped the
    // highest-pass-rate composition entirely.
    const out = attemptOptions(2, 2, scene);
    expect(SAFE_SCENE_IDS).toContain(out.scene.id);
  });

  it('degenerates safely at a single attempt', () => {
    const out = attemptOptions(1, 1, scene);
    expect(out.scene.id).toBe(scene.id);
  });

  it('keeps the silhouette rung available at four attempts', () => {
    expect(attemptOptions(2, 4, scene).options).toEqual({ framing: 'silhouette', handState: 'hidden' });
    expect(attemptOptions(3, 4, scene).options).toEqual({ framing: 'silhouette', handState: 'hidden' });
    expect(SAFE_SCENE_IDS).toContain(attemptOptions(4, 4, scene).scene.id);
  });
});
