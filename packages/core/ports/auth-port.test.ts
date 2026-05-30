import { describe, it, expect } from 'vitest';
import {
    AuthStateSchema,
    AuthErrorSchema,
    ok,
    err,
    type AuthState,
    type AuthError,
    type Result,
} from './auth-port';

/**
 * Tests for the Zod schemas defined in `auth-port.ts`. These pin the
 * canonical shape — Step 2's `FirebaseAuthAdapter` will round-trip
 * its emitted state through these schemas in dev builds (planned but
 * not part of this PR), so a schema regression here would surface
 * immediately when the adapter lands.
 */

describe('AuthStateSchema', () => {
    it('accepts the hydrating variant', () => {
        const parsed = AuthStateSchema.parse({ status: 'hydrating' });
        expect(parsed).toEqual({ status: 'hydrating' });
    });

    it('accepts a signed-in variant with phoneNumber set', () => {
        const input: AuthState = {
            status: 'signed-in',
            user: { uid: 'u-1', phoneNumber: '+15555550100' },
        };
        const parsed = AuthStateSchema.parse(input);
        expect(parsed).toEqual(input);
    });

    it('accepts a signed-in variant with phoneNumber null (handle-only user)', () => {
        const parsed = AuthStateSchema.parse({
            status: 'signed-in',
            user: { uid: 'u-2', phoneNumber: null },
        });
        expect(parsed.status).toBe('signed-in');
    });

    it('accepts signed-out', () => {
        const parsed = AuthStateSchema.parse({ status: 'signed-out' });
        expect(parsed).toEqual({ status: 'signed-out' });
    });

    it('accepts refresh-failed with a lastKnownUid', () => {
        const input: AuthState = {
            status: 'refresh-failed',
            lastKnownUid: 'u-3',
            error: 'network unreachable',
        };
        const parsed = AuthStateSchema.parse(input);
        expect(parsed).toEqual(input);
    });

    it('accepts refresh-failed with lastKnownUid null (cleared / corrupted session)', () => {
        // Some failure paths can't recover the pre-failure uid —
        // corrupted local storage, a cleared session in another tab,
        // an adapter that observes the refresh failure before it has
        // access to the previous identity. Emitters that DO know the
        // uid populate it; emitters that don't emit `null` rather
        // than omitting the field.
        const input: AuthState = {
            status: 'refresh-failed',
            lastKnownUid: null,
            error: 'session cleared in another tab',
        };
        const parsed = AuthStateSchema.parse(input);
        expect(parsed).toEqual(input);
    });

    it('rejects refresh-failed with lastKnownUid omitted', () => {
        // Nullable, not optional — omission is a schema violation,
        // matching the `phoneNumber` rule on `signed-in`.
        const result = AuthStateSchema.safeParse({
            status: 'refresh-failed',
            error: 'x',
        });
        expect(result.success).toBe(false);
    });

    it('rejects an unknown status', () => {
        const result = AuthStateSchema.safeParse({ status: 'logging-in' });
        expect(result.success).toBe(false);
    });

    it('rejects signed-in without a user', () => {
        const result = AuthStateSchema.safeParse({ status: 'signed-in' });
        expect(result.success).toBe(false);
    });

    it('rejects signed-in with a non-nullable phoneNumber omitted', () => {
        // `phoneNumber` is nullable, not optional — omitting it is a
        // schema violation. Adapters that don't have a number must
        // emit `null` explicitly.
        const result = AuthStateSchema.safeParse({
            status: 'signed-in',
            user: { uid: 'u-4' },
        });
        expect(result.success).toBe(false);
    });
});

describe('AuthErrorSchema', () => {
    it('accepts not-signed-in (no extra fields)', () => {
        const parsed = AuthErrorSchema.parse({ code: 'not-signed-in' });
        expect(parsed).toEqual({ code: 'not-signed-in' });
    });

    it('accepts hydrating', () => {
        const parsed = AuthErrorSchema.parse({ code: 'hydrating' });
        expect(parsed.code).toBe('hydrating');
    });

    it('accepts refresh-failed with a cause string', () => {
        const input: AuthError = { code: 'refresh-failed', cause: 'token revoked' };
        const parsed = AuthErrorSchema.parse(input);
        expect(parsed).toEqual(input);
    });

    it('rejects refresh-failed without a cause', () => {
        const result = AuthErrorSchema.safeParse({ code: 'refresh-failed' });
        expect(result.success).toBe(false);
    });

    it('accepts session-lost', () => {
        const parsed = AuthErrorSchema.parse({ code: 'session-lost' });
        expect(parsed.code).toBe('session-lost');
    });

    it('accepts verification-misconfigured with a cause string', () => {
        const input: AuthError = {
            code: 'verification-misconfigured',
            cause: 'Invalid domain for site key',
        };
        const parsed = AuthErrorSchema.parse(input);
        expect(parsed).toEqual(input);
    });

    it('accepts invalid-credential with each `which` enum value', () => {
        for (const which of ['phone', 'code', 'token'] as const) {
            const input: AuthError = { code: 'invalid-credential', which };
            const parsed = AuthErrorSchema.parse(input);
            expect(parsed).toEqual(input);
        }
    });

    it('rejects invalid-credential with an unknown `which`', () => {
        const result = AuthErrorSchema.safeParse({
            code: 'invalid-credential',
            which: 'fingerprint',
        });
        expect(result.success).toBe(false);
    });

    it('accepts rate-limited without retryAfterSeconds', () => {
        const parsed = AuthErrorSchema.parse({ code: 'rate-limited' });
        expect(parsed.code).toBe('rate-limited');
    });

    it('accepts rate-limited with retryAfterSeconds', () => {
        const input: AuthError = { code: 'rate-limited', retryAfterSeconds: 30 };
        const parsed = AuthErrorSchema.parse(input);
        expect(parsed).toEqual(input);
    });

    it('accepts internal-error with a cause string', () => {
        const input: AuthError = {
            code: 'internal-error',
            cause: 'Firebase: Unknown error',
        };
        const parsed = AuthErrorSchema.parse(input);
        expect(parsed).toEqual(input);
    });

    it('rejects internal-error without a cause', () => {
        const result = AuthErrorSchema.safeParse({ code: 'internal-error' });
        expect(result.success).toBe(false);
    });

    it('rejects an unknown error code', () => {
        const result = AuthErrorSchema.safeParse({ code: 'mystery' });
        expect(result.success).toBe(false);
    });
});

describe('Result<T, E> helpers', () => {
    it('ok() narrows ok to true and value to T', () => {
        const r: Result<number, AuthError> = ok(42);
        // Compile-time check: if r.ok is true, value is number.
        if (r.ok) {
            const v: number = r.value;
            expect(v).toBe(42);
        } else {
            throw new Error('expected ok');
        }
    });

    it('err() narrows ok to false and error to E', () => {
        const r: Result<number, AuthError> = err({ code: 'not-signed-in' });
        if (!r.ok) {
            // Discriminated union narrowing — error.code is a literal here.
            const code: AuthError['code'] = r.error.code;
            expect(code).toBe('not-signed-in');
        } else {
            throw new Error('expected err');
        }
    });

    it('exhaustive switching on AuthError.code is enforced at the type level', () => {
        // This test documents the exhaustiveness pattern. If a new
        // variant is added to AuthErrorSchema, the `never` assignment
        // in the default case will fail to compile — so this is the
        // canary that drives the Step 5 message catalog migration.
        function describe(error: AuthError): string {
            switch (error.code) {
                case 'not-signed-in':
                    return 'Sign in to continue.';
                case 'hydrating':
                    return 'One moment…';
                case 'refresh-failed':
                    return `Session expired (${error.cause}). Sign in again.`;
                case 'session-lost':
                    return 'Session lost. Sign in again.';
                case 'verification-misconfigured':
                    return `Verification setup issue: ${error.cause}`;
                case 'invalid-credential':
                    return error.which === 'phone'
                        ? 'Invalid phone number.'
                        : error.which === 'code'
                            ? 'Invalid code.'
                            : 'Invalid token.';
                case 'rate-limited':
                    return error.retryAfterSeconds
                        ? `Too many attempts. Try again in ${error.retryAfterSeconds}s.`
                        : 'Too many attempts. Please wait and try again.';
                case 'internal-error':
                    return `Something went wrong (${error.cause}). Please try again.`;
                default: {
                    // If a new code is added without updating this switch,
                    // TypeScript will reject this line at compile time.
                    const _exhaustive: never = error;
                    return _exhaustive;
                }
            }
        }
        expect(describe({ code: 'not-signed-in' })).toMatch(/Sign in/);
        expect(describe({ code: 'refresh-failed', cause: 'x' })).toMatch(/expired/);
        expect(describe({ code: 'invalid-credential', which: 'code' })).toBe('Invalid code.');
        expect(describe({ code: 'rate-limited', retryAfterSeconds: 30 })).toMatch(/30s/);
        expect(describe({ code: 'internal-error', cause: 'oops' })).toMatch(/oops/);
    });
});
