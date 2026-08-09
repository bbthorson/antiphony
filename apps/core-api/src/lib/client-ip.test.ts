import { describe, it, expect, vi, afterEach } from 'vitest';
import { extractClientIp } from './client-ip.js';

/**
 * Tests for the X-Forwarded-For client-IP extraction (H5 fix).
 *
 * The block below exercises the DEFAULT hop count of 2 — the Firebase App
 * Hosting shape `<client>, <GCLB 35.219.x>, <GFE 192.178.13.x>`, where the
 * client is two hops in from the right. That is no longer this deployment's
 * topology (see the Cloudflare block at the bottom), but it remains what an
 * unset `TRUSTED_PROXY_HOPS` selects, so it is still the behaviour to pin.
 */
const GCLB = '35.219.200.199'; // stable Google Cloud LB hop (2nd from right)
const GFE = '192.178.13.5'; // Google Front End hop (rightmost)

/** A realistic chain: optional spoofed prefix entries, then client + 2 Google hops. */
const chain = (...leading: string[]) => [...leading, GCLB, GFE].join(', ');

describe('extractClientIp', () => {
    it('returns the client (third-from-right), not the trailing Google hops', () => {
        expect(extractClientIp(chain('203.0.113.7'))).toBe('203.0.113.7');
    });

    it('matches the exact production chain shape (client, GCLB, GFE)', () => {
        expect(extractClientIp('208.255.70.120,35.219.200.199,192.178.13.65')).toBe('208.255.70.120');
    });

    it('ignores a client-spoofed leading XFF entry', () => {
        // Client prepends their own XFF; the edge appends <real-client>,GCLB,GFE.
        expect(extractClientIp(chain('1.2.3.4', '203.0.113.7'))).toBe('203.0.113.7');
    });

    it('does NOT return either Google infra hop (the old H5 bug picked the GCLB)', () => {
        const out = extractClientIp(chain('203.0.113.7'));
        expect(out).not.toBe(GCLB);
        expect(out).not.toBe(GFE);
    });

    it('returns "unknown" for chains shorter than client + 2 trusted hops', () => {
        // Local/dev or a misrouted request — fail safe rather than trust a value
        // the trusted edge didn't append.
        expect(extractClientIp('203.0.113.7')).toBe('unknown');
        expect(extractClientIp(`203.0.113.7, ${GFE}`)).toBe('unknown'); // only 2 entries
    });

    it('returns "unknown" when the header is absent or empty', () => {
        expect(extractClientIp(undefined)).toBe('unknown');
        expect(extractClientIp('')).toBe('unknown');
        expect(extractClientIp('   ')).toBe('unknown');
    });

    it('collapses a private/loopback client to "unknown"', () => {
        expect(extractClientIp(chain('10.0.0.5'))).toBe('unknown');
        expect(extractClientIp(chain('192.168.1.10'))).toBe('unknown');
        expect(extractClientIp(chain('172.16.0.1'))).toBe('unknown');
        expect(extractClientIp(chain('127.0.0.1'))).toBe('unknown');
        expect(extractClientIp(chain('::1'))).toBe('unknown');
    });

    it('tolerates extra whitespace and empty segments', () => {
        expect(extractClientIp(`  203.0.113.7 , ${GCLB} ,  ${GFE} `)).toBe('203.0.113.7');
        expect(extractClientIp(`203.0.113.7,, ${GCLB}, ${GFE}`)).toBe('203.0.113.7');
    });

    it('passes through an IPv6 client address', () => {
        expect(extractClientIp(chain('2001:db8::1'))).toBe('2001:db8::1');
    });

    it('collapses extended reserved ranges (loopback/8, link-local, 0/8)', () => {
        expect(extractClientIp(chain('127.5.5.5'))).toBe('unknown'); // 127/8, not just .0.0.1
        expect(extractClientIp(chain('169.254.1.1'))).toBe('unknown'); // IPv4 link-local
        expect(extractClientIp(chain('0.0.0.0'))).toBe('unknown'); // 0/8
    });

    it('collapses IPv6 unique-local and link-local clients', () => {
        expect(extractClientIp(chain('fc00::1'))).toBe('unknown'); // ULA
        expect(extractClientIp(chain('fd12:3456::1'))).toBe('unknown'); // ULA
        expect(extractClientIp(chain('fe80::1'))).toBe('unknown'); // link-local
    });

    it('unwraps IPv4-mapped IPv6 addresses', () => {
        expect(extractClientIp(chain('::ffff:203.0.113.7'))).toBe('203.0.113.7');
        expect(extractClientIp(chain('::ffff:10.0.0.1'))).toBe('unknown');
        expect(extractClientIp(chain('::ffff:127.0.0.1'))).toBe('unknown');
    });
});

/**
 * The live topology as of 2026-08-09: Cloudflare -> Google frontend -> Cloud Run,
 * selected by `TRUSTED_PROXY_HOPS: "1"` in deploy/cloudrun.env.yaml.
 *
 * These exist because the App Hosting -> Cloud Run cutover shortened the chain
 * from 3 entries to 2 and nothing here caught it. The suite passed the whole
 * time: every case above pins hops=2, and the 2-entry case was asserted to be
 * 'unknown' — which is exactly the production failure, encoded as expected
 * behaviour. Only the `[rate-limit] client IP unresolvable` warn found it, in
 * production.
 *
 * `TRUSTED_PROXY_HOPS` is read once at module load, so these re-import the
 * module with the env var set rather than calling the binding imported above.
 */
describe('extractClientIp — Cloudflare topology (TRUSTED_PROXY_HOPS=1)', () => {
    const CF_EGRESS = '172.70.35.69'; // Cloudflare edge, rightmost entry
    const CLIENT = '203.0.113.7';

    async function withOneHop() {
        vi.resetModules();
        process.env.TRUSTED_PROXY_HOPS = '1';
        return (await import('./client-ip.js')).extractClientIp;
    }

    afterEach(() => {
        delete process.env.TRUSTED_PROXY_HOPS;
        vi.resetModules();
    });

    it('extracts the client from the 2-entry Cloudflare chain', async () => {
        const extract = await withOneHop();
        expect(extract(`${CLIENT}, ${CF_EGRESS}`)).toBe(CLIENT);
    });

    it('does not return the Cloudflare edge itself (the shared-bucket failure)', async () => {
        const extract = await withOneHop();
        expect(extract(`${CLIENT}, ${CF_EGRESS}`)).not.toBe(CF_EGRESS);
    });

    it('ignores a client-spoofed leading entry', async () => {
        const extract = await withOneHop();
        // Caller prepends their own XFF; Cloudflare appends the real client.
        expect(extract(`1.2.3.4, ${CLIENT}, ${CF_EGRESS}`)).toBe(CLIENT);
    });

    it('returns "unknown" for a direct *.run.app hit, which bypasses Cloudflare', async () => {
        const extract = await withOneHop();
        // 1-entry chain -> idx of -1. Unbucketed, but fail-safe rather than
        // trusting a value no trusted edge appended.
        expect(extract(CLIENT)).toBe('unknown');
    });
});
