import { describe, expect, it } from 'vitest';
import { analyzeFund } from './analyze.ts';
import { addDays, toIso } from './dates.ts';
import { navMapFromSeries } from './nav.ts';
import { spearman } from './spearman.ts';
import { simulateSipDate } from './simulate.ts';
import { gradeVerdict } from './verdict.ts';

const META = {
	code: 1,
	name: 'Test Direct Plan Growth',
	house: 'Test House',
	category: 'Equity',
	schemeType: 'Open Ended'
};

function dailyDrift(from: string, months: number, startNav = 100, daily = 0.00035) {
	const rows = [];
	let nav = startNav;
	let date = from;
	const start = Number(from.slice(0, 4)) * 12 + Number(from.slice(5, 7));
	while (true) {
		rows.push({ date, nav });
		nav *= 1 + daily;
		date = addDays(date, 1);
		const cur = Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7));
		if (cur - start > months) break;
	}
	return navMapFromSeries(rows);
}

describe('gradeVerdict', () => {
	it('is noise unless spread and stability both clear the bar', () => {
		expect(gradeVerdict(0.114, 0.54)).toBe('noise');
		expect(gradeVerdict(0.3, 0.5)).toBe('marginal');
		expect(gradeVerdict(0.2, 0.7)).toBe('marginal');
		expect(gradeVerdict(0.3, 0.7)).toBe('meaningful');
	});
});

describe('spearman', () => {
	it('is 1 for identical orderings and -1 for reversed', () => {
		const a = [1, 2, 3, 4];
		expect(spearman(a, a)).toBeCloseTo(1);
		expect(spearman(a, [4, 3, 2, 1])).toBeCloseTo(-1);
	});
});

describe('simulateSipDate', () => {
	it('never uses days 29–31', () => {
		expect(() => simulateSipDate(new Map(), 29, '2020-01-01', '2023-01-01')).toThrow();
	});

	it('accumulates units and values at the last NAV', () => {
		const map = new Map<string, number>();
		for (let y = 2020; y <= 2023; y += 1) {
			for (let m = 1; m <= 12; m += 1) {
				if (y === 2023 && m > 6) break;
				map.set(toIso(y, m, 5), 10);
			}
		}
		map.set('2023-06-30', 20);
		const sim = simulateSipDate(map, 5, '2020-01-01', '2023-06-30');
		expect(sim.instalmentCount).toBeGreaterThan(30);
		expect(sim.finalCorpus).toBeCloseTo(sim.instalmentCount * 10000 * (20 / 10), 6);
		expect(sim.xirr).not.toBeNull();
	});
});

describe('analyzeFund', () => {
	it('returns a valid artifact and noise verdict when the date curve is flat', () => {
		const map = dailyDrift('2020-01-01', 48, 100, 0.0004);
		const art = analyzeFund(META, map);
		expect(art).not.toBeNull();
		expect(art!.dates).toHaveLength(28);
		expect(art!.verdict).toBe('noise');
		expect(art!.spreadPp).toBeLessThan(0.25);
		expect(art!.instalments).toBeGreaterThan(36);
	});

	it('produces a valid reduced-history result for ~40 months without crashing', () => {
		const map = dailyDrift('2022-01-03', 40, 50, 0.0005);
		const art = analyzeFund({ ...META, code: 40 }, map);
		expect(art).not.toBeNull();
		expect(art!.dates).toHaveLength(28);
		expect(art!.instalments).toBeGreaterThanOrEqual(36);
		expect(['noise', 'marginal', 'meaningful']).toContain(art!.verdict);
	});
});
