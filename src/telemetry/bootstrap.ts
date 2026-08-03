import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  SEMRESATTRS_DEPLOYMENT_ENVIRONMENT,
} from '@opentelemetry/semantic-conventions';
import { WinstonInstrumentation } from '@opentelemetry/instrumentation-winston';
import {
  getNodeEnv,
  getOtelExporterEndpoint,
  getOtelServiceName,
  getOtelTracesSamplerArg,
  isOtelEnabled,
} from '../config.js';
import { initMetrics } from './metrics.js';

let sdk: NodeSDK | null = null;
let started = false;

export interface TelemetryStatus {
  enabled: boolean;
  started: boolean;
  endpoint: string | null;
  serviceName: string;
}

export function getTelemetryStatus(): TelemetryStatus {
  return {
    enabled: isOtelEnabled(),
    started,
    endpoint: getOtelExporterEndpoint(),
    serviceName: getOtelServiceName(),
  };
}

export function startTelemetry(): void {
  if (started || !isOtelEnabled()) return;

  const endpoint = getOtelExporterEndpoint();
  if (!endpoint) {
    console.warn('[telemetry] OTEL_ENABLED=true but OTEL_EXPORTER_OTLP_ENDPOINT is unset — telemetry disabled');
    return;
  }

  const base = endpoint.replace(/\/$/, '');
  const samplerArg = getOtelTracesSamplerArg();

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: getOtelServiceName(),
      [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? '1.0.0',
      [SEMRESATTRS_DEPLOYMENT_ENVIRONMENT]: getNodeEnv(),
    }),
    traceExporter: new OTLPTraceExporter({ url: `${base}/v1/traces` }),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${base}/v1/metrics` }),
      exportIntervalMillis: 15_000,
    }),
    logRecordProcessor: new BatchLogRecordProcessor(
      new OTLPLogExporter({ url: `${base}/v1/logs` }),
    ),
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
      }),
      new WinstonInstrumentation({
        disableLogCorrelation: false,
        disableLogSending: true,
      }),
    ],
    sampler: undefined,
  });

  // NodeSDK reads OTEL_TRACES_SAMPLER / OTEL_TRACES_SAMPLER_ARG from env when sampler is undefined.
  if (!process.env.OTEL_TRACES_SAMPLER_ARG) {
    process.env.OTEL_TRACES_SAMPLER_ARG = String(samplerArg);
  }
  if (!process.env.OTEL_TRACES_SAMPLER) {
    process.env.OTEL_TRACES_SAMPLER = 'parentbased_traceidratio';
  }

  sdk.start();
  initMetrics();
  started = true;
}

export async function shutdownTelemetry(): Promise<void> {
  if (!sdk) return;
  try {
    await sdk.shutdown();
  } finally {
    sdk = null;
    started = false;
  }
}
