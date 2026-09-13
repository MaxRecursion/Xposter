import type { Verdict } from './types.ts';

export function gradeVerdict(spreadPp: number, stability: number): Verdict {
	if (spreadPp > 0.25 && stability > 0.6) return 'meaningful';
	if (spreadPp > 0.25 || stability > 0.6) return 'marginal';
	return 'noise';
}
