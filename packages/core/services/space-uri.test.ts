import { describe, it, expect } from 'vitest';
import { normalizeAtUri } from './space-uri';

describe('normalizeAtUri', () => {
    it('rewrites an alpha-era space record or space ref to the at:space/ form', () => {
        expect(normalizeAtUri('at://did:plc:g/space/a.b.c/k/did:plc:a/dev.antiphony.audio.post/3k')).toBe(
            'at:space/did:plc:g/a.b.c/k/did:plc:a/dev.antiphony.audio.post/3k',
        );
        expect(normalizeAtUri('at://did:web:x.example/space/a.b.c/k')).toBe('at:space/did:web:x.example/a.b.c/k');
    });

    it('returns current-form and public URIs unchanged', () => {
        for (const uri of [
            'at:space/did:plc:g/a.b.c/k/did:plc:a/dev.antiphony.audio.post/3k',
            'at://did:plc:a/dev.antiphony.audio.post/3k',
            'https://example.com/x',
        ]) {
            expect(normalizeAtUri(uri)).toBe(uri);
        }
    });
});
