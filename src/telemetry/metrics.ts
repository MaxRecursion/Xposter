import { metrics } from '@opentelemetry/api';
import { getOtelServiceName, isOtelEnabled } from '../config.js';

const meter = () => metrics.getMeter(getOtelServiceName());

let pipelineRuns: ReturnType<ReturnType<typeof meter>['createCounter']> | null = null;
let pipelineDuration: ReturnType<ReturnType<typeof meter>['createHistogram']> | null = null;
let schedulerRuns: ReturnType<ReturnType<typeof meter>['createCounter']> | null = null;
let schedulerDuration: ReturnType<ReturnType<typeof meter>['createHistogram']> | null = null;
let pipelineSkipped: ReturnType<ReturnType<typeof meter>['createCounter']> | null = null;

export function initMetrics(): void {
  if (!isOtelEnabled()) return;
  const m = meter();
  pipelineRuns = m.createCounter('xposter.pipeline.runs', {
    description: 'Reply pipeline executions',
  });
  pipelineDuration = m.createHistogram('xposter.pipeline.duration_ms', {
    description: 'Reply pipeline wall-clock duration in milliseconds',
    unit: 'ms',
  });
  pipelineSkipped = m.createCounter('xposter.pipeline.skipped', {
    description: 'Reply pipeline runs skipped (overlap, paused, etc.)',
  });
  schedulerRuns = m.createCounter('xposter.scheduler.runs', {
    description: 'Scheduler job executions',
  });
  schedulerDuration = m.createHistogram('xposter.scheduler.duration_ms', {
    description: 'Scheduler job wall-clock duration in milliseconds',
    unit: 'ms',
  });
}

export function recordPipelineRun(attrs: {
  source: string;
  outcome: 'success' | 'error' | 'skipped';
  durationMs: number;
  ingested?: number;
  candidates?: number;
  skipReason?: string;
}): void {
  if (!pipelineRuns || !pipelineDuration) return;
  const labels = {
    source: attrs.source,
    outcome: attrs.outcome,
    ...(attrs.skipReason ? { skip_reason: attrs.skipReason } : {}),
  };
  if (attrs.outcome === 'skipped') {
    pipelineSkipped?.add(1, labels);
    return;
  }
  pipelineRuns.add(1, labels);
  pipelineDuration.record(attrs.durationMs, {
    source: attrs.source,
    outcome: attrs.outcome,
    ingested: String(attrs.ingested ?? 0),
    candidates: String(attrs.candidates ?? 0),
  });
}

export function recordSchedulerJob(
  job: string,
  outcome: 'success' | 'error',
  durationMs: number,
): void {
  if (!schedulerRuns || !schedulerDuration) return;
  const labels = { job, outcome };
  schedulerRuns.add(1, labels);
  schedulerDuration.record(durationMs, labels);
}
