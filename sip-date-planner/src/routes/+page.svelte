<script lang="ts">
	import FundSearch from '$lib/FundSearch.svelte';
</script>

<h1 class="font-serif text-4xl leading-tight text-stone-900 sm:text-5xl">
	Which date should you run your SIP?
</h1>
<p class="mt-4 max-w-xl text-stone-600">
	Type a fund. Get one date. Historical analysis shows the SIP date barely moves XIRR — typically about 0.1 percentage points over a decade. This tool still names a day, then tells you if that day is signal or a coin flip.
</p>
<div class="mt-8">
	<FundSearch autofocus />
</div>
