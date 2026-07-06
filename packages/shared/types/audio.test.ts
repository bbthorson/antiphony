import { describe, it, expect } from 'vitest';
import {
    StrongRefSchema,
    ReplyRefSchema,
    AudioEmbedSchema,
    AudioEmbedViewSchema,
    TimedTranscriptSchema,
    AudioPostRecordSchema,
    TranscriptEnrichmentRecordSchema,
    ActorProfileRecordSchema,
    AudioPostViewSchema,
    ViewerStateSchema,
} from './audio';
import { CreateAudioPostRequestSchema } from '../api-codecs';

const STRONGREF = { uri: 'at://did:plc:abc/dev.antiphony.audio.post/3kj', cid: 'bafyabc' };

const AUDIO_EMBED = {
    $type: 'dev.antiphony.embed.audio' as const,
    audio: { $type: 'blob' as const, ref: { $link: 'bafyaudio' }, mimeType: 'audio/webm', size: 1024 },
    durationMs: 12500,
    alt: 'A spoken reply',
    waveform: [0, 50, 100, 25],
};

describe('StrongRef / ReplyRef', () => {
    it('accepts a valid StrongRef', () => {
        expect(StrongRefSchema.parse(STRONGREF)).toEqual(STRONGREF);
    });

    it('rejects a non-at:// uri', () => {
        expect(() => StrongRefSchema.parse({ uri: 'https://x/y', cid: 'b' })).toThrow();
    });

    it('requires both root and parent on a ReplyRef', () => {
        expect(ReplyRefSchema.parse({ root: STRONGREF, parent: STRONGREF })).toBeTruthy();
        expect(() => ReplyRefSchema.parse({ root: STRONGREF })).toThrow();
    });
});

describe('AudioEmbed (record) + AudioEmbedView (hydrated)', () => {
    it('round-trips the stored embed (blob, no transcript)', () => {
        const parsed = AudioEmbedSchema.parse(AUDIO_EMBED);
        expect(parsed.audio.ref.$link).toBe('bafyaudio');
        expect(parsed.durationMs).toBe(12500);
        // The stored embed has no transcript field — it's lifted onto the view.
        expect('transcript' in parsed).toBe(false);
    });

    it('round-trips the hydrated view (signed url + lifted transcript)', () => {
        const view = {
            $type: 'dev.antiphony.embed.audio#view' as const,
            url: 'https://signed.example.com/audio.webm?sig=x',
            durationMs: 12500,
            transcript: { segments: [{ startMs: 0, endMs: 1000, text: 'Hi' }], text: 'Hi' },
        };
        const parsed = AudioEmbedViewSchema.parse(view);
        expect(parsed.url).toContain('signed');
        expect(parsed.transcript?.segments[0].text).toBe('Hi');
    });
});

describe('TimedTranscript', () => {
    it('round-trips segments + optional rollup', () => {
        const t = { segments: [{ startMs: 0, endMs: 500, text: 'a' }, { startMs: 500, endMs: 900, text: 'b' }], text: 'a b' };
        expect(TimedTranscriptSchema.parse(t).segments).toHaveLength(2);
    });

    it('allows omitting the text rollup', () => {
        const t = { segments: [{ startMs: 0, endMs: 1, text: 'x' }] };
        expect(TimedTranscriptSchema.parse(t).text).toBeUndefined();
    });
});

describe('AudioPostRecord (single collection; reply-presence discriminator)', () => {
    const base = {
        id: 'post1',
        cid: 'bafyreipost1',
        originAppId: 'demo-app',
        authorId: 'user1',
        text: 'What did you think?',
        embed: AUDIO_EMBED,
        createdAt: new Date('2026-06-26T00:00:00Z'),
    };

    it('round-trips a prompt-kind post (no reply)', () => {
        const parsed = AudioPostRecordSchema.parse({ ...base, kind: 'prompt', title: 'A question' });
        expect(parsed.kind).toBe('prompt');
        expect(parsed.reply).toBeUndefined();
        expect(parsed.title).toBe('A question');
    });

    it('round-trips a reply-kind post (with reply StrongRefs)', () => {
        const parsed = AudioPostRecordSchema.parse({
            ...base,
            kind: 'reply',
            text: '',
            reply: { root: STRONGREF, parent: STRONGREF },
        });
        expect(parsed.kind).toBe('reply');
        expect(parsed.reply?.root.cid).toBe('bafyabc');
        // Reply text may be empty (pure-audio reply).
        expect(parsed.text).toBe('');
    });

    it('requires the tenancy key (originAppId)', () => {
        const { originAppId, ...noTenancy } = base;
        void originAppId;
        expect(() => AudioPostRecordSchema.parse({ ...noTenancy, kind: 'prompt' })).toThrow();
    });
});

describe('TranscriptEnrichmentRecord (platform enrichment, by StrongRef)', () => {
    it('round-trips a transcript enrichment record', () => {
        const rec = {
            id: 'tr1',
            subject: STRONGREF,
            transcript: { segments: [{ startMs: 0, endMs: 1000, text: 'Hello' }] },
            lang: 'en',
            model: 'whisper-x',
            createdAt: new Date('2026-06-26T00:00:00Z'),
        };
        const parsed = TranscriptEnrichmentRecordSchema.parse(rec);
        expect(parsed.subject.uri).toContain('at://');
        expect(parsed.transcript.segments[0].text).toBe('Hello');
    });
});

describe('ActorProfileRecord', () => {
    it('round-trips an all-optional profile', () => {
        expect(ActorProfileRecordSchema.parse({ handle: 'brad', usageIntent: 'Podcaster' }).handle).toBe('brad');
        expect(ActorProfileRecordSchema.parse({})).toEqual({});
    });
});

describe('AudioPostView (record + viewer state)', () => {
    it('round-trips a hydrated view with embed view + viewer', () => {
        const view = {
            uri: 'at://did:plc:abc/dev.antiphony.audio.post/3kj',
            cid: 'bafyreiview',
            kind: 'prompt' as const,
            authorId: 'user1',
            authorDid: 'did:web:voxpop.audio',
            record: { text: 'Q?', title: 'A question', createdAt: new Date('2026-06-26T00:00:00Z') },
            embed: {
                $type: 'dev.antiphony.embed.audio#view' as const,
                url: 'https://signed.example.com/a.webm',
            },
            viewer: { isAuthor: true },
        };
        const parsed = AudioPostViewSchema.parse(view);
        expect(parsed.viewer.isAuthor).toBe(true);
        expect(parsed.embed?.url).toContain('signed');
        expect(parsed.authorId).toBe('user1');
        expect(parsed.authorDid).toBe('did:web:voxpop.audio');
    });

    it('defaults viewer.isAuthor to false', () => {
        expect(ViewerStateSchema.parse({}).isAuthor).toBe(false);
    });
});

describe('CreateAudioPostRequest codec', () => {
    it('defaults text to empty string and accepts a reply', () => {
        const parsed = CreateAudioPostRequestSchema.parse({
            embed: AUDIO_EMBED,
            reply: { root: STRONGREF, parent: STRONGREF },
        });
        expect(parsed.text).toBe('');
        expect(parsed.reply?.parent.uri).toContain('at://');
    });

    it('accepts a prompt create (title + text, no reply)', () => {
        const parsed = CreateAudioPostRequestSchema.parse({ text: 'desc', title: 'Headline', embed: AUDIO_EMBED });
        expect(parsed.title).toBe('Headline');
        expect(parsed.reply).toBeUndefined();
    });

    it('rejects a reply with a title', () => {
        expect(() => CreateAudioPostRequestSchema.parse({
            embed: AUDIO_EMBED, reply: { root: STRONGREF, parent: STRONGREF }, title: 'nope',
        })).toThrow();
    });

    it('rejects a completely empty post (no text, no embed)', () => {
        expect(() => CreateAudioPostRequestSchema.parse({ text: '   ' })).toThrow();
    });
});

describe('cross-field invariants (Gemini #680)', () => {
    const base = {
        id: 'p', cid: 'bafyreip', originAppId: 'demo-app', authorId: 'u', embed: AUDIO_EMBED,
        text: 'x', createdAt: new Date('2026-06-26T00:00:00Z'),
    };

    it('rejects kind=reply without a reply ref', () => {
        expect(() => AudioPostRecordSchema.parse({ ...base, kind: 'reply' })).toThrow();
    });

    it('rejects kind=reply that carries a title', () => {
        expect(() => AudioPostRecordSchema.parse({
            ...base, kind: 'reply', title: 'no', reply: { root: STRONGREF, parent: STRONGREF },
        })).toThrow();
    });

    it('rejects kind=prompt that carries a reply ref', () => {
        expect(() => AudioPostRecordSchema.parse({
            ...base, kind: 'prompt', reply: { root: STRONGREF, parent: STRONGREF },
        })).toThrow();
    });

    it('rejects a transcript segment with endMs < startMs', () => {
        expect(() => TimedTranscriptSchema.parse({ segments: [{ startMs: 1000, endMs: 500, text: 'x' }] })).toThrow();
    });
});
