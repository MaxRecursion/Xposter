import { describe, it, expect } from 'vitest';
import { extractProposalJson } from '../../src/agent/investigator.js';

describe('extractProposalJson', () => {
  const valid = {
    summary: 'Browser context expires after 12h',
    root_cause: 'session.ts holds the BrowserContext beyond its lifetime.',
    evidence: [{ file: 'src/browser/session.ts', line: 17, quote: 'let _context' }],
    proposed_fix: {
      description: 'Recreate the context if older than 6h',
      files_to_change: ['src/browser/session.ts'],
    },
    confidence: 0.75,
  };

  it('parses a clean fenced JSON block', () => {
    const text = '```json\n' + JSON.stringify(valid, null, 2) + '\n```';
    const p = extractProposalJson(text);
    expect(p).not.toBeNull();
    expect(p!.summary).toBe(valid.summary);
    expect(p!.proposed_fix.files_to_change).toEqual(['src/browser/session.ts']);
  });

  it('parses JSON with prose around it', () => {
    const text = `Here is my analysis:\n\`\`\`json\n${JSON.stringify(valid)}\n\`\`\`\nLet me know.`;
    const p = extractProposalJson(text);
    expect(p).not.toBeNull();
    expect(p!.confidence).toBe(0.75);
  });

  it('parses bare JSON (no fence)', () => {
    const text = `Analysis: ${JSON.stringify(valid)}`;
    const p = extractProposalJson(text);
    expect(p).not.toBeNull();
  });

  it('returns null when summary is missing', () => {
    const broken = { ...valid, summary: undefined } as Record<string, unknown>;
    delete broken.summary;
    const p = extractProposalJson('```json\n' + JSON.stringify(broken) + '\n```');
    expect(p).toBeNull();
  });

  it('returns null when proposed_fix is missing', () => {
    const broken = { ...valid, proposed_fix: undefined } as Record<string, unknown>;
    delete broken.proposed_fix;
    const p = extractProposalJson(JSON.stringify(broken));
    expect(p).toBeNull();
  });

  it('returns null for non-JSON output', () => {
    const p = extractProposalJson('I cannot determine the cause.');
    expect(p).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(extractProposalJson('')).toBeNull();
    expect(extractProposalJson('   ')).toBeNull();
  });

  it('coerces non-string files_to_change entries to strings', () => {
    const text = JSON.stringify({
      ...valid,
      proposed_fix: { description: 'x', files_to_change: ['src/a.ts', 42] },
    });
    const p = extractProposalJson(text);
    expect(p).not.toBeNull();
    expect(p!.proposed_fix.files_to_change).toEqual(['src/a.ts', '42']);
  });

  it('defaults confidence to 0 if missing', () => {
    const noConf = { ...valid, confidence: undefined } as Record<string, unknown>;
    delete noConf.confidence;
    const p = extractProposalJson(JSON.stringify(noConf));
    expect(p?.confidence).toBe(0);
  });
});
