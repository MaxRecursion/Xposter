import { runJudgeEval } from '../eval/judge.js';
import { getBooleanSetting } from '../storage/settings.js';
import { logger } from '../utils/logger.js';

/**
 * Periodic LLM-as-judge pass over metric-synced replies (mirrors the reply
 * metrics sync scheduler). Runs after reply_metrics_sync so an interaction
 * usually already has last_metric_check set by the time the judge sees it.
 */

const EVAL_INTERVAL_MS = 2 * 60 * 60 * 1000;  // every 2 hours
const BOOT_DELAY_MS = 20 * 60_000;            // run after the first metrics sync settles

let _interval: NodeJS.Timeout | null = null;
let _bootTimer: NodeJS.Timeout | null = null;

export function startJudgeEvalScheduler(): void {
  if (_interval) return;
  _bootTimer = setTimeout(() => { void runIfEnabled(); }, BOOT_DELAY_MS);
  _interval = setInterval(() => { void runIfEnabled(); }, EVAL_INTERVAL_MS);
  logger.info('Judge eval scheduled', { everyHours: EVAL_INTERVAL_MS / 3_600_000 });
}

export function stopJudgeEvalScheduler(): void {
  if (_bootTimer) { clearTimeout(_bootTimer); _bootTimer = null; }
  if (_interval) { clearInterval(_interval); _interval = null; }
}

async function runIfEnabled(): Promise<void> {
  if (!getBooleanSetting('system_running', true)) return;
  await runJudgeEval();
}
