import { describe, it, expect } from 'vitest';

import { charLength, fitToCharBudget } from '../../src/pipeline/text_constraints.js';

const HOOK = 'Nobody says the quiet part about Hinjewadi salaries out loud.';
const QUESTION = 'Who actually benefits from that gap?';
const MIDDLE = [
  'Recruiters quote a band that only the top two percent ever see.',
  'Everyone else negotiates against a number that was never real.',
  'The gap shows up in rents long before it shows up in payslips.',
];

const withSentences = [HOOK, ...MIDDLE, QUESTION].join(' ');

describe('fitToCharBudget', () => {
  it('returns text unchanged when it already fits', () => {
    const text = `${HOOK} ${QUESTION}`;
    expect(fitToCharBudget(text, 280)).toBe(text);
  });

  it('drops middle sentences but keeps the hook and the closing question', () => {
    const result = fitToCharBudget(withSentences, 150);

    expect(result).toBe(`${HOOK} ${QUESTION}`);
    expect(charLength(result!)).toBeLessThanOrEqual(150);
  });

  it('packs back as many middle sentences as the budget allows', () => {
    const result = fitToCharBudget(withSentences, 220)!;

    expect(charLength(result)).toBeLessThanOrEqual(220);
    expect(result.startsWith(HOOK)).toBe(true);
    expect(result.endsWith(QUESTION)).toBe(true);
    expect(result).toContain(MIDDLE[0]);
    expect(result).not.toContain(MIDDLE[2]);
  });

  it('keeps the closing question when the hook cannot fit alongside it', () => {
    const longHook = `${'Pune rents climbed again this quarter and nobody wants to say why. '.repeat(3)}`;
    const result = fitToCharBudget(`${longHook}${QUESTION}`, 100);

    expect(result).toBe(QUESTION);
  });

  it('clips a single runaway sentence at a word boundary and closes it', () => {
    const runaway = 'pune traffic policy is a slow motion failure that everyone narrates and nobody owns '.repeat(4);
    const result = fitToCharBudget(runaway, 280)!;

    expect(charLength(result)).toBeLessThanOrEqual(280);
    expect(result).toMatch(/[.!?]$/);
    expect(result).not.toMatch(/\s$/);
  });

  it('returns null when nothing survives above the minimum length', () => {
    expect(fitToCharBudget('A short line about Pune traffic and its costs.', 10, 20)).toBeNull();
  });

  it('returns null for blank input', () => {
    expect(fitToCharBudget('   ', 280)).toBeNull();
  });
});
