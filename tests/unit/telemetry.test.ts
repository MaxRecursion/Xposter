import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getOtelExporterEndpoint,
  getOtelServiceName,
  getOtelTracesSamplerArg,
  isOtelEnabled,
} from '../../src/config.js';

const ENV_KEYS = [
  'NODE_ENV',
  'OTEL_ENABLED',
  'OTEL_SERVICE_NAME',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_TRACES_SAMPLER_ARG',
];

const savedEnv = new Map<string, string | undefined>();

describe('OpenTelemetry config', () => {
  beforeEach(() => {
    savedEnv.clear();
    for (const key of ENV_KEYS) {
      savedEnv.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('is disabled by default', () => {
    expect(isOtelEnabled()).toBe(false);
  });

  it('stays disabled in test environment even when OTEL_ENABLED=true', () => {
    process.env.OTEL_ENABLED = 'true';
    process.env.NODE_ENV = 'test';
    expect(isOtelEnabled()).toBe(false);
  });

  it('enables when OTEL_ENABLED=true outside test', () => {
    process.env.OTEL_ENABLED = 'true';
    process.env.NODE_ENV = 'development';
    expect(isOtelEnabled()).toBe(true);
  });

  it('defaults service name and sampler', () => {
    expect(getOtelServiceName()).toBe('xposter');
    expect(getOtelTracesSamplerArg()).toBe(1);
    expect(getOtelExporterEndpoint()).toBeNull();
  });

  it('reads exporter endpoint and sampler from env', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:4318';
    process.env.OTEL_TRACES_SAMPLER_ARG = '0.25';
    process.env.OTEL_SERVICE_NAME = 'xposter-dev';
    expect(getOtelExporterEndpoint()).toBe('http://127.0.0.1:4318');
    expect(getOtelTracesSamplerArg()).toBe(0.25);
    expect(getOtelServiceName()).toBe('xposter-dev');
  });
});
