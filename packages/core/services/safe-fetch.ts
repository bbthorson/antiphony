import { lookup as dnsLookup } from 'node:dns';
import { type LookupFunction } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import ipaddr from 'ipaddr.js';
import { type Logger, defaultLogger } from '../ports/logger';

/**
 * SSRF-safe HTTP(S) text fetcher.
 *
 * Used by `RssService` to fetch external feeds. RSS feed URLs are user-supplied
 * (public `POST /api/v1/rss/parse` and org `rssFeedUrl`), so a naive fetch is a
 * server-side request forgery vector — most dangerously to the cloud metadata
 * endpoint (`169.254.169.254`), which would hand out the service account token.
 *
 * The guarantee comes from a custom DNS `lookup` passed to the request: it
 * resolves the host, rejects the connection if ANY resolved address is not
 * ordinary public unicast, and pins the socket to a validated address. Because
 * the socket connects to exactly that address:
 *  - DNS rebinding (a TOCTOU flip between validation and connect) can't reach an
 *    internal IP — there is no separate connect-time resolution to poison;
 *  - numeric / octal / hex / IPv4-mapped host encodings are normalized by
 *    getaddrinfo to a real IP which is then range-checked (so `2130706433`,
 *    `0177.0.0.1`, `::ffff:127.0.0.1`, etc. are all caught);
 *  - link-local (169.254/16, fe80::/10), loopback (127/8, ::1), private
 *    (10/8, 172.16/12, 192.168/16), unique-local (fc00::/7), and other reserved
 *    ranges are all rejected — `ipaddr.js` `range()` owns the classification.
 *
 * Redirects are followed manually so each hop's Location is re-validated through
 * the same lookup (an open redirect on a public host can't bounce us internal).
 */

const MAX_REDIRECTS = 4;
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB — feeds are far smaller; cap prevents memory abuse.
const TIMEOUT_MS = 10_000;
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * True only for ordinary public unicast addresses. `ipaddr.process` unwraps
 * IPv4-mapped IPv6 (`::ffff:1.2.3.4` → `1.2.3.4`) before classification.
 */
export function isPublicIp(ip: string): boolean {
    try {
        return ipaddr.process(ip).range() === 'unicast';
    } catch {
        return false;
    }
}

/** Strip the brackets URL parsing leaves on IPv6 literal hosts (`[::1]`). */
function unbracket(host: string): string {
    return host.replace(/^\[/, '').replace(/\]$/, '');
}

/**
 * A host is allowed up front only if it's NOT a literal non-public IP and not
 * `localhost`. Real DNS hostnames pass here and are validated at connect time
 * by the lookup below (where the actual resolved IPs are checked).
 */
export function isAllowedHost(host: string): boolean {
    const h = unbracket(host).toLowerCase();
    if (h === 'localhost' || h === '') return false;
    if (ipaddr.isValid(h)) return isPublicIp(h);
    return true;
}

/**
 * Custom DNS lookup that validates every resolved address and pins the socket
 * to a validated one. Honors the caller's `all` option. `net` always invokes
 * the lookup with the 3-arg `(hostname, options, callback)` form.
 */
export function makeSafeLookup(logger: Logger): LookupFunction {
    return (hostname, options, callback) => {
        // Respect the caller's requested family/hints (legacy form passes the
        // family as a bare number). Force `all` so we can validate EVERY
        // resolved address, then honor the caller's `all` when we call back.
        const base = typeof options === 'number' ? { family: options } : { ...options };
        const dnsOptions = { ...base, all: true as const, verbatim: true };
        dnsLookup(hostname, dnsOptions, (err, addresses) => {
            if (err) return callback(err, '', 0);
            if (!addresses || addresses.length === 0) {
                return callback(new Error(`No DNS records for ${hostname}`), '', 0);
            }
            for (const a of addresses) {
                if (!isPublicIp(a.address)) {
                    logger.warn(
                        { hostname, resolved: a.address },
                        '[safeFetch] Blocked connection to non-public address',
                    );
                    return callback(new Error(`Blocked non-public address ${a.address} for ${hostname}`), '', 0);
                }
            }
            const wantAll = typeof options === 'object' && options?.all === true;
            if (wantAll) return callback(null, addresses);
            return callback(null, addresses[0].address, addresses[0].family);
        });
    };
}

/**
 * Fetch a URL's body as text with SSRF protection, manual redirect
 * re-validation, a size cap, and a timeout. Throws on any failure.
 */
export async function safeFetchText(
    url: string,
    logger: Logger = defaultLogger,
    redirectsLeft: number = MAX_REDIRECTS,
): Promise<string> {
    const parsed = new URL(url);

    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
        throw new Error(`Blocked protocol ${parsed.protocol}`);
    }
    if (!isAllowedHost(parsed.hostname)) {
        throw new Error(`Blocked host ${parsed.hostname}`);
    }

    const requestFn = parsed.protocol === 'https:' ? httpsRequest : httpRequest;

    return new Promise<string>((resolve, reject) => {
        // The request emits multiple events (response, error, timeout) and we
        // also hand off to a recursive fetch on redirect. Guard so the promise
        // settles exactly once and late events from a superseded request are
        // ignored.
        let settled = false;
        const safeResolve = (val: string) => {
            if (settled) return;
            settled = true;
            resolve(val);
        };
        const safeReject = (err: Error) => {
            if (settled) return;
            settled = true;
            reject(err);
        };

        const req = requestFn(
            url,
            {
                method: 'GET',
                lookup: makeSafeLookup(logger),
                timeout: TIMEOUT_MS,
                headers: {
                    'user-agent': 'VoxPop-RSS/1.0',
                    accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
                },
            },
            (res: IncomingMessage) => {
                const status = res.statusCode ?? 0;

                // Manual redirect handling — re-validate each hop's destination.
                const locationHeader = res.headers.location;
                if (status >= 300 && status < 400 && locationHeader) {
                    res.resume(); // drain so the socket can be freed
                    if (redirectsLeft <= 0) {
                        safeReject(new Error('Too many redirects'));
                        return;
                    }
                    const location = Array.isArray(locationHeader) ? locationHeader[0] : locationHeader;
                    let nextUrl: string;
                    try {
                        nextUrl = new URL(location, url).toString();
                    } catch {
                        safeReject(new Error('Invalid redirect location'));
                        return;
                    }
                    if (settled) return;
                    // Mark settled so any trailing error/timeout from THIS request
                    // can't reject after we've handed off to the redirect target;
                    // the recursive promise drives the outer resolve/reject.
                    settled = true;
                    safeFetchText(nextUrl, logger, redirectsLeft - 1).then(resolve, reject);
                    return;
                }

                if (status < 200 || status >= 300) {
                    res.resume();
                    safeReject(new Error(`HTTP ${status}`));
                    return;
                }

                let received = 0;
                const chunks: Buffer[] = [];
                res.on('data', (chunk: Buffer) => {
                    if (received > MAX_BYTES) return; // already over — ignore race-emitted chunks
                    received += chunk.length;
                    if (received > MAX_BYTES) {
                        res.destroy();
                        req.destroy();
                        safeReject(new Error('Response body exceeds size limit'));
                        return;
                    }
                    chunks.push(chunk);
                });
                res.on('end', () => safeResolve(Buffer.concat(chunks).toString('utf8')));
                res.on('error', safeReject);
            },
        );

        req.on('timeout', () => req.destroy(new Error('Request timed out')));
        req.on('error', safeReject);
        req.end();
    });
}
