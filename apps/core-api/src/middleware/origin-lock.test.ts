import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { originLock, ORIGIN_LOCK_HEADER, __resetOriginLockWarning } from './origin-lock.js';

/**
 * The lock's whole job is to distinguish "arrived through Cloudflare" from
 * "arrived at the *.run.app hostname directly". Cloudflare's contribution is a
 * single injected header, so that header is all these can simulate — which is
 * the honest limit of this suite. What it CANNOT prove is that Cloudflare is
 * actually injecting the header in production; only a live probe of both
 * hostnames shows that, and the header could be stripped or misspelled in the
 * Transform Rule with every test here still green.
 */

const SECRET = 'a'.repeat(48);

function appWithLock() {
    const a = new Hono();
    a.get('/health', (c) => c.json({ ok: true }));
    a.use('/api/v1/*', originLock());
    a.get('/api/v1/thing', (c) => c.json({ reached: true }));
    return a;
}

describe('originLock', () => {
    beforeEach(() => {
        __resetOriginLockWarning();
        delete process.env.ANTIPHONY_ORIGIN_SECRET;
    });

    afterEach(() => {
        delete process.env.ANTIPHONY_ORIGIN_SECRET;
    });

    describe('enforcing (secret set)', () => {
        beforeEach(() => {
            process.env.ANTIPHONY_ORIGIN_SECRET = SECRET;
        });

        it('allows a request carrying the correct header', async () => {
            const res = await appWithLock().request('/api/v1/thing', {
                headers: { [ORIGIN_LOCK_HEADER]: SECRET },
            });
            expect(res.status).toBe(200);
            expect(await res.json()).toEqual({ reached: true });
        });

        it('rejects a request with no header — the direct *.run.app case', async () => {
            const res = await appWithLock().request('/api/v1/thing');
            expect(res.status).toBe(403);
        });

        it('rejects a wrong header value', async () => {
            const res = await appWithLock().request('/api/v1/thing', {
                headers: { [ORIGIN_LOCK_HEADER]: 'b'.repeat(48) },
            });
            expect(res.status).toBe(403);
        });

        it('rejects a value that only shares a prefix', async () => {
            const res = await appWithLock().request('/api/v1/thing', {
                headers: { [ORIGIN_LOCK_HEADER]: SECRET.slice(0, 40) },
            });
            expect(res.status).toBe(403);
        });

        it('does not compare case-insensitively', async () => {
            const res = await appWithLock().request('/api/v1/thing', {
                headers: { [ORIGIN_LOCK_HEADER]: SECRET.toUpperCase() },
            });
            expect(res.status).toBe(403);
        });

        it('leaves /health open, so the deploy smoke test still works', async () => {
            // The candidate revision is probed on its *.run.app tag URL before
            // promotion — it is not behind Cloudflare and cannot carry the header.
            const res = await appWithLock().request('/health');
            expect(res.status).toBe(200);
        });
    });

    describe('open (secret unset or too short)', () => {
        it('passes traffic through when the secret is unset', async () => {
            const res = await appWithLock().request('/api/v1/thing');
            expect(res.status).toBe(200);
        });

        it('passes traffic through when the secret is below the length floor', async () => {
            // Treated as unset: a weak secret is a config problem, not grounds
            // for 403ing the entire API.
            process.env.ANTIPHONY_ORIGIN_SECRET = 'tooshort';
            const res = await appWithLock().request('/api/v1/thing');
            expect(res.status).toBe(200);
        });

        it('ignores a stray header while open', async () => {
            const res = await appWithLock().request('/api/v1/thing', {
                headers: { [ORIGIN_LOCK_HEADER]: 'anything at all' },
            });
            expect(res.status).toBe(200);
        });
    });
});
