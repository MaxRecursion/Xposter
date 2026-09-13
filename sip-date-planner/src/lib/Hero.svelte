<script lang="ts">
	import {
		historyYears,
		inr,
		inrCompactLakhs,
		investedNotional,
		justification,
		ordinal
	} from '$lib/select-date';
	import type { DateMetrics, FundArtifact } from '$lib/types';

	let { fund, answer }: { fund: FundArtifact; answer: DateMetrics } = $props();

	const years = $derived(historyYears(fund));
	const invested = $derived(investedNotional(fund));
	const ofCorpus = $derived(fund.spreadRupees / Math.max(answer.corpus, 1));
</script>

<section
	class="flex min-h-[22rem] flex-col justify-center rounded-3xl bg-emerald-950 px-6 py-10 text-emerald-50 sm:px-10"
	aria-live="polite"
>
	<p class="text-sm uppercase tracking-[0.2em] text-emerald-200/80">Run this SIP on the</p>
	<p class="mt-2 font-serif text-7xl leading-none sm:text-8xl">{ordinal(answer.d)}</p>
	<p class="mt-6 max-w-2xl text-lg text-emerald-50/95">{justification(fund, answer.d)}</p>
	<p class="mt-6 max-w-2xl text-sm text-emerald-100/80">
		Best vs worst date across the full history:
		<strong class="text-white">₹{inr(fund.spreadRupees)}</strong>
		on {inrCompactLakhs(invested)} invested — {(ofCorpus * 100).toFixed(1)}% of final corpus, over {years.toFixed(1)} years.
	</p>
	{#if fund.verdict === 'noise'}
		<p class="mt-3 text-xs font-medium uppercase tracking-wide text-amber-200">
			Verdict: noise — the date is a tiebreak inside your safe window, not an edge.
		</p>
	{:else if fund.verdict === 'marginal'}
		<p class="mt-3 text-xs font-medium uppercase tracking-wide text-amber-200">Verdict: marginal</p>
	{:else}
		<p class="mt-3 text-xs font-medium uppercase tracking-wide text-emerald-200">Verdict: meaningful</p>
	{/if}
</section>
