import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FundArtifact } from './analysis/types.ts';

const path = join(process.cwd(), 'static/data/funds/119775.json');

describe('Kotak Mid Cap Direct Growth artifact', () => {
	it('reproduces the published noise-scale spread', () => {
		expect(existsSync(path)).toBe(true);
		const fund = JSON.parse(readFileSync(path, 'utf8')) as FundArtifact;
		expect(fund.code).toBe(119775);
		expect(fund.verdict).toBe('noise');
		expect(fund.spreadPp).toBeGreaterThan(0.05);
		expect(fund.spreadPp).toBeLessThan(0.2);
		expect(fund.spreadPp).toBeCloseTo(0.114, 1);
		const best = [...fund.dates].sort((a, b) => b.xirr - a.xirr)[0]!;
		const worst = [...fund.dates].sort((a, b) => a.xirr - b.xirr)[0]!;
		expect(best.d).toBe(26);
		expect(worst.d).toBe(9);
		expect(best.xirr).toBeCloseTo(20.39, 1);
		expect(worst.xirr).toBeCloseTo(20.28, 1);
	});
});
