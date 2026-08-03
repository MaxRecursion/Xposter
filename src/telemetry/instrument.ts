import { SpanStatusCode, trace } from '@opentelemetry/api';
import { isOtelEnabled } from '../config.js';
import { recordPipelineRun, recordSchedulerJob } from './metrics.js';

const tracer = () => trace.getTracer('xposter');

export async function withSpan<T>(
  name: string,
  fn: (span: ReturnType<ReturnType<typeof tracer>['startSpan']>) => Promise<T>,
  attributes?: Record<string, string | number | boolean>,
): Promise<T> {
  if (!isOtelEnabled()) return fn(undefined as never);

  const span = tracer().startSpan(name, { attributes });
  try {
    const result = await fn(span);
    span.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (err) {
    span.recordException(err as Error);
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    span.end();
  }
}

export async function instrumentPipelineRun<T>(
  source: string,
  fn: () => Promise<{ ingested: number; candidates: number }>,
): Promise<{ ingested: number; candidates: number }> {
  const start = Date.now();
  if (!isOtelEnabled()) return fn();

  return withSpan('pipeline.reply.run', async (span) => {
    span?.setAttribute('pipeline.source', source);
    try {
      const result = await fn();
      span?.setAttribute('pipeline.ingested', result.ingested);
      span?.setAttribute('pipeline.candidates', result.candidates);
      recordPipelineRun({
        source,
        outcome: 'success',
        durationMs: Date.now() - start,
        ingested: result.ingested,
        candidates: result.candidates,
      });
      return result;
    } catch (err) {
      recordPipelineRun({
        source,
        outcome: 'error',
        durationMs: Date.now() - start,
      });
      throw err;
    }
  });
}

export function recordPipelineSkipped(source: string, reason: string): void {
  recordPipelineRun({
    source,
    outcome: 'skipped',
    durationMs: 0,
    skipReason: reason,
  });
}

export async function instrumentSchedulerJob<T>(
  job: string,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  if (!isOtelEnabled()) return fn();

  return withSpan(`scheduler.${job}`, async () => {
    try {
      const result = await fn();
      recordSchedulerJob(job, 'success', Date.now() - start);
      return result;
    } catch (err) {
      recordSchedulerJob(job, 'error', Date.now() - start);
      throw err;
    }
  });
}
