import type { NavHistory, NavSource } from './types.ts';

const BASE = 'https://api.mfapi.in';

export function createMfapiSource(fetchFn: typeof fetch = fetch): NavSource {
	return {
		id: 'mfapi',
		async listSchemes() {
			const res = await fetchFn(`${BASE}/mf`);
			if (!res.ok) throw new Error(`mfapi list failed: ${res.status}`);
			const rows = (await res.json()) as { schemeCode: number; schemeName: string }[];
			return rows;
		},
		async fetchHistory(schemeCode: number) {
			const res = await fetchFn(`${BASE}/mf/${schemeCode}`);
			if (!res.ok) throw new Error(`mfapi history ${schemeCode} failed: ${res.status}`);
			return (await res.json()) as NavHistory;
		}
	};
}
