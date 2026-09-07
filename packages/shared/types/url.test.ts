import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { httpsUrl } from './url';

/**
 * These tests are written as a comparison against bare `z.string().url()` on
 * purpose. The point of `httpsUrl()` is not "it validates URLs" — `.url()` also
 * does that — it is that `.url()` accepts a set of schemes nobody wants in a
 * field a client dereferences. Asserting the DIFFERENCE is what stops someone
 * later deciding the scheme anchor is redundant and deleting it.
 */
// The thing under comparison. Bare `.url()` is exactly what these tests exist
// to prove is unsafe, so the rule that bans it is disabled for this one line.
// eslint-disable-next-line antiphony/no-bare-zod-url
const bare = z.string().url();
const schema = httpsUrl();

/** Build a string with a control character in it without writing one inline. */
const ch = (code: number) => String.fromCharCode(code);
const TAB = ch(9);
const LF = ch(10);
const NUL = ch(0);

describe('httpsUrl()', () => {
    describe('rejects the schemes bare .url() lets through', () => {
        const dangerous = [
            'javascript:alert(1)',
            'JavaScript:alert(1)',
            'data:text/html,<script>alert(1)</script>',
            'file:///etc/passwd',
            'vbscript:msgbox(1)',
            'blob:https://evil.example/x',
        ];

        it.each(dangerous)('%s', (input) => {
            // The premise: bare `.url()` accepts all of these. If a zod upgrade
            // ever changes that, this assertion is the thing that says so.
            expect(bare.safeParse(input).success).toBe(true);
            expect(schema.safeParse(input).success).toBe(false);
        });

        it('reports the scheme as the reason', () => {
            const result = schema.safeParse('javascript:alert(1)');
            expect(result.success).toBe(false);
            if (!result.success) {
                expect(result.error.issues.map((i) => i.message)).toContain(
                    'URL must use the http or https scheme',
                );
            }
        });
    });

    describe('rejects a scheme smuggled past a naive check', () => {
        // HTML strips tabs/newlines out of URL attributes before dereferencing,
        // so these ARE `javascript:` URLs to a browser — and `new URL()` parses
        // them. Anchoring on the raw string is what rejects them.
        const smuggled = [
            `java${TAB}script:alert(1)`,
            `java${LF}script:alert(1)`,
            `${TAB}javascript:alert(1)`,
            `${LF}javascript:alert(1)`,
            ` javascript:alert(1)`,
            `${NUL}javascript:alert(1)`,
        ];

        it.each(smuggled.map((s, i) => [i, s] as const))('case %i', (_i, input) => {
            expect(bare.safeParse(input).success).toBe(true);
            expect(schema.safeParse(input).success).toBe(false);
        });
    });

    describe('accepts real playback and feed URLs', () => {
        const ok = [
            'https://api.antiphony.dev/api/v1/audio?url=blobs%2Fapp%2Fbafyaudio',
            'https://signed.example.com/audio.webm?sig=x',
            // Self-hosted / local: `ANTIPHONY_PUBLIC_BASE_URL` is plain http in
            // development, and the view URL is built from it.
            'http://localhost:8787/api/v1/audio?url=x',
            'http://127.0.0.1:8787/api/v1/audio?url=x',
            'https://example.com/feed.xml',
            // Scheme casing is not part of the rule.
            'HTTPS://ok.example/a.webm',
        ];

        it.each(ok)('%s', (input) => {
            expect(schema.parse(input)).toBe(input);
        });
    });

    it('trims surrounding whitespace rather than rejecting it', () => {
        // A normalisation, not a tightening: bare `.url()` accepted the padded
        // form too — it just handed the padding downstream.
        expect(schema.parse('  https://ok.example/a.webm  ')).toBe('https://ok.example/a.webm');
    });

    it('still rejects what .url() itself rejects', () => {
        for (const input of ['', 'not a url', '//evil.example/x', 'https:/x', 'httpsx://a.b']) {
            expect(schema.safeParse(input).success).toBe(false);
        }
    });

    it('stays a ZodString, so it composes and documents like one', () => {
        // A `.refine()` would make this `ZodEffects`, which loses `.extend()`
        // friendliness for consumers and weakens the generated OpenAPI schema.
        expect(schema).toBeInstanceOf(z.ZodString);
        expect(schema.optional().safeParse(undefined).success).toBe(true);
        expect(z.object({ url: httpsUrl() }).extend({ extra: z.string() }).safeParse({
            url: 'https://ok.example/a.webm',
            extra: 'x',
        }).success).toBe(true);
    });
});
