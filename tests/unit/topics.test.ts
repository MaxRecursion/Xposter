import { describe, it, expect } from 'vitest';
import { detectTopics, parseTopics, topicsAsJson } from '../../src/context/topics.js';

describe('detectTopics', () => {
  it('returns empty for empty input', () => {
    expect(detectTopics('')).toEqual([]);
  });

  it('detects monsoon from English', () => {
    expect(detectTopics('Heavy rain causing flooding in Pune')).toContain('monsoon');
  });

  it('detects monsoon from Marathi', () => {
    expect(detectTopics('पुण्यात मुसळधार पाऊस')).toContain('monsoon');
  });

  it('detects traffic with multiple keywords', () => {
    expect(detectTopics('Massive traffic jam at FC Road junction')).toEqual(
      expect.arrayContaining(['traffic', 'roads']),
    );
  });

  it('detects PMC and civic together', () => {
    const tags = detectTopics('PMC announces water cut tomorrow in Kothrud');
    expect(tags).toEqual(expect.arrayContaining(['pmc', 'civic', 'pune-area']));
  });

  it('detects metro', () => {
    expect(detectTopics('Pune Metro extends operating hours')).toContain('metro');
    expect(detectTopics('मेट्रो वेळापत्रक')).toContain('metro');
  });

  it('detects political tags carefully', () => {
    expect(detectTopics('NCP rally in Pune today')).toContain('politics');
    expect(detectTopics('Devendra Fadnavis spoke in Pune')).toContain('politics');
  });

  it('detects festival tags', () => {
    expect(detectTopics('Ganpati visarjan procession route')).toContain('festival');
  });

  it('detects sports tags', () => {
    expect(detectTopics('IPL final run chase goes to the last over')).toContain('sports');
    expect(detectTopics('India test match wicket on day three')).toContain('sports');
  });

  it('detects AI, jobs, startup, and economy signals', () => {
    const tags = detectTopics('AI automation is changing hiring for Pune startup teams as RBI rates affect funding');
    expect(tags).toEqual(expect.arrayContaining(['ai', 'jobs', 'startup', 'economy', 'pune-area']));
  });

  it('detects Maharashtra economic geography', () => {
    const tags = detectTopics('Maharashtra manufacturing around Chakan and Talegaon is watching automation closely');
    expect(tags).toEqual(expect.arrayContaining(['maharashtra', 'economy', 'ai']));
  });

  it('does not over-tag generic text', () => {
    const tags = detectTopics('Beautiful sunset over the Mula river');
    expect(tags).not.toContain('traffic');
    expect(tags).not.toContain('politics');
  });

  it('returns unique tags only', () => {
    const tags = detectTopics('rain rain rain monsoon flood waterlogging');
    expect(tags.filter((t) => t === 'monsoon').length).toBe(1);
  });
});

describe('topicsAsJson / parseTopics roundtrip', () => {
  it('encodes and decodes', () => {
    const tags = detectTopics('PMC fixes pothole on FC Road');
    const json = topicsAsJson(tags);
    const back = parseTopics(json);
    expect(back).toEqual(tags);
  });

  it('returns [] for invalid JSON', () => {
    expect(parseTopics('{not-json')).toEqual([]);
    expect(parseTopics(null)).toEqual([]);
    expect(parseTopics(undefined)).toEqual([]);
  });

  it('filters non-string entries', () => {
    expect(parseTopics('["traffic", 123, null, "monsoon"]')).toEqual(['traffic', 'monsoon']);
  });
});
