import { describe, expect, it } from 'vitest';
import {
  expandLinkedTopics,
  formatTopicWeb,
  isTopic,
} from '../../src/context/topic_graph.js';
import { rankRetrievedItems } from '../../src/context/retrieve/retriever.js';
import { recallBrainTopics } from '../../src/context/brain.js';
import type { RetrievedContextItem } from '../../src/context/types.js';

describe('topic graph', () => {
  it('expands traffic into metro, roads, and civic neighbors', () => {
    const linked = expandLinkedTopics(['traffic']);
    expect(linked).toEqual(expect.arrayContaining(['traffic', 'metro', 'roads', 'civic', 'pune-area']));
  });

  it('expands AI into jobs and tech', () => {
    const linked = expandLinkedTopics(['ai']);
    expect(linked).toEqual(expect.arrayContaining(['ai', 'jobs', 'tech', 'startup']));
  });

  it('formats a topic web for prompts', () => {
    const seed = expandLinkedTopics(['traffic']).filter((t) => t === 'traffic');
    const web = formatTopicWeb(['traffic'], expandLinkedTopics(['traffic']));
    expect(web).toContain('traffic →');
    expect(web).toContain('metro');
    expect(seed).toEqual(['traffic']);
  });

  it('ignores unknown tags', () => {
    expect(isTopic('traffic')).toBe(true);
    expect(isTopic('gossip')).toBe(false);
    expect(expandLinkedTopics(['gossip'])).toEqual([]);
  });
});

describe('linked-topic retrieval ranking', () => {
  const now = 1_700_000_000;

  function item(partial: Partial<RetrievedContextItem>): RetrievedContextItem {
    return {
      itemId: partial.itemId ?? 'x',
      source: 'rss:indian-express-pune',
      sourceUrl: null,
      title: partial.title ?? 't',
      body: partial.body ?? 'b',
      language: 'english',
      topics: partial.topics ?? '[]',
      publishedAt: now - 3600,
      fetchedAt: now,
      credibility: 0.8,
      distance: partial.distance ?? 0.4,
      ...partial,
    };
  }

  it('prefers a metro item over an unrelated one for a traffic query', () => {
    const ranked = rankRetrievedItems([
      item({ itemId: 'unrelated', topics: '["sports"]', distance: 0.3, title: 'IPL' }),
      item({ itemId: 'metro', topics: '["metro","pune-area"]', distance: 0.5, title: 'Metro' }),
    ], {
      queryTopics: ['traffic'],
      linkedTopics: expandLinkedTopics(['traffic']),
      nowSec: now,
    });
    expect(ranked[0].item.itemId).toBe('metro');
    expect(ranked[0].topicOverlap).toBeGreaterThan(0);
  });
});

describe('brain recall', () => {
  it('emits a topic-brain prompt block for a Pune traffic tweet', () => {
    const recall = recallBrainTopics('Traffic near Hinjewadi is stuck again after last night rain.');
    expect(recall.seedTopics).toEqual(expect.arrayContaining(['traffic']));
    expect(recall.linkedTopics).toEqual(expect.arrayContaining(['metro', 'roads']));
    expect(recall.promptBlock).toContain('[TOPIC BRAIN]');
    expect(recall.promptBlock).toContain('Related topics:');
  });
});
