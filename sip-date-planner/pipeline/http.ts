export async function mapPool<T, R>(
	items: readonly T[],
	concurrency: number,
	fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	async function worker() {
		while (true) {
			const i = next;
			next += 1;
			if (i >= items.length) return;
			results[i] = await fn(items[i]!, i);
		}
	}
	const n = Math.max(1, Math.min(concurrency, items.length || 1));
	await Promise.all(Array.from({ length: n }, () => worker()));
	return results;
}

export async function fetchWithRetry(
	url: string,
	retries = 3,
	fetchFn: typeof fetch = fetch
): Promise<Response> {
	let delay = 400;
	let lastError: unknown;
	for (let attempt = 0; attempt <= retries; attempt += 1) {
		try {
			const res = await fetchFn(url);
			if (res.ok) return res;
			if (res.status !== 429 && res.status < 500) {
				throw new Error(`HTTP ${res.status} for ${url}`);
			}
			lastError = new Error(`HTTP ${res.status} for ${url}`);
		} catch (err) {
			lastError = err;
			if (attempt === retries) break;
		}
		await sleep(delay);
		delay *= 2;
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function sleep(ms: number) {
	return new Promise((r) => setTimeout(r, ms));
}
