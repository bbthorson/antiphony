/**
 * Structured error reporting — log-based, dependency-free.
 *
 * `reportError` writes one single-line JSON entry to stderr. On Cloudflare
 * Workers (core-api) that line lands in Workers Logs as a structured entry
 * with no SDK, binding, or credential involved; any other host that collects
 * stderr as JSON gets the same.
 *
 * The entry is shaped as a Google Cloud `ReportedErrorEvent`, a documented,
 * vendor-neutral-enough envelope (severity + full stack + service/version) that
 * a log pipeline can group on, and which Cloud Error Reporting ingests as-is if
 * the logs are ever shipped there. See
 * https://cloud.google.com/error-reporting/docs/formatting-error-messages
 *
 * What the shape guarantees:
 *   - `severity` is always ERROR.
 *   - `message` carries the full stack trace (what grouping fingerprints on);
 *     it falls back to "name: message" when no stack exists.
 *   - `serviceContext` names the deployable and its version, so errors from
 *     different services and releases are told apart.
 *
 * Callers: core-api's REST error handler and its XRPC error mapper, on the
 * unknown-500 path only. The module has no Node-only or heavy imports, so it
 * is safe to ship in the shared package.
 */

const REPORTED_ERROR_EVENT_TYPE =
  'type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent';

/**
 * Logical service name for the `serviceContext`: `K_SERVICE` (set automatically
 * on Cloud Run), else an explicit `SERVICE_NAME`, else `'unknown'`.
 */
function serviceName(): string {
  return process.env.K_SERVICE ?? process.env.SERVICE_NAME ?? 'unknown';
}

/**
 * Deployed version for the `serviceContext`. `COMMIT_SHA` is set as a Worker
 * var by the core-api deploy workflow; `K_REVISION` is the Cloud Run revision
 * fallback; `'dev'` otherwise.
 */
function serviceVersion(): string {
  return process.env.COMMIT_SHA ?? process.env.K_REVISION ?? 'dev';
}

/** Best-effort stringify for non-Error throwables; never throws. */
function formatUnknownError(err: unknown): string {
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

export interface ReportedErrorEvent {
  severity: 'ERROR';
  '@type': string;
  message: string;
  serviceContext: { service: string; version: string };
  context?: Record<string, unknown>;
}

/**
 * Build the `ReportedErrorEvent` payload. Exported for unit testing; most
 * callers want `reportError` instead.
 */
export function buildReportedErrorEvent(
  err: unknown,
  context?: Record<string, unknown>,
): ReportedErrorEvent {
  const error = err instanceof Error ? err : new Error(formatUnknownError(err));
  const message = error.stack ?? `${error.name}: ${error.message}`;
  return {
    severity: 'ERROR',
    '@type': REPORTED_ERROR_EVENT_TYPE,
    message,
    serviceContext: { service: serviceName(), version: serviceVersion() },
    ...(context && Object.keys(context).length > 0 ? { context } : {}),
  };
}

/**
 * Report an error by emitting a single-line `ReportedErrorEvent` to stderr. Best-effort and total — a failure inside the
 * reporter is swallowed so it can never mask the original error.
 */
export function reportError(err: unknown, context?: Record<string, unknown>): void {
  try {
    // Single line so the log pipeline ingests it as one structured entry.
    console.error(JSON.stringify(buildReportedErrorEvent(err, context)));
  } catch {
    /* reporting is best-effort; never throw */
  }
}
