import type { LayoutLoad } from './$types';

export const prerender = true;
export const trailingSlash = 'never';

export const load: LayoutLoad = async ({ fetch }) => {
	const res = await fetch('/data/meta.json');
	if (!res.ok) {
		return {
			meta: {
				builtAt: new Date().toISOString(),
				fundCount: 0,
				navAsOf: 'unknown',
				pipelineVersion: '0'
			}
		};
	}
	return { meta: await res.json() };
};
