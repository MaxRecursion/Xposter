import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { FundArtifact } from './analysis/types.ts';

export const PIPELINE_VERSION = '1.0.0';

export type IndexRow = [code: number, name: string, house: string, category: string];

export type MetaFile = {
	builtAt: string;
	fundCount: number;
	navAsOf: string;
	pipelineVersion: string;
};

export async function writeArtifacts(
	outDir: string,
	funds: FundArtifact[],
	builtAt: string
): Promise<MetaFile> {
	const fundsDir = join(outDir, 'funds');
	await mkdir(fundsDir, { recursive: true });

	const index: IndexRow[] = [];
	let navAsOf = '';
	for (const fund of funds) {
		await writeFile(join(fundsDir, `${fund.code}.json`), JSON.stringify(fund));
		index.push([fund.code, fund.name, fund.house, fund.category]);
		if (fund.navTo > navAsOf) navAsOf = fund.navTo;
	}

	index.sort((a, b) => a[1].localeCompare(b[1]));
	const indexJson = JSON.stringify(index);
	await writeFile(join(outDir, 'index.json'), indexJson);
	const gz = gzipSync(indexJson);
	if (gz.length > 120 * 1024) {
		console.warn(`index.json gzip is ${(gz.length / 1024).toFixed(1)} KB (budget 120 KB)`);
	}

	const meta: MetaFile = {
		builtAt,
		fundCount: funds.length,
		navAsOf,
		pipelineVersion: PIPELINE_VERSION
	};
	await writeFile(join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));

	const generatedDir = join(outDir, '../../src/lib/generated');
	await mkdir(generatedDir, { recursive: true });
	await writeFile(
		join(generatedDir, 'codes.json'),
		JSON.stringify(index.map((row) => String(row[0])))
	);

	return meta;
}
