<script lang="ts">
	import { goto } from '$app/navigation';
	import { salaryToParam, type SalaryChoice } from '$lib/safe-window';
	import { inr, missedInstalmentCost, ordinal } from '$lib/select-date';
	import type { DateMetrics, FundArtifact } from '$lib/types';
	const loadChart = () => import('$lib/DateChart.svelte');

	let {
		fund,
		answer,
		salary,
		buffer
	}: {
		fund: FundArtifact;
		answer: DateMetrics;
		salary: SalaryChoice;
		buffer: number;
		code: string;
	} = $props();

	let openChart = $state(false);
	let openConf = $state(false);
	let openMatters = $state(false);
	let showAdvanced = $state(false);

	const missed = $derived(missedInstalmentCost(fund));

	function pushParams(nextSalary: SalaryChoice, nextBuffer: number) {
		void goto(`/f/${fund.code}?salary=${salaryToParam(nextSalary)}&buffer=${nextBuffer}`, {
			keepFocus: true,
			noScroll: true
		});
	}

	function onSalary(e: Event) {
		const v = (e.currentTarget as HTMLSelectElement).value;
		pushParams(v === 'lwd' ? 'lwd' : Number(v), buffer);
	}

	function onBuffer(e: Event) {
		pushParams(salary, Number((e.currentTarget as HTMLInputElement).value));
	}
</script>

<div class="mt-6 text-sm text-stone-600">
	<label class="flex flex-wrap items-center gap-2">
		<span>Salary credit date</span>
		<select
			class="rounded-lg border border-stone-300 bg-white px-2 py-1"
			value={salary === 'lwd' ? 'lwd' : String(salary)}
			onchange={onSalary}
		>
			<option value="lwd">Last working day of the month</option>
			{#each Array.from({ length: 27 }, (_, i) => i + 1) as d}
				<option value={String(d)}>{ordinal(d)}</option>
			{/each}
		</select>
	</label>
	<p class="mt-2 max-w-xl text-xs text-stone-500">
		A bounced instalment costs more than the entire date spread. The recommended day always stays inside the window that is fundable after salary clears.
	</p>
	<button type="button" class="mt-2 text-xs underline" onclick={() => (showAdvanced = !showAdvanced)}>
		{showAdvanced ? 'Hide' : 'Advanced'}: settlement buffer
	</button>
	{#if showAdvanced}
		<label class="mt-2 flex items-center gap-2 text-xs">
			Buffer (days after salary)
			<input
				class="w-16 rounded border border-stone-300 px-2 py-1"
				type="number"
				min="0"
				max="10"
				value={buffer}
				onchange={onBuffer}
			/>
		</label>
	{/if}
</div>

<div class="mt-10 space-y-3">
	<details
		class="rounded-2xl border border-stone-200 bg-white px-4 py-3"
		ontoggle={(e) => (openChart = (e.currentTarget as HTMLDetailsElement).open)}
	>
		<summary class="cursor-pointer font-medium text-stone-900">Full date curve</summary>
		{#if openChart}
			<div class="pt-4">
				{#await loadChart() then mod}
					<mod.default {fund} {salary} {buffer} answerDay={answer.d} />
				{/await}
			</div>
		{/if}
	</details>

	<details class="rounded-2xl border border-stone-200 bg-white px-4 py-3" ontoggle={(e) => (openConf = (e.currentTarget as HTMLDetailsElement).open)}>
		<summary class="cursor-pointer font-medium text-stone-900">How confident is this?</summary>
		{#if openConf}
			<dl class="mt-3 grid gap-2 text-sm text-stone-700">
				<div><dt class="text-stone-500">Split-half stability (Spearman)</dt><dd class="font-medium">{fund.stability.toFixed(3)}</dd></div>
				<div><dt class="text-stone-500">Top-quartile rate for the {ordinal(answer.d)}</dt><dd class="font-medium">{(answer.topQ * 100).toFixed(1)}% of rolling 3-year windows</dd></div>
				<div><dt class="text-stone-500">Mean percentile for the {ordinal(answer.d)}</dt><dd class="font-medium">{answer.meanPct.toFixed(1)}</dd></div>
				<div>
					<dt class="text-stone-500">XIRR vs corpus winner</dt>
					<dd class="font-medium">
						{#if fund.metricsAgree}
							The highest-XIRR date is also the highest-corpus date.
						{:else}
							The highest-XIRR date and the highest-corpus date differ, which indicates noise.
						{/if}
					</dd>
				</div>
			</dl>
		{/if}
	</details>

	<details class="rounded-2xl border border-stone-200 bg-white px-4 py-3" ontoggle={(e) => (openMatters = (e.currentTarget as HTMLDetailsElement).open)}>
		<summary class="cursor-pointer font-medium text-stone-900">What actually matters</summary>
		{#if openMatters}
			<p class="mt-3 max-w-2xl text-sm text-stone-700">
				One missed ₹10,000 instalment in this fund would have grown to about
				<strong>₹{inr(missed)}</strong>
				by the end of the history. The entire best-versus-worst SIP-date spread is
				<strong>₹{inr(fund.spreadRupees)}</strong>.
				{#if missed > fund.spreadRupees}
					Skipping a month costs more than picking any date in 1–28.
				{:else}
					The date spread is unusually large versus a single missed debit — treat that as a caution, not a ranking of funds.
				{/if}
			</p>
		{/if}
	</details>
</div>
