import { describe, it, expect } from 'vitest';
import { extractClientIp } from './client-ip.js';

/**
 * Tests for the X-Forwarded-For client-IP extraction (H5 fix).
 *
 * Production topology: Firebase App Hosting → Google external Application Load
 * Balancer (GFE) → Cloud Run. The edge appends `<client-ip>,<GFE-ip>`, so the
 * client is the SECOND-to-last entry and the rightmost is a Google GFE IP
 * (empirically always `192.178.13.0/24` for this backend). The previous code
 * took the rightmost entry → bucketed all traffic on rotating Google infra IPs.
 */
describe('extractClientIp', () => {
    it('returns the client (second-to-last), not the trailing GFE IP', () => {
        // Representative production chain: real client + Google GFE.
        expect(extractClientIp('203.0.113.7, 192.178.13.5')).toBe('203.0.113.7');
    });

    it('ignores a client-spoofed leading XFF entry', () => {
        // A client can prepend their own XFF; the LB appends the real client +
        // GFE to the right. We must pick the LB-recorded client, not the spoof.
        expect(extractClientIp('1.2.3.4, 203.0.113.7, 192.178.13.5')).toBe('203.0.113.7');
    });

    it('does NOT return the rightmost (GFE) entry — the old H5 bug', () => {
        const out = extractClientIp('203.0.113.7, 192.178.13.5');
        expect(out).not.toBe('192.178.13.5');
    });

    it('returns "unknown" for a single-entry chain (no trusted hop present)', () => {
        // Local/dev or a misrouted request that didn't traverse the edge — the
        // lone value is potentially client-spoofed, so fail safe.
        expect(extractClientIp('203.0.113.7')).toBe('unknown');
    });

    it('returns "unknown" when the header is absent or empty', () => {
        expect(extractClientIp(undefined)).toBe('unknown');
        expect(extractClientIp('')).toBe('unknown');
        expect(extractClientIp('   ')).toBe('unknown');
    });

    it('collapses a private/loopback client to "unknown"', () => {
        expect(extractClientIp('10.0.0.5, 192.178.13.5')).toBe('unknown');
        expect(extractClientIp('192.168.1.10, 192.178.13.5')).toBe('unknown');
        expect(extractClientIp('172.16.0.1, 192.178.13.5')).toBe('unknown');
        expect(extractClientIp('127.0.0.1, 192.178.13.5')).toBe('unknown');
        expect(extractClientIp('::1, 192.178.13.5')).toBe('unknown');
    });

    it('tolerates extra whitespace and empty segments', () => {
        expect(extractClientIp('  203.0.113.7 ,  192.178.13.5 ')).toBe('203.0.113.7');
        expect(extractClientIp('203.0.113.7,, 192.178.13.5')).toBe('203.0.113.7');
    });

    it('passes through an IPv6 client address', () => {
        expect(extractClientIp('2001:db8::1, 192.178.13.5')).toBe('2001:db8::1');
    });

    it('collapses extended reserved ranges (loopback/8, link-local, 0/8)', () => {
        expect(extractClientIp('127.5.5.5, 192.178.13.5')).toBe('unknown');   // 127/8, not just .0.0.1
        expect(extractClientIp('169.254.1.1, 192.178.13.5')).toBe('unknown'); // IPv4 link-local
        expect(extractClientIp('0.0.0.0, 192.178.13.5')).toBe('unknown');     // 0/8
    });

    it('collapses IPv6 unique-local and link-local clients', () => {
        expect(extractClientIp('fc00::1, 192.178.13.5')).toBe('unknown'); // ULA
        expect(extractClientIp('fd12:3456::1, 192.178.13.5')).toBe('unknown'); // ULA
        expect(extractClientIp('fe80::1, 192.178.13.5')).toBe('unknown'); // link-local
    });

    it('unwraps IPv4-mapped IPv6 addresses', () => {
        // Public mapped → returns the bare IPv4 (consistent bucket key).
        expect(extractClientIp('::ffff:203.0.113.7, 192.178.13.5')).toBe('203.0.113.7');
        // Private mapped → still caught by the v4 filter.
        expect(extractClientIp('::ffff:10.0.0.1, 192.178.13.5')).toBe('unknown');
        expect(extractClientIp('::ffff:127.0.0.1, 192.178.13.5')).toBe('unknown');
    });
});
