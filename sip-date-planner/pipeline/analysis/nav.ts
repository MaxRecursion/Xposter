import { addDays, parseIso } from './dates.ts';

export type NavPoint = { date: string; nav: number };
export type NavMap = ReadonlyMap<string, number>;

export type PreparedNav = {
	map: NavMap;
	sorted: string[];
	epochDay: Float64Array;
	navs: Float64Array;
	last: NavPoint;
};

export function isoEpochDay(iso: string): number {
	const { y, m, d } = parseIso(iso);
	return Date.UTC(y, m - 1, d) / 86_400_000;
}

export function prepareNav(navMap: NavMap): PreparedNav | null {
	const sorted = [...navMap.keys()].sort();
	if (sorted.length === 0) return null;
	const epochDay = new Float64Array(sorted.length);
	const navs = new Float64Array(sorted.length);
	for (let i = 0; i < sorted.length; i += 1) {
		const date = sorted[i]!;
		epochDay[i] = isoEpochDay(date);
		navs[i] = navMap.get(date)!;
	}
	const lastDate = sorted[sorted.length - 1]!;
	return {
		map: navMap,
		sorted,
		epochDay,
		navs,
		last: { date: lastDate, nav: navMap.get(lastDate)! }
	};
}

/** First published NAV on targetDate or up to 7 following calendar days. Never interpolates or rolls back. */
export function navOnOrAfter(navMap: NavMap, targetDate: string): NavPoint | null {
	for (let offset = 0; offset <= 7; offset += 1) {
		const date = addDays(targetDate, offset);
		const nav = navMap.get(date);
		if (nav != null) return { date, nav };
	}
	return null;
}

export function navOnOrAfterPrepared(prep: PreparedNav, targetDate: string): NavPoint | null {
	const target = isoEpochDay(targetDate);
	let lo = 0;
	let hi = prep.epochDay.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (prep.epochDay[mid]! < target) lo = mid + 1;
		else hi = mid;
	}
	if (lo >= prep.epochDay.length) return null;
	if (prep.epochDay[lo]! - target > 7) return null;
	return { date: prep.sorted[lo]!, nav: prep.navs[lo]! };
}

export function latestOnOrBefore(prep: PreparedNav, windowTo: string): NavPoint | null {
	const target = isoEpochDay(windowTo);
	let lo = 0;
	let hi = prep.epochDay.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (prep.epochDay[mid]! <= target) lo = mid + 1;
		else hi = mid;
	}
	const i = lo - 1;
	if (i < 0) return null;
	return { date: prep.sorted[i]!, nav: prep.navs[i]! };
}

export function latestNav(navMap: NavMap): NavPoint | null {
	let best: string | null = null;
	for (const date of navMap.keys()) {
		if (best == null || date > best) best = date;
	}
	if (best == null) return null;
	return { date: best, nav: navMap.get(best)! };
}

export function earliestNavDate(navMap: NavMap): string | null {
	let best: string | null = null;
	for (const date of navMap.keys()) {
		if (best == null || date < best) best = date;
	}
	return best;
}

export function navMapFromSeries(rows: NavPoint[]): Map<string, number> {
	const map = new Map<string, number>();
	for (const row of rows) {
		if (!Number.isFinite(row.nav) || row.nav === 0) continue;
		map.set(row.date, row.nav);
	}
	return map;
}
