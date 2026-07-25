import { describe, expect, it } from 'vitest';
import { isRejected, parseVerdict, rejectionReason } from '../../src/images/vision_qa.js';

const clean = '{"faceVisible":false,"malformedAnatomy":false,"textArtifacts":false,"looksAiGenerated":false,"notes":"rear view"}';

describe('parseVerdict', () => {
  it('parses a bare JSON object', () => {
    const v = parseVerdict(clean);
    expect(v).not.toBeNull();
    expect(v!.faceVisible).toBe(false);
    expect(v!.score).toBe(100);
  });

  it('extracts JSON from a fenced code block', () => {
    const v = parseVerdict('```json\n' + clean + '\n```');
    expect(v?.notes).toBe('rear view');
  });

  it('extracts JSON wrapped in prose', () => {
    const v = parseVerdict(`Here is my assessment:\n\n${clean}\n\nLet me know if you need more.`);
    expect(v).not.toBeNull();
  });

  it('returns null on malformed JSON', () => {
    expect(parseVerdict('{"faceVisible": tru')).toBeNull();
  });

  it('returns null when there is no object at all', () => {
    expect(parseVerdict('I could not read the image.')).toBeNull();
  });

  it('treats missing or non-boolean fields as false rather than throwing', () => {
    const v = parseVerdict('{"notes":"partial"}');
    expect(v).not.toBeNull();
    expect(v!.faceVisible).toBe(false);
    expect(v!.score).toBe(100);
  });

  it('coerces a non-boolean truthy value to false rather than trusting it', () => {
    const v = parseVerdict('{"faceVisible":"yes","notes":""}');
    expect(v!.faceVisible).toBe(false);
  });

  it('caps notes length', () => {
    const v = parseVerdict(`{"notes":"${'x'.repeat(500)}"}`);
    expect(v!.notes.length).toBeLessThanOrEqual(200);
  });
});

describe('score', () => {
  it('deducts per defect', () => {
    expect(parseVerdict('{"faceVisible":true}')!.score).toBe(60);
    expect(parseVerdict('{"malformedAnatomy":true}')!.score).toBe(70);
    expect(parseVerdict('{"textArtifacts":true}')!.score).toBe(80);
    expect(parseVerdict('{"looksAiGenerated":true}')!.score).toBe(85);
  });

  it('accumulates deductions so the least-bad candidate is identifiable', () => {
    const bad = parseVerdict('{"faceVisible":true,"malformedAnatomy":true,"textArtifacts":true,"looksAiGenerated":true}');
    expect(bad!.score).toBe(-5);
  });
});

describe('isRejected', () => {
  it('rejects on a visible face', () => {
    expect(isRejected(parseVerdict('{"faceVisible":true}')!)).toBe(true);
  });

  it('rejects on malformed anatomy', () => {
    expect(isRejected(parseVerdict('{"malformedAnatomy":true}')!)).toBe(true);
  });

  it('rejects on garbled text', () => {
    expect(isRejected(parseVerdict('{"textArtifacts":true}')!)).toBe(true);
  });

  it('does NOT hard-reject on looksAiGenerated alone', () => {
    // A small model trips this often; hard-rejecting would burn the whole
    // attempt budget every evening. It stays a soft signal via score.
    const v = parseVerdict('{"looksAiGenerated":true}')!;
    expect(isRejected(v)).toBe(false);
    expect(v.score).toBeLessThan(100);
  });

  it('accepts a clean verdict', () => {
    expect(isRejected(parseVerdict(clean)!)).toBe(false);
  });
});

describe('rejectionReason', () => {
  it('lists every failing check', () => {
    const v = parseVerdict('{"faceVisible":true,"textArtifacts":true}')!;
    expect(rejectionReason(v)).toBe('face visible, text artifacts');
  });

  it('reports none for a clean verdict', () => {
    expect(rejectionReason(parseVerdict(clean)!)).toBe('none');
  });
});
