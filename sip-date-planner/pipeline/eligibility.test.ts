import { describe, expect, it } from 'vitest';
import { evaluateScheme } from './eligibility.ts';
import type { NavHistory } from './source/types.ts';

function history(over: Partial<NavHistory['meta']> & { name?: string; dates?: [string, string][] }): NavHistory {
	const data = (over.dates ?? [
		['11-09-2026', '12.3'],
		['11-09-2023', '10']
	]).map(([date, nav]) => ({ date, nav }));
	return {
		meta: {
			scheme_code: 1,
			scheme_name: over.name ?? 'Kotak Mid Cap Fund - Direct Plan - Growth',
			scheme_category: 'Equity Schemes - Mid Cap Fund',
			fund_house: 'Kotak Mahindra Mutual Fund',
			scheme_type: over.scheme_type ?? 'Open Ended',
			isin_growth: 'INF'
		},
		data
	};
}

describe('eligibility', () => {
	it('keeps a live direct-growth open-ended scheme', () => {
		const ev = evaluateScheme(history({}), '2026-09-13');
		expect(ev.ok).toBe(true);
	});

	it('drops dividend / IDCW names and closed schemes and stale NAVs', () => {
		expect(evaluateScheme(history({ name: 'Foo Direct Growth IDCW' }), '2026-09-13').ok).toBe(false);
		expect(evaluateScheme(history({ scheme_type: 'Close Ended' }), '2026-09-13').ok).toBe(false);
		expect(evaluateScheme(history({ dates: [['01-01-2020', '10'], ['01-01-2016', '8']] }), '2026-09-13').ok).toBe(false);
	});
});
