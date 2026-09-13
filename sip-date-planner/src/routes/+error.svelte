<script lang="ts">
	import { page } from '$app/state';
</script>

<h1 class="font-serif text-3xl">Page not found</h1>
<p class="mt-3 text-stone-600">No fund at <code>{page.url.pathname}</code>.</p>
<p class="mt-4"><a class="underline" href="/">Back to search</a></p>
