import { describe, expect, it, beforeEach } from 'vitest';
import {
  checkHumanLikeness,
  detectContentStructure,
  findBannedOpener,
  findBannedPhrase,
  humanLikenessScore,
  pickBestCandidate,
} from '../../src/pipeline/human_likeness.js';

describe('human_likeness slop detection', () => {
  beforeEach(async () => {
    const { setSetting } = await import('../../src/storage/settings.js');
    setSetting('human_likeness_gate', 'true');
  });

  it('rejects known AI-slop phrases', () => {
    expect(findBannedPhrase('At the end of the day, PMC failed again.')).toBe('at the end of the day');
    expect(checkHumanLikeness('Let us delve into the metro delay.')).toContain('delve');
  });

  it('rejects implicit bait template openers', () => {
    expect(findBannedOpener('The part about Hinjewadi salaries nobody says out loud', 'implicit')).toBeTruthy();
    expect(findBannedOpener('Change my mind: PMC is broken', 'implicit')).toBeTruthy();
    expect(findBannedOpener('Change my mind: PMC is broken', 'explicit')).toBeNull();
  });

  it('rejects too many rhetorical questions', () => {
    expect(checkHumanLikeness('Why? When? How? Really?')).toContain('rhetorical');
  });
});

describe('detectContentStructure', () => {
  it('classifies one-liners', () => {
    expect(detectContentStructure('PMC drainage is a group prayer.')).toBe('one_liner');
  });

  it('classifies question hooks', () => {
    const text = 'Hinjewadi salaries look fine on paper until you add rent, fuel, and the 40-minute wait for a rickshaw at Phase 1. Who is actually living on them?';
    expect(detectContentStructure(text)).toBe('question_hook');
  });
});

describe('humanLikenessScore', () => {
  it('prefers specific, textured drafts over generic ones', () => {
    const generic = 'The city infrastructure situation is quite problematic overall.';
    const specific = "I've watched FC Road flood for 14 monsoons. PMC still hasn't fixed the drain near Westend.";
    const genericScore = humanLikenessScore(generic, { engagementMode: 'RAGEBAIT', flavor: 'pune' });
    const specificScore = humanLikenessScore(specific, { engagementMode: 'RAGEBAIT', flavor: 'pune' });
    expect(specificScore).toBeGreaterThan(genericScore);
  });
});

describe('pickBestCandidate', () => {
  it('picks the higher-scoring human draft', () => {
    const bland = 'Infrastructure is a challenge in many cities today.';
    const sharp = "Surely I'm not the only one who's waited 40 minutes at Hinjewadi Phase 1 for a rickshaw.";
    const picked = pickBestCandidate([bland, sharp], {
      engagementMode: 'RAGEBAIT',
      flavor: 'pune',
    });
    expect(picked.text).toBe(sharp);
  });
});
