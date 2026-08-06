/**
 * Generates large CSV datasets for benchmark scale testing (up to 10M rows).
 * Usage: node scripts/generate-large-dataset.mjs [rowCount]
 */
import { createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { finished } from 'node:stream/promises';

const rowCount = Number(process.argv[2] ?? 1000000);
const outDir = new URL('../SapAnalytics.Client/wwwroot/sample-data/', import.meta.url);

async function writeCsv(name, headers, rowGenerator) {
  const path = new URL(name, outDir);
  const stream = createWriteStream(path);
  stream.write(headers.join(',') + '\n');
  for (let i = 0; i < rowCount; i++) {
    const row = rowGenerator(i);
    stream.write(row.join(',') + '\n');
  }
  stream.end();
  await finished(stream);
  const data = await import('node:fs/promises').then((fs) => fs.readFile(path));
  const checksum = createHash('sha256').update(data).digest('hex');
  return { fileName: name, byteSize: data.length, rowCount, checksumSha256: checksum };
}

const companies = await writeCsv(
  'companies-large.csv',
  ['company_id', 'name', 'region', 'group_id'],
  (i) => [i + 1, `Company ${i + 1}`, ['North', 'South', 'West'][i % 3], (i % 10) + 1]
);

const transactions = await writeCsv(
  'transactions-large.csv',
  ['transaction_id', 'company_id', 'fund_id', 'amount', 'period', 'transaction_date'],
  (i) => [
    i + 1,
    (i % 500) + 1,
    (i % 20) + 1,
    ((i * 17 % 10000) + (i % 100) * 0.37).toFixed(2),
    `2024-${String((i % 12) + 1).padStart(2, '0')}`,
    `2024-${String((i % 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
  ]
);

console.log(JSON.stringify({ rowCount, companies, transactions }, null, 2));
