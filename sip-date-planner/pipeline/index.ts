import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { analyzeFund } from './analysis/analyze.ts';
import type { FundArtifact } from './analysis/types.ts';
import { fileCache } from './cache.ts';
import { evaluateScheme } from './eligibility.ts';
import { shortHistoryFixture } from './fixtures.ts';
import { fetchWithRetry, mapPool } from './http.ts';
import { createMfapiSource } from './source/mfapi.ts';
import type { NavHistory } from './source/types.ts';
import type { MetaFile } from './write.ts';
import { writeArtifacts } from './write.ts';

const CONCURRENCY = 12;
const PIPELINE_VERSION_LOG = 'sip-date-planner pipeline';

export type PipelineOptions = {
	rootDir: string;
	today: string;
	limit?: number;
	only?: number[];
	forceRefresh?: boolean;
	concurrency?: number;
};

function todayIso(d = new Date()): string {
	return d.toISOString().slice(0, 10);
}

function parseArgs(argv: string[]): PipelineOptions {
	const only: number[] = [];
	let limit: number | undefined;
	let forceRefresh = false;
	for (let i = 0; i < argv.length; i += 1) {
		const a = argv[i]!;
		if (a === '--limit') limit = Number(argv[++i]);
		else if (a === '--only') only.push(Number(argv[++i]));
		else if (a === '--force') forceRefresh = true;
	}
	return {
		rootDir: process.cwd(),
		today: todayIso(),
		limit: Number.isFinite(limit) ? limit : undefined,
		only: only.length ? only : undefined,
		forceRefresh
	};
}

export async function runPipeline(opts: PipelineOptions): Promise<{ fundCount: number; navAsOf: string }> {
	const cacheDir = join(opts.rootDir, 'pipeline/.cache');
	const outDir = join(opts.rootDir, 'static/data');
	await mkdir(cacheDir, { recursive: true });
	const cache = fileCache(cacheDir);
	const source = createMfapiSource(async (input, init) => {
		const url = typeof input === 'string' ? input : String(input);
		return fetchWithRetry(url, 3, (u) => fetch(u, init));
	});

	console.log(`${PIPELINE_VERSION_LOG}: listing schemes via ${source.id}`);
	let listed = await source.listSchemes();
	if (opts.only?.length) {
		const allow = new Set(opts.only);
		listed = listed.filter((s) => allow.has(s.schemeCode));
	}
	listed = listed.filter((s) => {
		const n = s.schemeName;
		return n.includes('Direct') && /growth/i.test(n) && !/IDCW|dividend|payout|reinvest|bonus/i.test(n);
	});
	if (opts.limit) listed = listed.slice(0, opts.limit);
	console.log(`prefiltered list: ${listed.length}`);

	const funds: FundArtifact[] = [];
	let eligible = 0;
	let fetched = 0;
	let cachedHits = 0;

	await mapPool(listed, opts.concurrency ?? CONCURRENCY, async (scheme) => {
		let history: NavHistory | null = null;
		if (!opts.forceRefresh) {
			const hit = await cache.get(scheme.schemeCode);
			if (hit && cacheDate(hit) === opts.today) {
				history = hit;
				cachedHits += 1;
			}
		}
		if (!history) {
			try {
				history = await source.fetchHistory(scheme.schemeCode);
				history = {
					...history,
					meta: { ...history.meta, scheme_code: history.meta.scheme_code || scheme.schemeCode }
				};
				await cache.set(scheme.schemeCode, stamp(history, opts.today));
				fetched += 1;
			} catch (err) {
				console.warn(`skip ${scheme.schemeCode}: ${err instanceof Error ? err.message : err}`);
				return;
			}
		}
		const ev = evaluateScheme(history, opts.today);
		if (!ev.ok || !ev.meta || !ev.navMap) return;
		eligible += 1;
		const artifact = analyzeFund(ev.meta, ev.navMap);
		if (artifact) funds.push(artifact);
	});

	funds.push(shortHistoryFixture(opts.today > '2026-09-11' ? opts.today : '2026-09-11'));

	let outFunds = funds;
	if (opts.only?.length || opts.limit) {
		outFunds = await mergeExisting(outDir, funds);
	}

	outFunds.sort((a, b) => a.name.localeCompare(b.name));
	console.log(`eligible survivors: ${eligible}`);
	console.log(`artifacts written: ${outFunds.length} (fetched ${fetched}, cache-hit ${cachedHits})`);
	if (outFunds.length === 0) {
		throw new Error('pipeline produced 0 funds');
	}

	const partial = Boolean(opts.only?.length || opts.limit);
	await assertNoCollapse(outDir, outFunds.length, partial);

	const meta = await writeArtifacts(outDir, outFunds, new Date().toISOString());
	console.log(`navAsOf ${meta.navAsOf}; fundCount ${meta.fundCount}`);
	return { fundCount: meta.fundCount, navAsOf: meta.navAsOf };
}

async function mergeExisting(outDir: string, incoming: FundArtifact[]): Promise<FundArtifact[]> {
	const byCode = new Map<number, FundArtifact>();
	try {
		const index = JSON.parse(await readFile(join(outDir, 'index.json'), 'utf8')) as [number][];
		for (const [code] of index) {
			try {
				const raw = await readFile(join(outDir, 'funds', `${code}.json`), 'utf8');
				byCode.set(code, JSON.parse(raw) as FundArtifact);
			} catch {
				/* missing artifact */
			}
		}
	} catch {
		/* no previous index */
	}
	for (const fund of incoming) byCode.set(fund.code, fund);
	return [...byCode.values()];
}

async function assertNoCollapse(outDir: string, nextCount: number, partial: boolean) {
	if (partial) return;
	try {
		const prev = JSON.parse(await readFile(join(outDir, 'meta.json'), 'utf8')) as MetaFile;
		if (prev.fundCount > 0 && nextCount < prev.fundCount * 0.9) {
			throw new Error(`Fund count dropped more than 10%: ${prev.fundCount} -> ${nextCount}`);
		}
	} catch (err) {
		if (err instanceof Error && err.message.includes('dropped')) throw err;
	}
}

type CachedHistory = NavHistory & { cachedOn?: string };

function stamp(history: NavHistory, today: string): CachedHistory {
	return { ...history, cachedOn: today };
}

function cacheDate(history: NavHistory): string | null {
	return (history as CachedHistory).cachedOn ?? null;
}

const isMain = /pipeline\/index\.(ts|js)$/.test(process.argv[1] ?? '');
if (isMain) {
	runPipeline(parseArgs(process.argv.slice(2))).catch((err) => {
		console.error(err);
		process.exit(1);
	});
}
