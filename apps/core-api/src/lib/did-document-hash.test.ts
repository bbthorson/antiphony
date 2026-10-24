import { describe, it, expect } from 'vitest';
import {
    canonicalJson,
    didDocumentHash,
    documentAcknowledgement,
    parseDocHashBaselines,
} from './did-document-hash.js';

/** The Vox Pop document as published 2026-08-21 (#116 §0), as a realistic fixture. */
const VOXPOP_DOC = {
    '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'],
    id: 'did:web:did.voxpop.audio',
    alsoKnownAs: [],
    service: [
        { id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://api.antiphony.dev' },
    ],
    verificationMethod: [
        {
            id: 'did:web:did.voxpop.audio#atproto',
            type: 'Multikey',
            controller: 'did:web:did.voxpop.audio',
            publicKeyMultibase: 'zDnaeUpyKYkJyToZtGeR5eiFvUqK3DNJM498vTN2oryWERffV',
        },
    ],
};

describe('canonicalJson (RFC 8785)', () => {
    it('sorts keys at every depth and drops whitespace', () => {
        expect(canonicalJson({ b: 1, a: [2, { d: null, c: 'x' }] })).toBe('{"a":[2,{"c":"x","d":null}],"b":1}');
    });

    it('sorts by UTF-16 code unit, so "@context" precedes lowercase keys', () => {
        expect(canonicalJson({ id: 1, '@context': 2, Z: 3 })).toBe('{"@context":2,"Z":3,"id":1}');
    });

    it('serializes numbers the ECMAScript way, as JCS specifies', () => {
        expect(canonicalJson([1.0, 1e21, -0, 0.1])).toBe('[1,1e+21,0,0.1]');
    });

    it('preserves array order — entry order is the publisher\'s statement', () => {
        expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
    });
});

describe('didDocumentHash', () => {
    it('is stable across key order and pretty-printing', async () => {
        const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(VOXPOP_DOC).reverse()), null, 4));
        expect(await didDocumentHash(reordered)).toBe(await didDocumentHash(VOXPOP_DOC));
    });

    it('changes when a verificationMethod is added — the hijack case #117 is about', async () => {
        const withSecondKey = {
            ...VOXPOP_DOC,
            verificationMethod: [
                ...VOXPOP_DOC.verificationMethod,
                { ...VOXPOP_DOC.verificationMethod[0], id: 'did:web:did.voxpop.audio#attacker' },
            ],
        };
        expect(await didDocumentHash(withSecondKey)).not.toBe(await didDocumentHash(VOXPOP_DOC));
    });

    it('changes on alsoKnownAs, which the custody checks never read', async () => {
        const aka = { ...VOXPOP_DOC, alsoKnownAs: ['at://someone.else'] };
        expect(await didDocumentHash(aka)).not.toBe(await didDocumentHash(VOXPOP_DOC));
    });

    it('is sha256 over the canonical bytes, in the committed form', async () => {
        expect(await didDocumentHash({})).toBe(
            // sha256("{}")
            'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
        );
    });
});

describe('parseDocHashBaselines + documentAcknowledgement', () => {
    const HASH = `sha256:${'a'.repeat(64)}`;

    it('parses appId:sha256:<hex>, splitting on the first colon', () => {
        expect(parseDocHashBaselines(`voxpop:${HASH}`).get('voxpop')).toBe(HASH);
    });

    it('drops malformed entries, which leaves that tenant with no baseline', () => {
        const m = parseDocHashBaselines(`voxpop:sha256:abc, other:${HASH}, nohash`);
        expect(m.has('voxpop')).toBe(false);
        expect(m.get('other')).toBe(HASH);
    });

    it('distinguishes acknowledged, changed and no-baseline', () => {
        const baselines = new Map([['voxpop', HASH]]);
        const other = `sha256:${'b'.repeat(64)}`;
        expect(documentAcknowledgement('voxpop', HASH, baselines)).toEqual({ status: 'acknowledged' });
        expect(documentAcknowledgement('voxpop', other, baselines)).toEqual({
            status: 'changed',
            expected: HASH,
            observed: other,
        });
        expect(documentAcknowledgement('acme', HASH, baselines)).toEqual({ status: 'no-baseline', observed: HASH });
    });
});
