import { gzipSync } from 'node:zlib';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const BUILD = join(process.cwd(), 'build');
const MAX_WITHOUT_UPLOT = 60 * 1024;
const MAX_WITH_UPLOT = 110 * 1024;

async function walk(dir, acc = []) {
	const ents = await readdir(dir, { withFileTypes: true });
	for (const ent of ents) {
		const p = join(dir, ent.name);
		if (ent.isDirectory()) await walk(p, acc);
		else if (ent.name.endsWith('.js')) acc.push(p);
	}
	return acc;
}

function gzipSize(buf) {
	return gzipSync(buf).length;
}

const files = await walk(join(BUILD, '_app'));
let withPlot = 0;
let without = 0;
for (const f of files) {
	const buf = await readFile(f);
	const gz = gzipSize(buf);
	const isPlot = /uplot/i.test(f) || /uplot/i.test(buf.toString('utf8').slice(0, 2000));
	withPlot += gz;
	if (!isPlot) without += gz;
	console.log(`${gz}\t${isPlot ? 'uplot~' : ''}${f.replace(BUILD, '')}`);
}

console.log(`gzip JS excluding uPlot: ${without} (budget ${MAX_WITHOUT_UPLOT})`);
console.log(`gzip JS including uPlot: ${withPlot} (budget ${MAX_WITH_UPLOT})`);

if (without > MAX_WITHOUT_UPLOT) {
	console.error('Bundle exceeds 60 KB gzipped excluding uPlot');
	process.exit(1);
}
if (withPlot > MAX_WITH_UPLOT) {
	console.error('Bundle exceeds 110 KB gzipped including uPlot');
	process.exit(1);
}

const index = await readFile(join(BUILD, 'data/index.json'));
const indexGz = gzipSize(index);
console.log(`index.json gzip: ${indexGz} (budget ${120 * 1024})`);
if (indexGz > 120 * 1024) {
	console.error('index.json gzip exceeds 120 KB');
	process.exit(1);
}

await stat(join(BUILD, 'data/meta.json'));
console.log('bundle budgets ok');
