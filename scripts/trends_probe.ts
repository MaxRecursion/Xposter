/**
 * Dry-run: fetch X trends for both locations and show how each would be
 * classified. Touches the network and the DB, but posts nothing.
 *
 *   npm run trends:probe
 */
import '../src/env.js';
import { getDb } from '../src/storage/db.js';
import { fetchTrends, WOEID_INDIA, WOEID_WORLDWIDE } from '../src/trends/x_trends.js';
import { classifyTrendSafety, detectScript, isUsableScript } from '../src/trends/trend_filter.js';

function pad(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n);
}

async function probe(label: string, woeid: number): Promise<void> {
  process.stdout.write(`\n=== ${label} (WOEID ${woeid}) ===\n`);

  let trends;
  try {
    trends = await fetchTrends(woeid);
  } catch (err) {
    process.stdout.write(`FAILED: ${String(err)}\n`);
    return;
  }

  process.stdout.write(`${pad('#', 4)}${pad('TREND', 34)}${pad('SCRIPT', 12)}${pad('SAFETY', 22)}${pad('VOLUME', 10)}USE?\n`);
  process.stdout.write(`${'-'.repeat(92)}\n`);

  let usable = 0;
  for (const t of trends) {
    const script = detectScript(t.name);
    const safety = classifyTrendSafety(t.name);
    const wouldUse = isUsableScript(t.name) && safety.class !== 'SKIP';
    if (wouldUse) usable++;

    process.stdout.write(
      pad(String(t.rank), 4)
      + pad(t.name, 34)
      + pad(script, 12)
      + pad(`${safety.class}${safety.class === 'SAFE_FOR_CONTRARIAN' ? '' : ` (${safety.reason})`}`, 22)
      + pad(t.tweetVolume === null ? '-' : String(t.tweetVolume), 10)
      + (wouldUse ? 'yes' : 'no')
      + '\n',
    );
  }

  const contrarianOk = trends.filter(
    (t) => isUsableScript(t.name) && classifyTrendSafety(t.name).class === 'SAFE_FOR_CONTRARIAN',
  ).length;
  process.stdout.write(`\n${trends.length} trends · ${usable} usable · ${contrarianOk} eligible for a contrarian take\n`);
}

async function main(): Promise<void> {
  getDb(); // topic rules read settings, which needs the DB open
  await probe('WORLDWIDE', WOEID_WORLDWIDE);
  await probe('INDIA', WOEID_INDIA);
}

main().catch((err) => {
  process.stdout.write(`probe failed: ${String(err)}\n`);
  process.exit(1);
});
