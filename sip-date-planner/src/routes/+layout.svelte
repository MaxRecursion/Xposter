<script lang="ts">
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';

	let { children, data } = $props();
</script>

<svelte:head>
	<title>SIP Date Planner</title>
	<meta
		name="description"
		content="Which date of the month should you run your SIP? A concrete day, with an honest confidence grade."
	/>
	<link rel="icon" href={favicon} />
</svelte:head>

<div class="min-h-screen bg-stone-50 text-stone-900">
	<header class="mx-auto flex max-w-3xl items-baseline justify-between px-4 py-6">
		<a href="/" class="font-serif text-xl tracking-tight">SIP Date Planner</a>
		<p class="text-xs text-stone-500">NAV as of {data.meta.navAsOf}</p>
	</header>
	<main class="mx-auto max-w-3xl px-4 pb-16">
		{@render children()}
	</main>
	<footer class="mx-auto max-w-3xl px-4 pb-10 text-xs leading-relaxed text-stone-500">
		<p>
			Educational tool. Not investment advice. Past performance does not indicate future results. Data sourced from AMFI published NAVs via mfapi.in.
		</p>
		<p class="mt-2">{data.meta.fundCount} direct-growth schemes · pipeline {data.meta.pipelineVersion}</p>
	</footer>
</div>
