import type { IndexRow } from './types.ts';

export function fuzzyScore(query: string, row: IndexRow): number {
	const q = query.trim().toLowerCase();
	if (!q) return 0;
	const [, name, house, category] = row;
	const hay = `${name} ${house} ${category}`.toLowerCase();
	if (hay.includes(q)) return 1000 - hay.indexOf(q) + Math.min(name.length, 80);
	const words = q.split(/\s+/).filter(Boolean);
	if (words.every((w) => hay.includes(w))) {
		return 800 - words.length * 5;
	}
	if (subsequence(q.replace(/\s+/g, ''), hay.replace(/\s+/g, ''))) return 200;
	return 0;
}

function subsequence(q: string, hay: string): boolean {
	let i = 0;
	for (const ch of hay) {
		if (ch === q[i]) i += 1;
		if (i >= q.length) return true;
	}
	return false;
}

export function searchFunds(index: IndexRow[], query: string, limit = 8): IndexRow[] {
	const scored = index
		.map((row) => ({ row, score: fuzzyScore(query, row) }))
		.filter((x) => x.score > 0)
		.sort((a, b) => b.score - a.score || a.row[1].localeCompare(b.row[1]));
	return scored.slice(0, limit).map((x) => x.row);
}
