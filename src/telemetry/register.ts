/**
 * OpenTelemetry bootstrap entrypoint.
 *
 * Loaded via Node's --import flag before the main module so auto-instrumentation
 * can patch http/express before those modules are evaluated.
 */
import '../env.js';
import { startTelemetry } from './bootstrap.js';

startTelemetry();
