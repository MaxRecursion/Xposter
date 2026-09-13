import { error } from '@sveltejs/kit';
import type { EntryGenerator, PageLoad } from './$types';
import codes from '$lib/generated/codes.json';
import type { FundArtifact } from '$lib/types';

export const prerender = true;

export const entries: EntryGenerator = () => codes.map((code) => ({ code }));

export const load: PageLoad = async ({ params, fetch }) => {
	const res = await fetch(`/data/funds/${params.code}.json`);
	if (!res.ok) error(404, 'Fund not found');
	const fund = (await res.json()) as FundArtifact;
	return { fund };
};
