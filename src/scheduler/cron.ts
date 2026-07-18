import { expireOldPending } from '../storage/queries.js';
import { logger } from '../utils/logger.js';
import {
  configureRandomRuns, startRandomScheduler, stopRandomScheduler,
} from './random_runs.js';
import { startFollowerSync, stopFollowerSync } from './follower_sync.js';
import { startFollowBackProcessor, stopFollowBackProcessor } from './follow_back_processor.js';
import { startOriginalPostScheduler, stopOriginalPostScheduler } from './original_posts.js';
import { startAudienceSync, stopAudienceSync } from './audience_sync.js';
import { startReplyMetricsSync, stopReplyMetricsSync } from './reply_metrics_sync.js';
import { startSessionHealthWatchdog, stopSessionHealthWatchdog } from './session_health.js';
import { startWeeklyDigestScheduler, stopWeeklyDigestScheduler } from './weekly_digest.js';
import { startAgentWatcher, stopAgentWatcher } from '../agent/watcher.js';
import { startLikesScheduler, stopLikesScheduler } from './likes.js';
import { startImagePostScheduler, stopImagePostScheduler } from './image_posts.js';
import { isContextEnabled, getContextStore } from '../context/enrich.js';
import { buildContextSources } from '../context/sources/index.js';
import { startContextIngest, stopContextIngest } from '../context/ingest/scheduler.js';
import { isReplyPipelineRunning, runReplyPipeline } from '../pipeline/reply_pipeline.js';
import { primeClaudeCliCheck } from '../pipeline/claude_generator.js';

let _expiryHandle: NodeJS.Timeout | null = null;

export function startScheduler(): void {
  // Prime Claude CLI availability check so isClaudeAvailable() is accurate immediately
  void primeClaudeCliCheck();

  // The pipeline cron is now driven by random_runs.ts.
  configureRandomRuns(async () => { await runPipeline(); });
  startRandomScheduler();
  startFollowerSync();
  startFollowBackProcessor();
  startOriginalPostScheduler();
  startAudienceSync();
  startReplyMetricsSync();
  startSessionHealthWatchdog();
  startWeeklyDigestScheduler();
  startAgentWatcher();
  startLikesScheduler();
  startImagePostScheduler();

  if (isContextEnabled()) {
    const store = getContextStore();
    if (store) {
      const sources = buildContextSources();
      if (sources.length > 0) {
        startContextIngest(sources, store);
        logger.info('Context ingest started', { sources: sources.map((s) => s.name) });
      } else {
        logger.warn('CONTEXT_ENABLED=true but no sources configured');
      }
    }
  }

  // Expiry sweep: every 5 minutes
  if (!_expiryHandle) {
    _expiryHandle = setInterval(() => {
      const expired = expireOldPending();
      if (expired > 0) logger.info(`Expired ${expired} stale pending posts`);
    }, 5 * 60_000);
  }

  logger.info('Scheduler started (randomized 5x daily + follower sync)');
}

export function stopScheduler(): void {
  stopRandomScheduler();
  stopFollowerSync();
  stopFollowBackProcessor();
  stopOriginalPostScheduler();
  stopAudienceSync();
  stopReplyMetricsSync();
  stopSessionHealthWatchdog();
  stopWeeklyDigestScheduler();
  stopAgentWatcher();
  stopLikesScheduler();
  stopImagePostScheduler();
  stopContextIngest();
  if (_expiryHandle) {
    clearInterval(_expiryHandle);
    _expiryHandle = null;
  }
  logger.info('Scheduler stopped');
}

/** Manually trigger a pipeline run (also called by the random scheduler). */
export async function runPipeline(): Promise<{ ingested: number; candidates: number }> {
  return runReplyPipeline();
}

export function isPipelineRunning(): boolean {
  return isReplyPipelineRunning();
}
