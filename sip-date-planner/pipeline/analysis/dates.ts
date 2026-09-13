export type Ymd = { y: number; m: number; d: number };

export function parseIso(iso: string): Ymd {
	const [y, m, d] = iso.split('-').map(Number);
	if (!y || !m || !d) throw new Error(`Invalid ISO date: ${iso}`);
	return { y, m, d };
}

export function toIso(y: number, m: number, d: number): string {
	return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function addDays(iso: string, days: number): string {
	const { y, m, d } = parseIso(iso);
	const dt = new Date(Date.UTC(y, m - 1, d + days));
	return toIso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

export function daysBetween(a: string, b: string): number {
	const pa = parseIso(a);
	const pb = parseIso(b);
	const ms =
		Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d);
	return Math.round(ms / 86400000);
}

export function monthsBetween(from: string, to: string): number {
	const a = parseIso(from);
	const b = parseIso(to);
	return (b.y - a.y) * 12 + (b.m - a.m) + (b.d >= a.d ? 0 : -1);
}

export function addMonths(iso: string, months: number): string {
	const { y, m, d } = parseIso(iso);
	const dt = new Date(Date.UTC(y, m - 1 + months, d));
	return toIso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

export function firstOfMonth(iso: string): string {
	const { y, m } = parseIso(iso);
	return toIso(y, m, 1);
}

export function* monthsInRange(from: string, to: string): Generator<{ y: number; m: number }> {
	let { y, m } = parseIso(from);
	const end = parseIso(to);
	while (y < end.y || (y === end.y && m <= end.m)) {
		yield { y, m };
		m += 1;
		if (m > 12) {
			m = 1;
			y += 1;
		}
	}
}

export function parseMfapiDate(ddmmyyyy: string): string | null {
	const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(ddmmyyyy.trim());
	if (!m) return null;
	const [, dd, mm, yyyy] = m;
	return `${yyyy}-${mm}-${dd}`;
}
