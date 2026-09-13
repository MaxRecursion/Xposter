import { describe, expect, it } from 'vitest';
import { addDays, daysBetween, parseMfapiDate } from './dates.ts';
import { navMapFromSeries, navOnOrAfter } from './nav.ts';
import { xirr } from './xirr.ts';

describe('navOnOrAfter', () => {
	it('returns the target date when a NAV exists', () => {
		const map = navMapFromSeries([
			{ date: '2024-01-10', nav: 10 },
			{ date: '2024-01-11', nav: 11 }
		]);
		expect(navOnOrAfter(map, '2024-01-10')).toEqual({ date: '2024-01-10', nav: 10 });
	});

	it('rolls forward up to 7 calendar days and never interpolates', () => {
		const map = navMapFromSeries([
			{ date: '2024-01-08', nav: 8 },
			{ date: '2024-01-15', nav: 15 }
		]);
		expect(navOnOrAfter(map, '2024-01-08')).toEqual({ date: '2024-01-08', nav: 8 });
		expect(navOnOrAfter(map, '2024-01-09')).toEqual({ date: '2024-01-15', nav: 15 });
		expect(navOnOrAfter(map, '2024-01-16')).toBeNull();
	});

	it('does not roll backward', () => {
		const map = navMapFromSeries([{ date: '2024-01-10', nav: 10 }]);
		expect(navOnOrAfter(map, '2024-01-11')).toBeNull();
	});

	it('skips zero NAVs because they never enter the map', () => {
		const map = navMapFromSeries([
			{ date: '2024-01-10', nav: 0 },
			{ date: '2024-01-11', nav: 12 }
		]);
		expect(navOnOrAfter(map, '2024-01-10')).toEqual({ date: '2024-01-11', nav: 12 });
	});
});

describe('dates', () => {
	it('parses mfapi DD-MM-YYYY', () => {
		expect(parseMfapiDate('11-09-2026')).toBe('2026-09-11');
		expect(parseMfapiDate('bad')).toBeNull();
	});

	it('counts ACT/365 day differences in UTC', () => {
		expect(daysBetween('2008-01-01', '2008-03-01')).toBe(60);
		expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
	});
});

describe('xirr (Excel fixtures to 4 decimal places)', () => {
	it('matches Microsoft Excel XIRR sample', () => {
		const r = xirr([
			{ date: '2008-01-01', amount: -10000 },
			{ date: '2008-03-01', amount: 2750 },
			{ date: '2008-10-30', amount: 4250 },
			{ date: '2009-02-15', amount: 3250 },
			{ date: '2009-04-01', amount: 2750 }
		]);
		expect(r).not.toBeNull();
		expect(r!.toFixed(4)).toBe('0.3734');
	});

	it('matches a one-year 20% holding period', () => {
		const r = xirr([
			{ date: '2018-01-01', amount: -10000 },
			{ date: '2019-01-01', amount: 12000 }
		]);
		expect(r).not.toBeNull();
		expect(r!.toFixed(4)).toBe('0.2000');
	});

	it('matches a two-year compounded 10% holding period', () => {
		const r = xirr([
			{ date: '2017-01-01', amount: -100 },
			{ date: '2019-01-01', amount: 121 }
		]);
		expect(r).not.toBeNull();
		expect(r!.toFixed(4)).toBe('0.1000');
	});

	it('matches an irregular four-flow Excel series', () => {
		const r = xirr([
			{ date: '2011-01-01', amount: -10000 },
			{ date: '2011-03-01', amount: 2750 },
			{ date: '2011-10-30', amount: 4250 },
			{ date: '2012-02-15', amount: 3250 },
			{ date: '2012-04-01', amount: 2750 }
		]);
		expect(r).not.toBeNull();
		expect(r!.toFixed(4)).toBe('0.3746');
	});

	it('converges on a deeply negative return series', () => {
		const r = xirr([
			{ date: '2020-01-01', amount: -10000 },
			{ date: '2020-04-01', amount: -10000 },
			{ date: '2020-07-01', amount: -10000 },
			{ date: '2021-01-01', amount: 3000 }
		]);
		expect(r).not.toBeNull();
		expect(r!).toBeLessThan(-0.7);
		expect(Number(r!.toFixed(4))).toBe(-0.9649);
	});
});
