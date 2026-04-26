import { describe, it, expect } from 'vitest';
import { detectLanguage, filterPost, isDuplicate } from '../../src/pipeline/filter.js';

describe('detectLanguage', () => {
  it('detects Marathi from explicit markers', () => {
    expect(detectLanguage('पुणे मध्ये आज पाऊस आहे')).toBe('marathi');
    expect(detectLanguage('वाहतूक जाम आहे रस्त्यावर')).toBe('marathi');
    expect(detectLanguage('आज खूप पाऊस झाला पुण्यात')).toBe('marathi');
  });

  it('detects English', () => {
    expect(detectLanguage('Heavy rain in Pune today, roads are flooded')).toBe('english');
    expect(detectLanguage('Traffic jam on the expressway near Pune')).toBe('english');
  });

  it('returns unknown for very short text', () => {
    expect(detectLanguage('')).toBe('unknown');
    expect(detectLanguage('hi')).toBe('unknown');
  });

  it('does not confuse Hindi with Marathi on Marathi markers', () => {
    // Text with Marathi-specific words should come back as marathi
    const text = 'पुण्यात आज पाऊस होता आणि वाहतूक जाम होती';
    expect(detectLanguage(text)).toBe('marathi');
  });
});

describe('filterPost', () => {
  it('passes Marathi post with Pune keyword', () => {
    const r = filterPost('पुणे मध्ये आज पाऊस खूप आहे');
    expect(r.pass).toBe(true);
    expect(r.language).toBe('marathi');
    expect(r.matchedKeywords.length).toBeGreaterThan(0);
  });

  it('passes English post with traffic keyword', () => {
    const r = filterPost('Terrible traffic near Hinjewadi Pune today');
    expect(r.pass).toBe(true);
    expect(r.language).toBe('english');
  });

  it('rejects unknown language post', () => {
    const r = filterPost('こんにちは東京');
    expect(r.pass).toBe(false);
    expect(r.reason).toContain('unsupported language');
  });

  it('passes any Marathi post even without explicit topic keywords', () => {
    const r = filterPost('आज खूप छान वाटतंय आणि सगळं ठीक आहे');
    expect(r.pass).toBe(true);
    expect(r.language).toBe('marathi');
  });

  it('rejects off-topic English post', () => {
    const r = filterPost('Great movie I watched last night, really enjoyed it');
    expect(r.pass).toBe(false);
    expect(r.reason).toBe('no topic match');
  });

  it('accepts custom keywords', () => {
    const r = filterPost('The festival at MG Road was amazing', ['mg road']);
    expect(r.pass).toBe(true);
  });

  it('matches waterlogging keyword', () => {
    const r = filterPost('Waterlogging near Swargate area in Pune');
    expect(r.pass).toBe(true);
    expect(r.matchedKeywords).toContain('waterlog');
  });
});

describe('isDuplicate', () => {
  it('detects near-duplicate posts', () => {
    const existing = ['Heavy rain in Pune today, roads are very badly flooded'];
    const newText  = 'Heavy rain in Pune today, roads are very badly flooded';
    expect(isDuplicate(newText, existing)).toBe(true);
  });

  it('does not flag different posts as duplicates', () => {
    const existing = ['It is raining in Mumbai'];
    const newText  = 'Traffic is terrible near Hinjewadi Pune';
    expect(isDuplicate(newText, existing)).toBe(false);
  });

  it('returns false for empty existing list', () => {
    expect(isDuplicate('Any text here', [])).toBe(false);
  });
});
