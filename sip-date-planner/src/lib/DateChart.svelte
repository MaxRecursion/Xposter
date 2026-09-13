<script lang="ts">
	import { onDestroy } from 'svelte';
	import uPlot from 'uplot';
	import 'uplot/dist/uPlot.min.css';
	import { safeWindow, type SalaryChoice } from '$lib/safe-window';
	import type { FundArtifact } from '$lib/types';

	let {
		fund,
		salary,
		buffer,
		answerDay
	}: {
		fund: FundArtifact;
		salary: SalaryChoice;
		buffer: number;
		answerDay: number;
	} = $props();

	let el = $state<HTMLDivElement | null>(null);
	let chart: uPlot | null = null;

	const windowSet = $derived(new Set(safeWindow(salary, buffer)));

	$effect(() => {
		if (!el) return;
		chart?.destroy();
		const xs = fund.dates.map((d) => d.d);
		const ys = fund.dates.map((d) => d.xirr);
		const inWin = fund.dates.map((d) => (windowSet.has(d.d) ? d.xirr : null));
		const outWin = fund.dates.map((d) => (windowSet.has(d.d) ? null : d.xirr));
		const ymin = Math.min(...ys);
		const ymax = Math.max(...ys);
		const pad = Math.max((ymax - ymin) * 0.35, 0.02);
		chart = new uPlot(
			{
				width: el.clientWidth || 640,
				height: 240,
				padding: [12, 8, 8, 8],
				legend: { show: false },
				scales: { x: { time: false }, y: { min: ymin - pad, max: ymax + pad } },
				axes: [
					{ stroke: '#57534e', grid: { show: false }, ticks: { show: false } },
					{
						stroke: '#57534e',
						grid: { stroke: '#e7e5e4' },
						values: (_u, splits) => splits.map((v) => v.toFixed(2) + '%')
					}
				],
				series: [
					{ label: 'Date' },
					{
						label: 'Safe window',
						stroke: '#065f46',
						fill: 'rgba(6, 95, 70, 0.55)',
						paths: uPlot.paths.bars!({ size: [0.7, 20] })
					},
					{
						label: 'Outside window',
						stroke: '#a8a29e',
						fill: 'rgba(168, 162, 158, 0.35)',
						paths: uPlot.paths.bars!({ size: [0.7, 20] })
					}
				]
			},
			[xs, inWin, outWin],
			el
		);
		void answerDay;
		return () => {
			chart?.destroy();
			chart = null;
		};
	});

	onDestroy(() => {
		chart?.destroy();
	});
</script>

<div bind:this={el} class="w-full"></div>
<p class="mt-2 text-xs text-stone-500">
	Y-axis is zoomed to this fund’s actual XIRR range so the flatness is visible. Green bars are dates inside your safe window.
</p>
