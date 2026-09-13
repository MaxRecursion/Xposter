import type { FundArtifact, MetaFile } from './types.ts';

const fundCache = new Map<string, Promise<FundArtifact>>();

export function fundUrl(code: number | string): string {
	return `/data/funds/${code}.json`;
}

export function prefetchFund(code: number | string): void {
	if (fundCache.has(String(code))) return;
	fundCache.set(
		String(code),
		fetch(fundUrl(code), {
			headers: { Accept: 'application/json' },
			cache: 'default'
		}).then((res) => {
			if (!res.ok) throw new Error(`Fund ${code} not found`);
			return res.json() as Promise<FundArtifact>;
		})
	);
}

export async function loadFund(code: number | string): Promise<FundArtifact> {
	prefetchFund(code);
	return fundCache.get(String(code))!;
}

export async function loadMeta(): Promise<MetaFile> {
	const res = await fetch('/data/meta.json');
	if (!res.ok) throw new Error('meta.json missing');
	return res.json();
}
