import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock storage layer so we can drive settings + recent topics + performance
const mockSettings = new Map<string, string>();
const mockRecent: Array<{ topic: string }> = [];
const mockPerf: Array<{ topic: string; engagement_score: number }> = [];

vi.mock('../../src/storage/db.js', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      all: (_n: number) => {
        if (sql.includes('FROM original_posts')) return mockRecent;
        return [];
      },
    }),
  }),
}));

vi.mock('../../src/storage/queries.js', () => ({
  getSetting: (key: string, fallback: string) => mockSettings.get(key) ?? fallback,
}));

vi.mock('../../src/storage/original_posts.js', () => ({
  getTopicPerformance: () => mockPerf,
}));

vi.mock('../../src/context/enrich.js', () => ({
  isContextEnabled: () => false,
}));

vi.mock('../../src/context/trends.js', () => ({
  getVelocityMap: () => new Map(),
}));

import {
  getCategoryWeights,
  pickTopicAndCategory,
  getRecentTopics,
} from '../../src/pipeline/topic_categories.js';

describe('getCategoryWeights', () => {
  beforeEach(() => {
    mockSettings.clear();
  });

  it('returns defaults when setting is missing', () => {
    const w = getCategoryWeights();
    expect(w['local-pune']).toBeCloseTo(0.30);
    expect(w['tech']).toBeCloseTo(0.20);
    expect(w['observation']).toBeCloseTo(0.10);
  });

  it('respects user-provided JSON', () => {
    mockSettings.set('topic_category_weights', JSON.stringify({
      'local-pune': 0.10, 'tech': 0.50, 'sports': 0.40,
    }));
    const w = getCategoryWeights();
    expect(w['local-pune']).toBeCloseTo(0.10);
    expect(w['tech']).toBeCloseTo(0.50);
    expect(w['sports']).toBeCloseTo(0.40);
  });

  it('falls back to defaults on malformed JSON', () => {
    mockSettings.set('topic_category_weights', '{not json');
    const w = getCategoryWeights();
    expect(w['local-pune']).toBeCloseTo(0.30);
  });

  it('falls back to defaults on all-zero weights', () => {
    mockSettings.set('topic_category_weights', JSON.stringify({
      'local-pune': 0, 'tech': 0, 'politics': 0, 'sports': 0, 'culture': 0, 'observation': 0,
    }));
    const w = getCategoryWeights();
    expect(w['local-pune']).toBeGreaterThan(0);
  });
});

describe('pickTopicAndCategory', () => {
  beforeEach(() => {
    mockSettings.clear();
    mockRecent.length = 0;
    mockPerf.length = 0;
  });

  it('returns a valid topic and category', () => {
    const spec = pickTopicAndCategory();
    expect(typeof spec.topic).toBe('string');
    expect(spec.topic.length).toBeGreaterThan(0);
    expect(['local-pune','tech','politics','sports','culture','observation']).toContain(spec.category);
  });

  it('weights extreme tech setting toward tech topics', () => {
    mockSettings.set('topic_category_weights', JSON.stringify({
      'local-pune': 0, 'tech': 1, 'politics': 0, 'sports': 0, 'culture': 0, 'observation': 0,
    }));
    const samples = Array.from({ length: 30 }, () => pickTopicAndCategory());
    const techCount = samples.filter((s) => s.category === 'tech').length;
    expect(techCount).toBe(30);
  });

  it('does not pivot the bot toward only Pune topics by default', () => {
    // 30% local-pune means roughly 21/30 should be non-Pune.
    const samples = Array.from({ length: 60 }, () => pickTopicAndCategory());
    const punecount = samples.filter((s) => s.category === 'local-pune').length;
    expect(punecount).toBeLessThan(60);
    const nonPune = samples.filter((s) => s.category !== 'local-pune').length;
    expect(nonPune).toBeGreaterThan(0);
  });
});

describe('getRecentTopics', () => {
  it('returns mocked recent topics', () => {
    mockRecent.length = 0;
    mockRecent.push({ topic: 'pune metro' }, { topic: 'AI hype cycle' });
    const topics = getRecentTopics();
    expect(topics).toEqual(['pune metro', 'AI hype cycle']);
  });
});
