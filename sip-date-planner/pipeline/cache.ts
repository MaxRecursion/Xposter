import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { NavHistory } from './source/types.ts';

export type CacheStore = {
	get(schemeCode: number): Promise<NavHistory | null>;
	set(schemeCode: number, history: NavHistory): Promise<void>;
};

export function fileCache(dir: string): CacheStore {
	return {
		async get(schemeCode) {
			try {
				const raw = await readFile(join(dir, `${schemeCode}.json`), 'utf8');
				return JSON.parse(raw) as NavHistory;
			} catch {
				return null;
			}
		},
		async set(schemeCode, history) {
			const path = join(dir, `${schemeCode}.json`);
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, JSON.stringify(history));
		}
	};
}

export function cacheIsFresh(history: NavHistory, today: string, maxAgeDays = 1): boolean {
	const first = history.data[0];
	if (!first) return false;
	const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(first.date.trim());
	if (!m) return false;
	const latest = `${m[3]}-${m[2]}-${m[1]}`;
	const todayMs = Date.parse(`${today}T00:00:00Z`);
	const latestMs = Date.parse(`${latest}T00:00:00Z`);
	if (!Number.isFinite(todayMs) || !Number.isFinite(latestMs)) return false;
	const ageDays = (todayMs - latestMs) / 86_400_000;
	return ageDays >= 0 && ageDays <= 12 && ageDays <= maxAgeDays + 12;
}
