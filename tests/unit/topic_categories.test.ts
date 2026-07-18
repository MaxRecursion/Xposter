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
  TOPIC_CATEGORIES,
} from '../../src/pipeline/topic_categories.js';

describe('getCategoryWeights', () => {
  beforeEach(() => {
    mockSettings.clear();
  });

  it('returns defaults when setting is missing', () => {
    const w = getCategoryWeights();
    expect(w['pune-tech-economy']).toBeCloseTo(0.25);
    expect(w['local-pune']).toBeCloseTo(0.10);
    expect(w['tech']).toBeCloseTo(0.28);
    expect(w['observation']).toBeCloseTo(0.05);
  });

  it('respects user-provided JSON', () => {
    mockSettings.set('topic_category_weights', JSON.stringify({
      'pune-tech-economy': 0.25,
      'local-pune': 0.10,
      'tech': 0.50,
      'politics': 0,
      'sports': 0.15,
      'culture': 0,
      'observation': 0,
    }));
    const w = getCategoryWeights();
    expect(w['pune-tech-economy']).toBeCloseTo(0.25);
    expect(w['local-pune']).toBeCloseTo(0.10);
    expect(w['tech']).toBeCloseTo(0.50);
    expect(w['sports']).toBeCloseTo(0.15);
  });

  it('adds the strategic Pune tech economy share for legacy settings', () => {
    mockSettings.set('topic_category_weights', JSON.stringify({
      'local-pune': 0.30, 'tech': 0.20, 'politics': 0.10, 'sports': 0.15, 'culture': 0.15, 'observation': 0.10,
    }));
    const w = getCategoryWeights();
    expect(w['pune-tech-economy']).toBeCloseTo(0.25);
    const total = TOPIC_CATEGORIES.reduce((sum, cat) => sum + w[cat], 0);
    expect(total).toBeCloseTo(1);
  });

  it('falls back to defaults on malformed JSON', () => {
    mockSettings.set('topic_category_weights', '{not json');
    const w = getCategoryWeights();
    expect(w['pune-tech-economy']).toBeCloseTo(0.25);
    expect(w['local-pune']).toBeCloseTo(0.10);
  });

  it('falls back to defaults on all-zero weights', () => {
    mockSettings.set('topic_category_weights', JSON.stringify({
      'local-pune': 0, 'tech': 0, 'politics': 0, 'sports': 0, 'culture': 0, 'observation': 0,
    }));
    const w = getCategoryWeights();
    expect(w['pune-tech-economy']).toBeGreaterThan(0);
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
    expect(TOPIC_CATEGORIES).toContain(spec.category);
  });

  it('weights extreme tech setting toward tech topics', () => {
    mockSettings.set('topic_category_weights', JSON.stringify({
      'local-pune': 0, 'tech': 1, 'politics': 0, 'sports': 0, 'culture': 0, 'observation': 0,
      'pune-tech-economy': 0,
    }));
    const samples = Array.from({ length: 30 }, () => pickTopicAndCategory());
    const techCount = samples.filter((s) => s.category === 'tech').length;
    expect(techCount).toBe(30);
  });

  it('does not pivot the bot toward only Pune topics by default', () => {
    // The default mix still includes non-local categories alongside the
    // Pune tech/economy lane.
    const samples = Array.from({ length: 60 }, () => pickTopicAndCategory());
    const punecount = samples.filter((s) => s.category === 'local-pune').length;
    expect(punecount).toBeLessThan(60);
    const nonPune = samples.filter((s) => s.category !== 'local-pune').length;
    expect(nonPune).toBeGreaterThan(0);
  });

  it('weights extreme strategic setting toward Pune tech economy topics', () => {
    mockSettings.set('topic_category_weights', JSON.stringify({
      'pune-tech-economy': 1, 'local-pune': 0, 'tech': 0, 'politics': 0, 'sports': 0, 'culture': 0, 'observation': 0,
    }));
    const samples = Array.from({ length: 30 }, () => pickTopicAndCategory());
    expect(samples.every((s) => s.category === 'pune-tech-economy')).toBe(true);
    expect(samples.some((s) => /AI|Pune|Maharashtra|RBI|Hinjewadi|startup/i.test(s.topic))).toBe(true);
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
