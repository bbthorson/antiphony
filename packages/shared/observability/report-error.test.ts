import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildReportedErrorEvent, reportError } from './report-error';

const REPORTED_ERROR_EVENT_TYPE =
  'type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent';

describe('buildReportedErrorEvent', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.K_SERVICE;
    delete process.env.SERVICE_NAME;
    delete process.env.COMMIT_SHA;
    delete process.env.K_REVISION;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('shapes a ReportedErrorEvent with severity, @type, and serviceContext', () => {
    const event = buildReportedErrorEvent(new Error('boom'));
    expect(event.severity).toBe('ERROR');
    expect(event['@type']).toBe(REPORTED_ERROR_EVENT_TYPE);
    expect(event.serviceContext).toEqual({ service: 'unknown', version: 'dev' });
  });

  it('puts the full stack in message (Error Reporting fingerprints on it)', () => {
    const err = new Error('with stack');
    const event = buildReportedErrorEvent(err);
    expect(event.message).toBe(err.stack);
    expect(event.message).toContain('with stack');
  });

  it('falls back to name: message when there is no stack', () => {
    const err = new Error('no stack');
    err.stack = undefined;
    expect(buildReportedErrorEvent(err).message).toBe('Error: no stack');
  });

  it('normalizes non-Error throwables (string, object) without throwing', () => {
    expect(buildReportedErrorEvent('plain string').message).toContain('plain string');
    expect(buildReportedErrorEvent({ code: 42 }).message).toContain('42');
  });

  it('reads service + version from env (K_SERVICE / COMMIT_SHA)', () => {
    process.env.K_SERVICE = 'core-api';
    process.env.COMMIT_SHA = 'abc123';
    expect(buildReportedErrorEvent(new Error('x')).serviceContext).toEqual({
      service: 'core-api',
      version: 'abc123',
    });
  });

  it('includes context only when non-empty', () => {
    expect(buildReportedErrorEvent(new Error('x')).context).toBeUndefined();
    expect(buildReportedErrorEvent(new Error('x'), {}).context).toBeUndefined();
    const withCtx = buildReportedErrorEvent(new Error('x'), { requestId: 'r1' });
    expect(withCtx.context).toEqual({ requestId: 'r1' });
  });
});

describe('reportError', () => {
  it('emits exactly one single-line JSON entry to stderr', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      reportError(new Error('boom'), { requestId: 'r1' });
      expect(spy).toHaveBeenCalledTimes(1);
      const line = spy.mock.calls[0][0] as string;
      expect(line).not.toContain('\n');
      const parsed = JSON.parse(line);
      expect(parsed.severity).toBe('ERROR');
      expect(parsed.context).toEqual({ requestId: 'r1' });
    } finally {
      spy.mockRestore();
    }
  });

  it('never throws even if serialization is unhappy', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => reportError(undefined)).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});
