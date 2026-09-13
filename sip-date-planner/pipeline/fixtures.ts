import { addDays } from './analysis/dates.ts';
import { analyzeFund } from './analysis/analyze.ts';
import { navMapFromSeries } from './analysis/nav.ts';
import type { FundArtifact } from './analysis/types.ts';

/** Synthetic ~40-month Direct Growth series for the reduced-confidence acceptance case. */
export function shortHistoryFixture(today = '2026-09-11'): FundArtifact {
	const start = '2023-05-02';
	const rows = [];
	let nav = 42;
	let date = start;
	while (date <= today) {
		const day = Number(date.slice(8));
		const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
		if (weekday !== 0 && weekday !== 6) {
			rows.push({ date, nav });
		}
		if (day === 1) nav *= 1.011;
		else nav *= 1 + (day % 7) * 0.00015;
		date = addDays(date, 1);
	}
	const art = analyzeFund(
		{
			code: 999001,
			name: 'Short History Demo Direct Plan Growth',
			house: 'Demo House',
			category: 'Equity Schemes - Flexi Cap Fund',
			schemeType: 'Open Ended'
		},
		navMapFromSeries(rows)
	);
	if (!art) throw new Error('short history fixture failed to analyze');
	return art;
}

export function weekdaySeries(from: string, to: string, startNav: number, drift: number) {
	const rows = [];
	let nav = startNav;
	let date = from;
	while (date <= to) {
		const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
		if (weekday !== 0 && weekday !== 6) rows.push({ date, nav });
		nav *= 1 + drift;
		date = addDays(date, 1);
	}
	return rows;
}
