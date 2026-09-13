import { daysBetween, monthsBetween, parseMfapiDate } from './analysis/dates.ts';
import { navMapFromSeries, type NavMap } from './analysis/nav.ts';
import type { SchemeMeta } from './analysis/types.ts';
import type { NavHistory } from './source/types.ts';

const GROWTH = /growth/i;
const EXCLUDE = /IDCW|dividend|payout|reinvest|bonus/i;
const OPEN = /open/i;

export type Eligibility = {
	ok: boolean;
	reason?: string;
	meta?: SchemeMeta;
	navMap?: NavMap;
	navFrom?: string;
	navTo?: string;
};

export function evaluateScheme(history: NavHistory, today: string): Eligibility {
	const name = history.meta.scheme_name ?? '';
	if (!name.includes('Direct') || !GROWTH.test(name)) {
		return { ok: false, reason: 'not-direct-growth' };
	}
	if (EXCLUDE.test(name)) return { ok: false, reason: 'income-distribution' };
	if (!OPEN.test(history.meta.scheme_type ?? '')) {
		return { ok: false, reason: 'not-open-ended' };
	}

	const points = [];
	for (const row of history.data) {
		const date = parseMfapiDate(row.date);
		const nav = Number.parseFloat(row.nav);
		if (!date || !Number.isFinite(nav) || nav === 0) continue;
		points.push({ date, nav });
	}
	if (points.length === 0) return { ok: false, reason: 'empty-nav' };

	points.sort((a, b) => a.date.localeCompare(b.date));
	const navFrom = points[0]!.date;
	const navTo = points[points.length - 1]!.date;
	if (daysBetween(navTo, today) > 12) return { ok: false, reason: 'stale-nav' };
	if (monthsBetween(navFrom, navTo) < 36) return { ok: false, reason: 'short-history' };

	return {
		ok: true,
		meta: {
			code: history.meta.scheme_code,
			name: history.meta.scheme_name,
			house: history.meta.fund_house,
			category: history.meta.scheme_category,
			schemeType: history.meta.scheme_type
		},
		navMap: navMapFromSeries(points),
		navFrom,
		navTo
	};
}
