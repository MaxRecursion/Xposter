import { safeWindow, type SalaryChoice } from './safe-window.ts';
import type { DateMetrics, FundArtifact } from './types.ts';

export function pickAnswerDate(fund: FundArtifact, salary: SalaryChoice, buffer: number): DateMetrics {
	const window = safeWindow(salary, buffer);
	const byDay = new Map(fund.dates.map((row) => [row.d, row]));
	const candidates = window.map((d) => byDay.get(d)).filter((row): row is DateMetrics => !!row);
	if (candidates.length === 0) {
		return fund.dates[0]!;
	}
	let best = candidates[0]!;
	for (const row of candidates) {
		if (row.meanPct > best.meanPct) best = row;
	}
	return best;
}

export function historyYears(fund: FundArtifact): number {
	const from = Date.parse(`${fund.navFrom}T00:00:00Z`);
	const to = Date.parse(`${fund.navTo}T00:00:00Z`);
	return (to - from) / (365.25 * 86_400_000);
}

export function investedNotional(fund: FundArtifact): number {
	return fund.instalments * 10_000;
}

export function missedInstalmentCost(fund: FundArtifact): number {
	if (fund.instalments === 0) return 0;
	return fund.dates[0] ? Math.round(maxCorpus(fund) / fund.instalments) : 0;
}

export function maxCorpus(fund: FundArtifact): number {
	return Math.max(...fund.dates.map((d) => d.corpus));
}

export function minCorpus(fund: FundArtifact): number {
	return Math.min(...fund.dates.map((d) => d.corpus));
}

export function isReducedConfidence(fund: FundArtifact): boolean {
	return historyYears(fund) < 5 || fund.instalments < 60;
}

export function ordinal(n: number): string {
	const v = n % 100;
	if (v >= 11 && v <= 13) return `${n}th`;
	switch (n % 10) {
		case 1:
			return `${n}st`;
		case 2:
			return `${n}nd`;
		case 3:
			return `${n}rd`;
		default:
			return `${n}th`;
	}
}

export function inr(n: number): string {
	return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.round(n));
}

export function inrCompactLakhs(n: number): string {
	if (n >= 10_00_000) return `₹${(n / 10_00_000).toFixed(1)} L`;
	return `₹${inr(n)}`;
}

export function justification(fund: FundArtifact, day: number): string {
	const label = ordinal(day);
	const years = historyYears(fund).toFixed(1);
	if (fund.verdict === 'noise') {
		return `Any date in your safe window performs the same. The ${label} is the cleanest fit after your salary.`;
	}
	if (fund.verdict === 'marginal') {
		return `The ${label} edges out other dates in your window, but the advantage is small.`;
	}
	return `The ${label} has held a real advantage in this fund: +${fund.spreadPp.toFixed(2)} pp of XIRR over ${years} years.`;
}
