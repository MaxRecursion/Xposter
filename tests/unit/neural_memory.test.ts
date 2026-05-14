import { describe, it, expect } from 'vitest';
import {
  buildNeuralSchemaMemory,
  recallFromMemory,
  type MemoryEvent,
} from '../../src/context/neural_memory.js';

const now = Math.floor(Date.now() / 1000);

function event(overrides: Partial<MemoryEvent>): MemoryEvent {
  return {
    kind: 'original',
    text: 'AI jobs in Pune are changing how tech teams hire.',
    topic: 'AI jobs in Pune',
    contextText: null,
    createdAt: now - 3600,
    engagement: 0,
    ...overrides,
  };
}

describe('NeuralSchemaMemory', () => {
  it('builds weighted concept nodes and co-occurrence edges', () => {
    const memory = buildNeuralSchemaMemory([
      event({ engagement: 50 }),
      event({
        text: 'Pune founders are using AI agents before adding headcount.',
        topic: 'Pune founders building with AI',
        engagement: 20,
      }),
    ], now);

    expect(memory.nodes.map((n) => n.key)).toEqual(expect.arrayContaining(['ai', 'jobs', 'pune-area', 'startup']));
    expect(memory.edges.some((e) => [e.from, e.to].includes('ai') && [e.from, e.to].includes('pune-area'))).toBe(true);
  });

  it('recalls relevant old originals and replies for Pune AI jobs queries', () => {
    const memory = buildNeuralSchemaMemory([
      event({
        kind: 'reply',
        text: 'Hinjewadi hiring now looks less like headcount planning and more like automation triage.',
        topic: 'Hinjewadi commute and AI jobs',
        engagement: 40,
      }),
      event({
        text: 'IPL auctions are pure economics with better graphics.',
        topic: 'IPL season',
        engagement: 120,
      }),
    ], now);

    const recall = recallFromMemory(memory, 'How AI is changing jobs in Pune tech companies', {
      maxItems: 2,
    });

    expect(recall).not.toBeNull();
    expect(recall!.activatedConcepts).toEqual(expect.arrayContaining(['ai', 'jobs', 'pune-area']));
    expect(recall!.promptBlock).toContain('Hinjewadi hiring');
    expect(recall!.promptBlock).not.toContain('IPL auctions');
    expect(recall!.promptBlock).toContain('do not repeat exact wording');
  });

  it('returns null when no useful concepts are available', () => {
    const memory = buildNeuralSchemaMemory([
      event({ text: 'Beautiful sunset today.', topic: 'sunset', contextText: null }),
    ], now);
    expect(recallFromMemory(memory, 'nice evening')).toBeNull();
  });
});
