<script lang="ts">
	import { goto } from '$app/navigation';
	import { prefetchFund } from '$lib/data';
	import { searchFunds } from '$lib/search';
	import type { IndexRow } from '$lib/types';
	import { onMount } from 'svelte';

	let {
		autofocus = false,
		onPicked
	}: {
		autofocus?: boolean;
		onPicked?: (code: number) => void;
	} = $props();

	let q = $state('');
	let open = $state(false);
	let active = $state(0);
	let results = $state<IndexRow[]>([]);
	let index = $state<IndexRow[] | null>(null);
	let loadingIndex = $state(false);
	let inputEl = $state<HTMLInputElement | null>(null);
	let timer = $state<ReturnType<typeof setTimeout> | null>(null);

	onMount(() => {
		if (autofocus) inputEl?.focus();
	});

	async function ensureIndex() {
		if (index || loadingIndex) return;
		loadingIndex = true;
		const res = await fetch('/data/index.json');
		index = (await res.json()) as IndexRow[];
		loadingIndex = false;
	}

	function schedule(value: string) {
		q = value;
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => void runSearch(value), 120);
	}

	async function runSearch(value: string) {
		await ensureIndex();
		if (!index) return;
		results = searchFunds(index, value, 8);
		open = results.length > 0 && value.trim().length > 0;
		active = 0;
		if (results[0]) prefetchFund(results[0][0]);
	}

	function pick(row: IndexRow) {
		open = false;
		q = row[1];
		onPicked?.(row[0]);
		void goto(`/f/${row[0]}?salary=28&buffer=2`);
	}

	function onKey(e: KeyboardEvent) {
		if (!open && e.key === 'Enter' && results[0]) {
			pick(results[0]);
			return;
		}
		if (!open) return;
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			active = Math.min(active + 1, results.length - 1);
			if (results[active]) prefetchFund(results[active][0]);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			active = Math.max(active - 1, 0);
			if (results[active]) prefetchFund(results[active][0]);
		} else if (e.key === 'Enter') {
			e.preventDefault();
			const row = results[active] ?? results[0];
			if (row) pick(row);
		} else if (e.key === 'Escape') {
			open = false;
		}
	}

	function globalSlash(e: KeyboardEvent) {
		if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
		const t = e.target as HTMLElement | null;
		if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
		e.preventDefault();
		inputEl?.focus();
	}
</script>

<svelte:window onkeydown={globalSlash} />

<div class="relative w-full">
	<label class="sr-only" for="fund-search">Fund name</label>
	<input
		id="fund-search"
		bind:this={inputEl}
		class="w-full rounded-xl border border-stone-300 bg-white px-4 py-3 text-lg text-stone-900 shadow-sm outline-none ring-emerald-800/20 placeholder:text-stone-400 focus:ring-4"
		placeholder="Type a fund name — try “kotak mid”"
		autocomplete="off"
		role="combobox"
		aria-autocomplete="list"
		aria-expanded={open}
		aria-controls="fund-results"
		value={q}
		oninput={(e) => schedule(e.currentTarget.value)}
		onkeydown={onKey}
		onfocus={() => {
			if (results.length) open = true;
		}}
	/>
	{#if open}
		<ul
			id="fund-results"
			class="absolute z-20 mt-1 max-h-80 w-full overflow-auto rounded-xl border border-stone-200 bg-white py-1 shadow-lg"
			role="listbox"
		>
			{#each results as row, i (row[0])}
				<li role="option" aria-selected={i === active}>
					<button
						type="button"
						class="block w-full px-4 py-2 text-left {i === active ? 'bg-emerald-50' : ''}"
						onmousedown={(e) => e.preventDefault()}
						onmouseenter={() => {
							active = i;
							prefetchFund(row[0]);
						}}
						onclick={() => pick(row)}
					>
						<div class="font-medium text-stone-900">{row[1]}</div>
						<div class="text-sm text-stone-500">{row[2]}</div>
					</button>
				</li>
			{/each}
		</ul>
	{/if}
	<p class="mt-2 text-sm text-stone-500">
		Press <kbd class="rounded border border-stone-300 px-1">/</kbd> to search. Enter selects the top hit.
	</p>
</div>
