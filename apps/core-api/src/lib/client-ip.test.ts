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

/**
 * A realistic chain: optional spoofed prefix entries, then client + 2 Google
 * hops, wrapped in a Request.
 *
 * `extractClientIp` takes the whole request now, so that it can choose between
 * `CF-Connecting-IP` and `X-Forwarded-For` itself rather than having one of them
 * picked for it at the call site — the change that made the Cloudflare path
 * expressible at all.
 */
const chain = (...leading: string[]) =>
    xff([...leading, GCLB, GFE].join(', '));

/** A Request carrying just an `X-Forwarded-For`. */
const xff = (value: string) => req({ 'x-forwarded-for': value });

/** A Request carrying exactly the given headers. */
function req(headers: Record<string, string>): Request {
    return new Request('https://api.antiphony.dev/api/v1/posts', { headers });
}

describe('extractClientIp', () => {
    it('returns the client (third-from-right), not the trailing Google hops', () => {
        expect(extractClientIp(chain('203.0.113.7'))).toBe('203.0.113.7');
    });

    it('matches the exact production chain shape (client, GCLB, GFE)', () => {
        expect(extractClientIp(xff('208.255.70.120,35.219.200.199,192.178.13.65'))).toBe('208.255.70.120');
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
        expect(extractClientIp(xff('203.0.113.7'))).toBe('unknown');
        expect(extractClientIp(xff(`203.0.113.7, ${GFE}`))).toBe('unknown'); // only 2 entries
    });

    it('returns "unknown" when the header is absent or empty', () => {
        expect(extractClientIp(req({}))).toBe('unknown');
        expect(extractClientIp(xff(''))).toBe('unknown');
        expect(extractClientIp(xff('   '))).toBe('unknown');
    });

    it('collapses a private/loopback client to "unknown"', () => {
        expect(extractClientIp(chain('10.0.0.5'))).toBe('unknown');
        expect(extractClientIp(chain('192.168.1.10'))).toBe('unknown');
        expect(extractClientIp(chain('172.16.0.1'))).toBe('unknown');
        expect(extractClientIp(chain('127.0.0.1'))).toBe('unknown');
        expect(extractClientIp(chain('::1'))).toBe('unknown');
    });

    it('tolerates extra whitespace and empty segments', () => {
        expect(extractClientIp(xff(`  203.0.113.7 , ${GCLB} ,  ${GFE} `))).toBe('203.0.113.7');
        expect(extractClientIp(xff(`203.0.113.7,, ${GCLB}, ${GFE}`))).toBe('203.0.113.7');
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
 * The topology from 2026-08-09: Cloudflare -> Google frontend -> Cloud Run,
 * selected by `TRUSTED_PROXY_HOPS: "1"`.
 *
 * These exist because the App Hosting -> Cloud Run cutover shortened the chain
 * from 3 entries to 2 and nothing here caught it. The suite passed the whole
 * time: every case above pins hops=2, and the 2-entry case was asserted to be
 * 'unknown' — which is exactly the production failure, encoded as expected
 * behaviour. Only the `[rate-limit] client IP unresolvable` warn found it, in
 * production.
 *
 * **This is now history too**, and the lesson repeated a third time: the service
 * is a Cloudflare Worker, which receives no `X-Forwarded-For` at all. Kept
 * because `TRUSTED_PROXY_HOPS` still selects this behaviour for a self-hoster
 * fronting the API with Cloudflare, and because the pattern — a topology move
 * silently collapsing everyone into one bucket, asserted here as correct — is
 * the thing to recognise before it happens a fourth time. See the Worker block
 * below for what this deployment actually does.
 *
 * `TRUSTED_PROXY_HOPS` is read per-request now (workerd binds `process.env` per
 * request context), so setting the env var is enough; the module no longer needs
 * re-importing.
 */
describe('extractClientIp — Cloudflare-in-front-of-origin topology (TRUSTED_PROXY_HOPS=1)', () => {
    const CF_EGRESS = '172.70.35.69'; // Cloudflare edge, rightmost entry
    const CLIENT = '203.0.113.7';

    function withOneHop() {
        process.env.TRUSTED_PROXY_HOPS = '1';
        return (chainValue: string) => extractClientIp(xff(chainValue));
    }

    afterEach(() => {
        delete process.env.TRUSTED_PROXY_HOPS;
        vi.resetModules();
    });

    it('extracts the client from the 2-entry Cloudflare chain', () => {
        const extract = withOneHop();
        expect(extract(`${CLIENT}, ${CF_EGRESS}`)).toBe(CLIENT);
    });

    it('does not return the Cloudflare edge itself (the shared-bucket failure)', () => {
        const extract = withOneHop();
        expect(extract(`${CLIENT}, ${CF_EGRESS}`)).not.toBe(CF_EGRESS);
    });

    it('ignores a client-spoofed leading entry', () => {
        const extract = withOneHop();
        // Caller prepends their own XFF; Cloudflare appends the real client.
        expect(extract(`1.2.3.4, ${CLIENT}, ${CF_EGRESS}`)).toBe(CLIENT);
    });

    it('returns "unknown" for a direct *.run.app hit, which bypasses Cloudflare', () => {
        const extract = withOneHop();
        // 1-entry chain -> idx of -1. Unbucketed, but fail-safe rather than
        // trusting a value no trusted edge appended.
        expect(extract(CLIENT)).toBe('unknown');
    });
});

/**
 * What this deployment actually is: a Cloudflare **Worker**.
 *
 * The edge sends `CF-Connecting-IP` and no `X-Forwarded-For` whatsoever, so
 * every hop count is wrong by construction and `extractClientIp` returned
 * 'unknown' for every request on the service. 'unknown' is a real bucket, so
 * `write` (10 per 15 min) became a single platform-wide allowance — a creator's
 * first prompt of the day 429'd on a budget somebody else's reads had spent.
 * Diagnosed 2026-08-21 from the Vox Pop side, where the BFF relays the upstream
 * 429 verbatim.
 */
describe('extractClientIp — Cloudflare Worker (CLIENT_IP_SOURCE=cf)', () => {
    afterEach(() => {
        delete process.env.CLIENT_IP_SOURCE;
    });

    it('reads CF-Connecting-IP', () => {
        process.env.CLIENT_IP_SOURCE = 'cf';
        expect(extractClientIp(req({ 'cf-connecting-ip': '203.0.113.7' }))).toBe('203.0.113.7');
    });

    it('ignores X-Forwarded-For entirely — no chain to walk, nothing to spoof', () => {
        process.env.CLIENT_IP_SOURCE = 'cf';
        const r = req({
            'cf-connecting-ip': '203.0.113.7',
            'x-forwarded-for': '1.2.3.4, 5.6.7.8, 9.10.11.12',
        });
        expect(extractClientIp(r)).toBe('203.0.113.7');
    });

    it('applies the same normalization and routability rules as the XFF path', () => {
        process.env.CLIENT_IP_SOURCE = 'cf';
        expect(extractClientIp(req({ 'cf-connecting-ip': '::ffff:203.0.113.7' }))).toBe('203.0.113.7');
        expect(extractClientIp(req({ 'cf-connecting-ip': '127.0.0.1' }))).toBe('unknown');
        expect(extractClientIp(req({ 'cf-connecting-ip': '  203.0.113.7  ' }))).toBe('203.0.113.7');
    });

    it('does not fall back to XFF when the header is missing', () => {
        // Falling back would be a bypass on any ingress reachable without
        // traversing the edge: the caller supplies the chain.
        process.env.CLIENT_IP_SOURCE = 'cf';
        expect(extractClientIp(xff(`203.0.113.7, ${GCLB}, ${GFE}`))).toBe('unknown');
    });

    it('keeps the XFF path when the var is unset or typo\'d', () => {
        expect(extractClientIp(chain('203.0.113.7'))).toBe('203.0.113.7');
        process.env.CLIENT_IP_SOURCE = 'CF';
        expect(extractClientIp(chain('203.0.113.7'))).toBe('203.0.113.7');
    });

    it('a real Worker request resolves instead of collapsing into the shared bucket', () => {
        process.env.CLIENT_IP_SOURCE = 'cf';
        // The shape the edge actually delivers: CF-Connecting-IP alone.
        expect(extractClientIp(req({ 'cf-connecting-ip': '71.246.108.43' }))).toBe('71.246.108.43');
        // ...and without the flag, the bug: one bucket for everybody.
        delete process.env.CLIENT_IP_SOURCE;
        expect(extractClientIp(req({ 'cf-connecting-ip': '71.246.108.43' }))).toBe('unknown');
    });
});
