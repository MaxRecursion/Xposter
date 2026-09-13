export type CashFlow = { date: string; amount: number };

const LO = -0.99;
const HI = 3.0;
const ITERATIONS = 100;

/**
 * Annual XIRR via bisection on ACT/365 year fractions.
 * `times` are year fractions from the first cash flow (days/365).
 */
export function xirrFromTimes(amounts: readonly number[], years: readonly number[]): number | null {
	if (amounts.length < 2 || amounts.length !== years.length) return null;
	const npv = (rate: number) => {
		let sum = 0;
		for (let i = 0; i < amounts.length; i += 1) {
			sum += amounts[i]! / (1 + rate) ** years[i]!;
		}
		return sum;
	};
	const nLo = npv(LO);
	const nHi = npv(HI);
	if (nLo === 0) return LO;
	if (nHi === 0) return HI;
	if (nLo * nHi > 0) return null;
	let lo = LO;
	let hi = HI;
	let nLeft = nLo;
	for (let i = 0; i < ITERATIONS; i += 1) {
		const mid = (lo + hi) / 2;
		const nMid = npv(mid);
		if (nMid === 0) return mid;
		if (nLeft * nMid <= 0) {
			hi = mid;
		} else {
			lo = mid;
			nLeft = nMid;
		}
	}
	return (lo + hi) / 2;
}

export function xirr(cashFlows: readonly CashFlow[]): number | null {
	if (cashFlows.length < 2) return null;
	const sorted = [...cashFlows].sort((a, b) => a.date.localeCompare(b.date));
	const t0 = Date.parse(`${sorted[0]!.date}T00:00:00Z`);
	const amounts = sorted.map((cf) => cf.amount);
	const years = sorted.map((cf) => (Date.parse(`${cf.date}T00:00:00Z`) - t0) / (365 * 86_400_000));
	return xirrFromTimes(amounts, years);
}
