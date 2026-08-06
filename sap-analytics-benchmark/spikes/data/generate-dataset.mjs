#!/usr/bin/env node
/**
 * Generates 1M-row heterogeneous benchmark dataset (CSV) matching sap-analytics schema.
 * Output: spikes/data/out/*.csv — copy or symlink into each app's wwwroot/data/
 *
 * Usage: node spikes/data/generate-dataset.mjs [--rows 1000000] [--out spikes/data/out]
 */
import { createWriteStream, mkdirSync, existsSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const rowArg = args.find((a) => a.startsWith('--rows='));
const outArg = args.find((a) => a.startsWith('--out='));
const txnRows = rowArg ? Number(rowArg.split('=')[1]) : 1_000_000;
const outDir = outArg ? outArg.split('=')[1] : join(__dirname, 'out');
const distRows = Math.max(1_000, Math.floor(txnRows / 10));

const regions = ['North', 'South', 'East', 'West'];
const categories = ['Equity', 'Debt', 'Mixed', 'Alternatives'];

mkdirSync(outDir, { recursive: true });

function writeCsv(fileName, header, rowGenerator) {
  const path = join(outDir, fileName);
  const stream = createWriteStream(path);
  stream.write(header + '\n');
  for (const line of rowGenerator()) stream.write(line + '\n');
  stream.end();
  console.log(`Wrote ${path}`);
}

writeCsv('companies.csv', 'company_id,name,region,group_id', function* () {
  for (let i = 1; i <= 500; i++) {
    yield [i, `Company ${i}`, regions[i % regions.length], (i % 50) + 1].join(',');
  }
});

writeCsv('funds.csv', 'fund_id,name,category', function* () {
  for (let i = 1; i <= 20; i++) {
    yield [i, `Fund ${i}`, categories[i % categories.length]].join(',');
  }
});

writeCsv('users.csv', 'user_id,name,region,company_id', function* () {
  for (let i = 1; i <= 1000; i++) {
    yield [i, `User ${i}`, regions[i % regions.length], (i % 500) + 1].join(',');
  }
});

writeCsv('transactions.csv', 'transaction_id,company_id,fund_id,amount,period,transaction_date', function* () {
  let seed = 42;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  for (let i = 1; i <= txnRows; i++) {
    const year = 2022 + (i % 3);
    const month = (i % 12) + 1;
    const amount = (rand() * 1000 + 1).toFixed(4);
    yield [
      i,
      (i % 500) + 1,
      (i % 20) + 1,
      amount,
      `${year}-${String(month).padStart(2, '0')}`,
      `${year}-${String(month).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
    ].join(',');
  }
});

writeCsv(
  'funds_distribution.csv',
  'distribution_id,fund_id,company_id,distribution_amount,period,distribution_date',
  function* () {
    let seed = 99;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };
    for (let i = 1; i <= distRows; i++) {
      const year = 2022 + (i % 3);
      const month = (i % 12) + 1;
      const amount = (rand() * 500 + 1).toFixed(4);
      yield [
        i,
        (i % 20) + 1,
        (i % 500) + 1,
        amount,
        `${year}-${String(month).padStart(2, '0')}`,
        `${year}-${String(month).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
      ].join(',');
    }
  }
);

// Symlink into app wwwroot/data if not present
const apps = ['WasmJsInterop', 'WasmNativePin', 'WasmDotNetWorker'];
const root = join(__dirname, '..', '..');
for (const app of apps) {
  const target = join(root, 'apps', app, 'wwwroot', 'data');
  if (!existsSync(target)) {
    try {
      symlinkSync(outDir, target, 'dir');
      console.log(`Linked ${target} -> ${outDir}`);
    } catch (err) {
      console.warn(`Could not symlink ${target}: ${err.message}. Copy CSV files manually.`);
    }
  }
}

console.log(`Done. ${txnRows.toLocaleString()} transactions, ${distRows.toLocaleString()} distributions.`);
