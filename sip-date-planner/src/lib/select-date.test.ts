import { describe, expect, it } from 'vitest';
import { searchFunds } from './search.ts';
import { pickAnswerDate } from './select-date.ts';
import { parseSalaryParam, safeWindow } from './safe-window.ts';
import type { FundArtifact } from './types.ts';

const fund: FundArtifact = {
	code: 1,
	name: 'Test Direct Growth',
	house: 'H',
	category: 'C',
	navFrom: '2013-01-01',
	navTo: '2026-09-01',
	instalments: 164,
	dates: Array.from({ length: 28 }, (_, i) => ({
		d: i + 1,
		xirr: 20,
		corpus: 100,
		meanPct: i + 1 === 7 ? 80 : i + 1 === 20 ? 90 : 40,
		topQ: 0.2
	})),
	spreadPp: 0.114,
	spreadRupees: 123187,
	stability: 0.54,
	metricsAgree: false,
	verdict: 'noise'
};

describe('safeWindow', () => {
	it('defaults last working day to the 3rd–12th', () => {
		expect(safeWindow('lwd', 2)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
	});

	it('wraps an explicit salary date modulo 28', () => {
		expect(safeWindow(25, 2)[0]).toBe(27);
		expect(safeWindow(25, 2)).toContain(3);
		expect(safeWindow(25, 2)).not.toContain(26);
	});
});

describe('pickAnswerDate', () => {
	it('never leaves the safe window even if a date outside scored higher', () => {
		expect(pickAnswerDate(fund, 'lwd', 2).d).toBe(7);
		expect(pickAnswerDate(fund, 18, 2).d).toBe(20);
	});
});

describe('searchFunds', () => {
	it('fuzzy-matches kotak mid', () => {
		const hits = searchFunds(
			[[119775, 'Kotak Mid Cap Fund - Direct Plan - Growth', 'Kotak Mahindra Mutual Fund', 'Equity']],
			'kotak mid'
		);
		expect(hits[0]?.[0]).toBe(119775);
	});
});

describe('parseSalaryParam', () => {
	it('treats 28 as last working day', () => {
		expect(parseSalaryParam('28')).toBe('lwd');
		expect(parseSalaryParam('7')).toBe(7);
	});
});
