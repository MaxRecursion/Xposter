import { addMonths, firstOfMonth, monthsBetween, monthsInRange, toIso } from './dates.ts';
import { earliestNavDate, latestNav, prepareNav, type NavMap, type PreparedNav } from './nav.ts';
import { percentilesDescending, spearman } from './spearman.ts';
import { SIP_DAYS, simulateSipDatePrepared } from './simulate.ts';
import type { DateMetrics, FundArtifact, SchemeMeta, SipSim } from './types.ts';
import { gradeVerdict } from './verdict.ts';

export function roundTo(n: number, dp: number): number {
	const f = 10 ** dp;
	return Math.round(n * f) / f;
}

export function analyzeFund(meta: SchemeMeta, navMap: NavMap): FundArtifact | null {
	const navFrom = earliestNavDate(navMap);
	const terminal = latestNav(navMap);
	if (!navFrom || !terminal) return null;

	const prep = prepareNav(navMap);
	if (!prep) return null;

	const full = simulateAllDates(prep, navFrom, terminal.date);
	if (full.every((s) => s.instalmentCount === 0)) return null;

	const xirrsPct = full.map((s) => (s.xirr == null ? Number.NEGATIVE_INFINITY : s.xirr * 100));
	const corpora = full.map((s) => s.finalCorpus);
	const validX = xirrsPct.filter((x) => Number.isFinite(x));
	const validC = corpora.filter((c) => c > 0);
	if (validX.length === 0 || validC.length === 0) return null;

	const spreadPp = Math.max(...validX) - Math.min(...validX);
	const spreadRupees = Math.max(...validC) - Math.min(...validC);

	const bestXirrDay = argMax(xirrsPct);
	const bestCorpusDay = argMax(corpora);
	const metricsAgree = bestXirrDay === bestCorpusDay;

	const rolling = rollingPercentiles(prep, navFrom, terminal.date);
	const halves = splitHalfXirrs(prep, navFrom, terminal.date);
	const stability = spearman(halves.a, halves.b);
	const verdict = gradeVerdict(spreadPp, stability);

	const dates: DateMetrics[] = [];
	for (let d = 1; d <= SIP_DAYS; d += 1) {
		const sim = full[d - 1]!;
		dates.push({
			d,
			xirr: roundTo(Number.isFinite(xirrsPct[d - 1]!) ? xirrsPct[d - 1]! : 0, 3),
			corpus: Math.round(sim.finalCorpus),
			meanPct: roundTo(rolling.meanPct[d - 1] ?? 50, 3),
			topQ: roundTo(rolling.topQ[d - 1] ?? 0, 3)
		});
	}

	return {
		code: meta.code,
		name: meta.name,
		house: meta.house,
		category: meta.category,
		navFrom,
		navTo: terminal.date,
		instalments: Math.max(...full.map((s) => s.instalmentCount)),
		dates,
		spreadPp: roundTo(spreadPp, 3),
		spreadRupees: Math.round(spreadRupees),
		stability: roundTo(stability, 3),
		metricsAgree,
		verdict
	};
}

function simulateAllDates(prep: PreparedNav, from: string, to: string): SipSim[] {
	const out: SipSim[] = [];
	for (let d = 1; d <= SIP_DAYS; d += 1) {
		out.push(simulateSipDatePrepared(prep, d, from, to));
	}
	return out;
}

function argMax(values: readonly number[]): number {
	let bestI = 0;
	for (let i = 1; i < values.length; i += 1) {
		if (values[i]! > values[bestI]!) bestI = i;
	}
	return bestI;
}

function rollingPercentiles(prep: PreparedNav, navFrom: string, navTo: string) {
	const meanSum = Array<number>(SIP_DAYS).fill(0);
	const topQHits = Array<number>(SIP_DAYS).fill(0);
	let windows = 0;

	const lastStart = addMonths(firstOfMonth(navTo), -36);
	for (const { y, m } of monthsInRange(firstOfMonth(navFrom), lastStart)) {
		const start = toIso(y, m, 1);
		const end = addMonths(start, 36);
		if (end > navTo) continue;
		const sims = simulateAllDates(prep, start, end);
		const xirrs = sims.map((s) => (s.xirr == null ? Number.NEGATIVE_INFINITY : s.xirr));
		if (!xirrs.some(Number.isFinite)) continue;
		const pcts = percentilesDescending(xirrs);
		windows += 1;
		for (let i = 0; i < SIP_DAYS; i += 1) {
			meanSum[i]! += pcts[i]!;
			if (pcts[i]! >= 75) topQHits[i]! += 1;
		}
	}

	const meanPct = meanSum.map((s) => (windows === 0 ? 50 : s / windows));
	const topQ = topQHits.map((h) => (windows === 0 ? 0 : h / windows));
	return { meanPct, topQ, windows };
}

function splitHalfXirrs(prep: PreparedNav, navFrom: string, navTo: string) {
	const mid = addMonths(navFrom, Math.floor(monthsBetween(navFrom, navTo) / 2));
	const first = simulateAllDates(prep, navFrom, mid);
	const second = simulateAllDates(prep, addMonths(mid, 1), navTo);
	return {
		a: first.map((s) => (s.xirr == null ? Number.NEGATIVE_INFINITY : s.xirr)),
		b: second.map((s) => (s.xirr == null ? Number.NEGATIVE_INFINITY : s.xirr))
	};
}
