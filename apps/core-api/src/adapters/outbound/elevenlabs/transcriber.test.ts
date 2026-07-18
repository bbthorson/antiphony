import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { groupIntoSegments, normalizeLang, elevenLabsTranscriber } from './transcriber.js';
import { TimedTranscriptSchema } from 'shared/types/audio';

/**
 * Unit tests for the Scribe → `TimedTranscript` mapping. This is the only part
 * of the adapter with real logic (the rest is one fetch), and it is pure, so
 * it is tested without the network or a key.
 *
 * Scribe reports word-level timings in SECONDS; the transcript schema is
 * integer milliseconds and refines `endMs >= startMs`. Most of what follows
 * guards that boundary.
 */

const word = (text: string, start: number, end: number) => ({ text, start, end, type: 'word' });
const spacing = (start: number, end: number) => ({ text: ' ', start, end, type: 'spacing' });

describe('groupIntoSegments', () => {
    it('converts seconds to integer milliseconds', () => {
        const [seg] = groupIntoSegments([word('Hi.', 1.25, 1.8)]);
        expect(seg).toEqual({ startMs: 1250, endMs: 1800, text: 'Hi.' });
    });

    it('groups words into one segment per sentence', () => {
        const segments = groupIntoSegments([
            word('Hello', 0, 0.5),
            spacing(0.5, 0.6),
            word('there.', 0.6, 1),
            spacing(1, 1.1),
            word('Bye.', 1.1, 1.5),
        ]);
        expect(segments).toEqual([
            { startMs: 0, endMs: 1000, text: 'Hello there.' },
            { startMs: 1100, endMs: 1500, text: 'Bye.' },
        ]);
    });

    it('does not start a segment on a spacing entry', () => {
        // A leading space must not set the segment start, or the segment would
        // begin on a silent gap before the first word.
        const [seg] = groupIntoSegments([spacing(0, 0.4), word('Hello.', 0.4, 1)]);
        expect(seg?.startMs).toBe(400);
    });

    it('cuts an overlong segment even without sentence punctuation', () => {
        // Dictation with no final punctuation would otherwise collapse into one
        // segment spanning the whole clip, defeating the point of timings.
        const words = Array.from({ length: 30 }, (_, i) => word(`w${i}`, i, i + 1));
        const segments = groupIntoSegments(words);
        expect(segments.length).toBeGreaterThan(1);
        for (const seg of segments) {
            expect(seg.endMs - seg.startMs).toBeLessThanOrEqual(13_000);
        }
    });

    it('ends sentences on CJK punctuation', () => {
        // An ASCII-only check would emit one segment for a whole Japanese clip.
        const segments = groupIntoSegments([word('こんにちは。', 0, 1), word('さようなら。', 1, 2)]);
        expect(segments).toHaveLength(2);
    });

    it('never emits a segment whose end precedes its start', () => {
        // A provider reporting an inverted span would otherwise produce a
        // record that fails the schema refinement at save time.
        const segments = groupIntoSegments([word('Odd.', 5, 1)]);
        expect(TimedTranscriptSchema.safeParse({ segments }).success).toBe(true);
        expect(segments[0]!.endMs).toBeGreaterThanOrEqual(segments[0]!.startMs);
    });

    it('treats missing or invalid timings as zero rather than NaN', () => {
        const segments = groupIntoSegments([{ text: 'No timings.', type: 'word' }]);
        expect(segments).toEqual([{ startMs: 0, endMs: 0, text: 'No timings.' }]);
        expect(TimedTranscriptSchema.safeParse({ segments }).success).toBe(true);
    });

    it('drops empty and whitespace-only output', () => {
        expect(groupIntoSegments([])).toEqual([]);
        expect(groupIntoSegments([spacing(0, 1)])).toEqual([]);
    });

    it('produces a schema-valid transcript for a realistic response', () => {
        const segments = groupIntoSegments([
            word('What', 0, 0.3),
            spacing(0.3, 0.35),
            word('do', 0.35, 0.5),
            spacing(0.5, 0.55),
            word('you', 0.55, 0.7),
            spacing(0.7, 0.75),
            word('think?', 0.75, 1.2),
        ]);
        const parsed = TimedTranscriptSchema.safeParse({ segments, text: 'What do you think?' });
        expect(parsed.success).toBe(true);
        expect(segments).toHaveLength(1);
        expect(segments[0]!.text).toBe('What do you think?');
    });
});

describe('normalizeLang', () => {
    it('maps Scribe ISO-639-3 codes to BCP-47', () => {
        // Verified against a live Scribe response, which returns `eng` for
        // English. The lexicon specifies BCP-47 (`en`), and `lang` is a bare
        // `z.string()` — so an un-normalized code would validate and land in an
        // immutable published record.
        expect(normalizeLang('eng')).toBe('en');
        expect(normalizeLang('fra')).toBe('fr');
        expect(normalizeLang('jpn')).toBe('ja');
    });

    it('leaves codes with no two-letter form alone', () => {
        // `yue`/`haw` have no ISO-639-1 equivalent, so the three-letter code
        // already IS canonical BCP-47.
        expect(normalizeLang('yue')).toBe('yue');
        expect(normalizeLang('haw')).toBe('haw');
    });

    it('passes through codes that are already BCP-47', () => {
        expect(normalizeLang('en')).toBe('en');
    });

    it('returns undefined for a missing or blank code', () => {
        expect(normalizeLang(undefined)).toBeUndefined();
        expect(normalizeLang('  ')).toBeUndefined();
    });

    it('passes through an unparseable tag rather than dropping provenance', () => {
        expect(normalizeLang('not a tag!')).toBe('not a tag!');
    });
});

describe('elevenLabsTranscriber request', () => {
    const fetchMock = vi.fn();
    let savedKey: string | undefined;

    beforeEach(() => {
        savedKey = process.env.ELEVENLABS_API_KEY;
        process.env.ELEVENLABS_API_KEY = 'test-key';
        vi.stubGlobal('fetch', fetchMock);
        fetchMock.mockReset();
        // A real `Response`, not a duck-typed literal: the client drains the
        // body itself, and a stub carrying only the methods today's caller
        // happens to use hides that from the test. Built per call because a
        // body can only be read once.
        fetchMock.mockImplementation(
            async () =>
                new Response(
                    JSON.stringify({ language_code: 'eng', text: 'hi.', words: [{ text: 'hi.', start: 0, end: 1, type: 'word' }] }),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                ),
        );
    });

    afterEach(() => {
        // Restore rather than delete: clearing a developer's real key would
        // change how later tests in the same process resolve providers.
        if (savedKey === undefined) delete process.env.ELEVENLABS_API_KEY;
        else process.env.ELEVENLABS_API_KEY = savedKey;
        vi.unstubAllGlobals();
    });

    const formOf = () => fetchMock.mock.calls[0]![1].body as FormData;

    it('strips the region subtag from a BCP-47 hint', async () => {
        await elevenLabsTranscriber.transcribe({ bytes: new Uint8Array([1]), mimeType: 'audio/wav', langHint: 'en-US' });
        expect(formOf().get('language_code')).toBe('en');
    });

    it('strips the region subtag from an underscore-separated hint', async () => {
        // `langs` is a bare `z.string()`, so a POSIX-style `en_US` validates at
        // the API boundary and lands in an immutable record. Forwarding it
        // whole would 400 and lose the transcript.
        await elevenLabsTranscriber.transcribe({ bytes: new Uint8Array([1]), mimeType: 'audio/wav', langHint: 'en_US' });
        expect(formOf().get('language_code')).toBe('en');
    });

    it('omits language_code for a whitespace-only hint', async () => {
        // Regression: a whitespace hint is truthy but yields a blank code,
        // which fails the whole request with a 400 — losing a transcript over
        // a bad hint that is safe to omit.
        await elevenLabsTranscriber.transcribe({ bytes: new Uint8Array([1]), mimeType: 'audio/wav', langHint: '   ' });
        expect(formOf().has('language_code')).toBe(false);
    });

    it('omits language_code when no hint is given', async () => {
        await elevenLabsTranscriber.transcribe({ bytes: new Uint8Array([1]), mimeType: 'audio/wav' });
        expect(formOf().has('language_code')).toBe(false);
    });

    it('normalizes the returned language to BCP-47', async () => {
        const r = await elevenLabsTranscriber.transcribe({ bytes: new Uint8Array([1]), mimeType: 'audio/wav' });
        expect(r.lang).toBe('en');
    });
});
