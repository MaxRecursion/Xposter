<script lang="ts">
	import { browser } from '$app/environment';
	import { page } from '$app/state';
	import Disclosures from '$lib/Disclosures.svelte';
	import FundSearch from '$lib/FundSearch.svelte';
	import Hero from '$lib/Hero.svelte';
	import { parseBufferParam, parseSalaryParam } from '$lib/safe-window';
	import { isReducedConfidence, pickAnswerDate } from '$lib/select-date';

	let { data } = $props();

	const salary = $derived(
		parseSalaryParam(browser ? page.url.searchParams.get('salary') : '28')
	);
	const buffer = $derived(
		parseBufferParam(browser ? page.url.searchParams.get('buffer') : '2')
	);
	const answer = $derived(pickAnswerDate(data.fund, salary, buffer));
	const reduced = $derived(isReducedConfidence(data.fund));
</script>

<svelte:head>
	<title>{data.fund.name} · SIP Date Planner</title>
</svelte:head>

<div class="mb-6">
	<FundSearch />
</div>

<p class="mb-4 text-sm text-stone-500">{data.fund.house} · {data.fund.category}</p>
<h1 class="mb-6 font-serif text-2xl text-stone-900">{data.fund.name}</h1>

{#if reduced}
	<p class="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-950">
		Reduced confidence — this scheme has a shorter NAV history, so the rolling-window evidence is thin. The date below is still a valid safe-window pick, not a crash or a ranking.
	</p>
{/if}

<Hero fund={data.fund} {answer} />
<Disclosures fund={data.fund} {answer} {salary} {buffer} code={String(data.fund.code)} />
