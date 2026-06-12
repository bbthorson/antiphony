import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock node:dns so the DNS-resolution path is deterministic and offline.
// `vi.hoisted` is required: the vi.mock factory is hoisted above this file, so
// the mock fn must be created in a hoisted block to exist when it runs.
const { dnsLookupMock } = vi.hoisted(() => ({ dnsLookupMock: vi.fn() }));
vi.mock('node:dns', () => ({ lookup: dnsLookupMock }));

const { isPublicIp, isAllowedHost, safeFetchText, makeSafeLookup } = await import('./safe-fetch');
import { defaultLogger } from '../ports/logger';

const silent = { ...defaultLogger, warn: () => {}, error: () => {}, info: () => {}, debug: () => {} };

describe('isPublicIp', () => {
    it('allows ordinary public unicast', () => {
        expect(isPublicIp('8.8.8.8')).toBe(true);
        expect(isPublicIp('1.1.1.1')).toBe(true);
        expect(isPublicIp('2606:4700:4700::1111')).toBe(true);
    });

    it('blocks loopback (entire 127/8, not just .1) and ::1', () => {
        expect(isPublicIp('127.0.0.1')).toBe(false);
        expect(isPublicIp('127.0.0.2')).toBe(false);
        expect(isPublicIp('127.255.255.255')).toBe(false);
        expect(isPublicIp('::1')).toBe(false);
    });

    it('blocks the cloud metadata range (169.254/16)', () => {
        expect(isPublicIp('169.254.169.254')).toBe(false);
        expect(isPublicIp('169.254.0.1')).toBe(false);
    });

    it('blocks RFC1918 private ranges', () => {
        expect(isPublicIp('10.0.0.1')).toBe(false);
        expect(isPublicIp('172.16.0.1')).toBe(false);
        expect(isPublicIp('172.31.255.255')).toBe(false);
        expect(isPublicIp('192.168.1.1')).toBe(false);
    });

    it('blocks 0.0.0.0/8 and unspecified', () => {
        expect(isPublicIp('0.0.0.0')).toBe(false);
        expect(isPublicIp('::')).toBe(false);
    });

    it('blocks IPv6 unique-local and link-local', () => {
        expect(isPublicIp('fc00::1')).toBe(false);
        expect(isPublicIp('fd12:3456::1')).toBe(false);
        expect(isPublicIp('fe80::1')).toBe(false);
    });

    it('unwraps IPv4-mapped IPv6 before classifying', () => {
        expect(isPublicIp('::ffff:127.0.0.1')).toBe(false);
        expect(isPublicIp('::ffff:169.254.169.254')).toBe(false);
        expect(isPublicIp('::ffff:8.8.8.8')).toBe(true);
    });

    it('blocks integer / octal / hex encodings of internal IPs', () => {
        expect(isPublicIp('2130706433')).toBe(false); // 127.0.0.1 as int
        expect(isPublicIp('0x7f000001')).toBe(false); // hex 127.0.0.1
    });

    it('returns false for non-IP garbage', () => {
        expect(isPublicIp('not-an-ip')).toBe(false);
        expect(isPublicIp('')).toBe(false);
    });
});

describe('isAllowedHost', () => {
    it('allows real DNS hostnames (validated again at connect)', () => {
        expect(isAllowedHost('feeds.example.com')).toBe(true);
        expect(isAllowedHost('a.b.c.example.co.uk')).toBe(true);
    });

    it('blocks integer / hex IP encodings up front (ipaddr recognizes them)', () => {
        expect(isAllowedHost('2130706433')).toBe(false); // 127.0.0.1 as int
        expect(isAllowedHost('0x7f000001')).toBe(false);
    });

    it('rejects localhost and literal internal IPs up front', () => {
        expect(isAllowedHost('localhost')).toBe(false);
        expect(isAllowedHost('127.0.0.1')).toBe(false);
        expect(isAllowedHost('169.254.169.254')).toBe(false);
        expect(isAllowedHost('10.0.0.1')).toBe(false);
        expect(isAllowedHost('[::1]')).toBe(false); // brackets stripped
        expect(isAllowedHost('[fc00::1]')).toBe(false);
    });

    it('allows literal public IPs', () => {
        expect(isAllowedHost('8.8.8.8')).toBe(true);
        expect(isAllowedHost('[2606:4700:4700::1111]')).toBe(true);
    });
});

describe('safeFetchText', () => {
    beforeEach(() => dnsLookupMock.mockReset());

    it('rejects a non-http(s) protocol before any connection', async () => {
        await expect(safeFetchText('file:///etc/passwd', silent)).rejects.toThrow(/protocol/i);
    });

    it('rejects a literal metadata/private host before any connection', async () => {
        await expect(safeFetchText('http://169.254.169.254/latest/meta-data/', silent)).rejects.toThrow(/Blocked host/);
        await expect(safeFetchText('http://10.0.0.1/feed.xml', silent)).rejects.toThrow(/Blocked host/);
        await expect(safeFetchText('http://localhost/feed', silent)).rejects.toThrow(/Blocked host/);
        expect(dnsLookupMock).not.toHaveBeenCalled();
    });

});

// The DNS-resolution validation is exercised directly via makeSafeLookup —
// deterministic and offline, vs. standing up a real socket. This is the
// chokepoint that defends against DNS rebinding and numeric host encodings:
// whatever getaddrinfo returns is range-checked before the socket connects.
describe('makeSafeLookup', () => {
    beforeEach(() => dnsLookupMock.mockReset());

    // Invoke the resolution callback. (node:net/http probes the mocked
    // node:dns with non-call args during init, so guard before invoking.)
    function resolveTo(addresses: Array<{ address: string; family: number }>) {
        dnsLookupMock.mockImplementation((...args: unknown[]) => {
            const cb = args[args.length - 1];
            if (typeof cb === 'function') (cb as (e: Error | null, a: unknown) => void)(null, addresses);
        });
    }

    it('rejects when the host resolves to an internal IP (rebinding/encoding defense)', () => {
        resolveTo([{ address: '169.254.169.254', family: 4 }]);
        const cb = vi.fn();
        makeSafeLookup(silent)('feeds.evil.example', { all: false }, cb);
        expect(cb).toHaveBeenCalledTimes(1);
        expect(cb.mock.calls[0][0]).toBeInstanceOf(Error);
        expect((cb.mock.calls[0][0] as Error).message).toMatch(/non-public address/);
    });

    it('rejects if ANY resolved address is internal (multi-record)', () => {
        resolveTo([{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }]);
        const cb = vi.fn();
        makeSafeLookup(silent)('mixed.example', { all: false }, cb);
        expect(cb.mock.calls[0][0]).toBeInstanceOf(Error);
    });

    it('pins the socket to a validated public address (all: false)', () => {
        resolveTo([{ address: '8.8.8.8', family: 4 }]);
        const cb = vi.fn();
        makeSafeLookup(silent)('good.example', { all: false }, cb);
        expect(cb).toHaveBeenCalledWith(null, '8.8.8.8', 4);
    });

    it('passes the caller-requested family/hints through to DNS resolution', () => {
        resolveTo([{ address: '8.8.8.8', family: 4 }]);
        makeSafeLookup(silent)('good.example', { all: false, family: 4, hints: 1024 }, vi.fn());
        const realCall = dnsLookupMock.mock.calls.find((c) => c[0] === 'good.example');
        expect(realCall?.[1]).toMatchObject({ family: 4, hints: 1024, all: true });
    });

    it('returns the array form when options.all is true', () => {
        resolveTo([{ address: '8.8.8.8', family: 4 }]);
        const cb = vi.fn();
        makeSafeLookup(silent)('good.example', { all: true }, cb);
        expect(cb).toHaveBeenCalledWith(null, [{ address: '8.8.8.8', family: 4 }]);
    });

    it('propagates DNS resolution errors', () => {
        dnsLookupMock.mockImplementation((...args: unknown[]) => {
            const cb = args[args.length - 1];
            if (typeof cb === 'function') (cb as (e: Error | null) => void)(new Error('ENOTFOUND'));
        });
        const cb = vi.fn();
        makeSafeLookup(silent)('nope.example', { all: false }, cb);
        expect(cb.mock.calls[0][0]).toBeInstanceOf(Error);
    });
});
