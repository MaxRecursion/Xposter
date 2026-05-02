import { describe, it, expect } from 'vitest';
import { pickFlavor } from '../../src/pipeline/generator.js';

describe('pickFlavor', () => {
  it('returns pune for tweets explicitly mentioning Pune', () => {
    expect(pickFlavor('Pune traffic is insane today')).toBe('pune');
    expect(pickFlavor('Why does PMC always do this in monsoon?')).toBe('pune');
  });

  it('returns pune for Marathi tweets mentioning पुणे', () => {
    expect(pickFlavor('पुण्यात आज खूप पाऊस आहे')).toBe('pune');
  });

  it('returns pune when a Pune neighbourhood is mentioned', () => {
    expect(pickFlavor('Just got home from Hinjewadi, what a commute')).toBe('pune');
    expect(pickFlavor('Koregaon Park is unusually quiet on a Friday')).toBe('pune');
  });

  it('returns general for tweets about cricket', () => {
    expect(pickFlavor('India batting collapse in the third innings was painful')).toBe('general');
  });

  it('returns general for tech tweets', () => {
    expect(pickFlavor('Anthropic released Claude 4.7 today, benchmarks look strong')).toBe('general');
  });

  it('returns general for politics tweets without Pune mention', () => {
    expect(pickFlavor('Parliament session ended without passing any bill')).toBe('general');
  });

  it('returns general even when traffic / metro tags fire without Pune context', () => {
    // 'Traffic' alone doesn't mean Pune.
    expect(pickFlavor('Bangalore traffic is genuinely worse than Mumbai now')).toBe('general');
    // Generic 'metro' is not enough.
    expect(pickFlavor('NYC subway delays are an inherited curse at this point')).toBe('general');
  });

  it('returns general for short tweets with no signal', () => {
    expect(pickFlavor('this is fine')).toBe('general');
  });
});
