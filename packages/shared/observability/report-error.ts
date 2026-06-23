/**
 * GCP Cloud Error Reporting integration — log-based, dependency-free.
 *
 * Cloud Error Reporting auto-ingests Cloud Logging entries shaped as a
 * `ReportedErrorEvent`. On Firebase App Hosting (Cloud Run), single-line JSON
 * written to stderr lands in Cloud Logging automatically — so emitting a
 * correctly-shaped line is all it takes to surface a grouped, deduplicated
 * error in the Error Reporting console. No SDK, no auth, no secrets (the
 * `@google-cloud/error-reporting` library would add a gRPC client + cold-start
 * weight + credential config for the same outcome on serverless).
 *
 * See https://cloud.google.com/error-reporting/docs/formatting-error-messages
 *
 * Grouping rules we satisfy:
 *   - `severity` must be ERROR or higher.
 *   - `message` must contain a full stack trace (that's what Error Reporting
 *     fingerprints on); we fall back to "name: message" when no stack exists,
 *     which still surfaces, just grouped less precisely.
 *   - `serviceContext.service` separates errors per deployable
 *     (core-api / web / public), so each app's errors are tracked apart.
 *
 * This module only ever *runs* from server code (core-api error-handler,
 * Next instrumentation hooks, /api/client-error route handlers). It has no
 * Node-only or heavy imports, so it stays safe to live in the shared package.
 */

const REPORTED_ERROR_EVENT_TYPE =
  'type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent';

/**
 * Logical service name for the `serviceContext`. `K_SERVICE` is set
 * automatically by Cloud Run / App Hosting; `SERVICE_NAME` is an explicit
 * override for local/other runtimes.
 */
function serviceName(): string {
  return process.env.K_SERVICE ?? process.env.SERVICE_NAME ?? 'unknown';
}

/**
 * Deployed version for the `serviceContext`. `COMMIT_SHA` is wired by our
 * builds; `K_REVISION` is the Cloud Run revision fallback.
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
 * Report an error to GCP Error Reporting by emitting a single-line
 * ReportedErrorEvent to stderr. Best-effort and total — a failure inside the
 * reporter is swallowed so it can never mask the original error.
 */
export function reportError(err: unknown, context?: Record<string, unknown>): void {
  try {
    // Single line so Cloud Logging ingests it as one structured entry.
    console.error(JSON.stringify(buildReportedErrorEvent(err, context)));
  } catch {
    /* reporting is best-effort; never throw */
  }
}
