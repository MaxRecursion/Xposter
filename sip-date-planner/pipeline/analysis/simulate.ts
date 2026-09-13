import { monthsInRange, parseIso, toIso } from './dates.ts';
import {
	latestOnOrBefore,
	navOnOrAfterPrepared,
	prepareNav,
	type NavMap,
	type PreparedNav
} from './nav.ts';
import type { SipSim } from './types.ts';
import { xirrFromTimes } from './xirr.ts';

export const NOTIONAL = 10_000;
export const SIP_DAYS = 28;

export function simulateSipDate(
	navMap: NavMap,
	day: number,
	windowFrom: string,
	windowTo: string
): SipSim {
	if (day < 1 || day > SIP_DAYS) {
		throw new Error(`SIP day must be 1–${SIP_DAYS}, got ${day}`);
	}
	const prep = prepareNav(navMap);
	if (!prep) return { xirr: null, finalCorpus: 0, instalmentCount: 0 };
	return simulateSipDatePrepared(prep, day, windowFrom, windowTo);
}

export function simulateSipDatePrepared(
	prep: PreparedNav,
	day: number,
	windowFrom: string,
	windowTo: string
): SipSim {
	if (day < 1 || day > SIP_DAYS) {
		throw new Error(`SIP day must be 1–${SIP_DAYS}, got ${day}`);
	}
	const terminal = latestOnOrBefore(prep, windowTo);
	if (!terminal) return { xirr: null, finalCorpus: 0, instalmentCount: 0 };

	let units = 0;
	let instalmentCount = 0;
	const amounts: number[] = [];
	const epochs: number[] = [];
	const end = parseIso(terminal.date);

	for (const { y, m } of monthsInRange(windowFrom, windowTo)) {
		if (y > end.y || (y === end.y && m > end.m)) continue;
		const target = toIso(y, m, day);
		if (target > terminal.date) continue;
		const px = navOnOrAfterPrepared(prep, target);
		if (!px || px.date > terminal.date) continue;
		units += NOTIONAL / px.nav;
		instalmentCount += 1;
		amounts.push(-NOTIONAL);
		epochs.push(Date.parse(`${px.date}T00:00:00Z`));
	}

	const finalCorpus = units * terminal.nav;
	if (instalmentCount === 0) return { xirr: null, finalCorpus: 0, instalmentCount: 0 };
	amounts.push(finalCorpus);
	epochs.push(Date.parse(`${terminal.date}T00:00:00Z`));
	const t0 = epochs[0]!;
	const years = epochs.map((e) => (e - t0) / (365 * 86_400_000));
	return {
		xirr: xirrFromTimes(amounts, years),
		finalCorpus,
		instalmentCount
	};
}
