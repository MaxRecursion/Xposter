/** Spearman rank correlation of two aligned series (higher value → better rank). */
export function spearman(a: readonly number[], b: readonly number[]): number {
	if (a.length !== b.length || a.length < 2) return 0;
	const ra = ranksDescending(a);
	const rb = ranksDescending(b);
	const n = a.length;
	let sumSq = 0;
	for (let i = 0; i < n; i += 1) {
		const d = ra[i]! - rb[i]!;
		sumSq += d * d;
	}
	return 1 - (6 * sumSq) / (n * (n * n - 1));
}

/** Average ranks, 1 = highest value. */
export function ranksDescending(values: readonly number[]): number[] {
	const n = values.length;
	const indexed = values.map((v, i) => ({ v, i })).sort((x, y) => y.v - x.v);
	const out = Array<number>(n).fill(0);
	let i = 0;
	while (i < n) {
		let j = i;
		while (j < n && indexed[j]!.v === indexed[i]!.v) j += 1;
		const avgRank = (i + 1 + j) / 2;
		for (let k = i; k < j; k += 1) out[indexed[k]!.i] = avgRank;
		i = j;
	}
	return out;
}

/** 100 = best of n, 0 = worst. Ties share the average percentile. */
export function percentilesDescending(values: readonly number[]): number[] {
	const n = values.length;
	if (n <= 1) return values.map(() => 100);
	const indexed = values.map((v, i) => ({ v, i })).sort((x, y) => y.v - x.v);
	const out = Array<number>(n).fill(0);
	let i = 0;
	while (i < n) {
		let j = i;
		while (j < n && indexed[j]!.v === indexed[i]!.v) j += 1;
		const avgZeroBased = (i + j - 1) / 2;
		const pct = (100 * (n - 1 - avgZeroBased)) / (n - 1);
		for (let k = i; k < j; k += 1) out[indexed[k]!.i] = pct;
		i = j;
	}
	return out;
}
