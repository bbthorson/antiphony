/**
 * Example records and field notes for the lexicons page. Values are
 * illustrative (CIDs shortened, the playback URL elided); the field lists
 * follow lexicons/dev/antiphony/.
 */
import { pretty } from './code';

const BLOB = {
	$type: 'blob',
	ref: { $link: 'bafkreihdwdcefgh4dqkjv67uzc…' },
	mimeType: 'audio/mp4',
	size: 672310,
};

const REF = {
	uri: 'at://did:web:voxpop.audio/dev.antiphony.audio.post/3k6w',
	cid: 'bafyreib2rxk3ry…',
};

export const examples = {
	prompt: pretty({
		$type: 'dev.antiphony.audio.post',
		text: 'First-job advice?',
		title: 'Your first year at work',
		embed: { $type: 'dev.antiphony.embed.audio', audio: BLOB, durationMs: 42000 },
		langs: ['en'],
		createdAt: '2026-09-24T18:00:00.000Z',
	}),
	reply: pretty({
		$type: 'dev.antiphony.audio.post',
		text: '',
		embed: { $type: 'dev.antiphony.embed.audio', audio: BLOB, durationMs: 31000 },
		reply: { root: REF, parent: REF },
		langs: ['en'],
		createdAt: '2026-09-24T18:06:12.000Z',
	}),
	record: pretty({
		$type: 'dev.antiphony.embed.audio',
		audio: BLOB,
		durationMs: 42000,
		alt: 'Alice asks about first jobs',
		waveform: [12, 28, 45, 60, 75, 90, 85, 60],
	}),
	view: pretty({
		$type: 'dev.antiphony.embed.audio#view',
		url: 'https://…/signed-playback-url',
		durationMs: 38400,
		waveform: [10, 31, 52, 64, 80, 88, 71, 49],
		alt: 'Alice asks about first jobs',
		transcript: {
			segments: [{ startMs: 0, endMs: 2400, text: 'What’s the best advice…' }],
			text: 'What’s the best advice you got in your first year of work?',
		},
	}),
	transcript: pretty({
		$type: 'dev.antiphony.audio.transcript',
		subject: REF,
		transcript: {
			segments: [
				{ startMs: 0, endMs: 2400, text: 'What’s the best advice' },
				{ startMs: 2400, endMs: 4100, text: 'you got in your first year?' },
			],
		},
		lang: 'en',
		model: 'whisper',
		createdAt: '2026-09-24T18:00:41.000Z',
	}),
	blob: pretty(BLOB),
};

export const postFields = [
	{ field: 'text', type: 'string', note: 'What the author typed: a question or caption. Can be empty for audio-only posts. Required.' },
	{ field: 'title', type: 'string?', note: 'Optional headline for prompts. It does not decide whether a post is a prompt.', variant: 'prompt' },
	{ field: 'embed', type: 'union?', note: 'The audio. Usually embed.audio; also recordWithAudio, a bsky record or an external link.' },
	{ field: 'reply', type: 'ref?', note: 'Present only on replies: { root, parent }, each a strongRef.', variant: 'reply' },
	{ field: 'langs', type: 'string[]?', note: 'Up to three BCP-47 language tags.' },
	{ field: 'labels', type: 'union?', note: 'Content warnings the author applies to their own post.' },
	{ field: 'createdAt', type: 'datetime', note: 'ISO 8601. Required.' },
];

export const embedRecordFields = [
	{ field: 'audio', type: 'blob', note: 'audio/*, up to 100 MB, addressed by CID. Required. The upload endpoint has a tighter limit.' },
	{ field: 'durationMs', type: 'integer?', note: 'Duration in milliseconds, the unit used everywhere.' },
	{ field: 'alt', type: 'string?', note: 'A short description the author writes, like image alt text. Not the transcript.' },
	{ field: 'waveform', type: 'integer[]?', note: 'Peaks normalized 0–100, so players can draw instantly.' },
];

export const embedViewFields = [
	{ field: 'url', type: 'uri', note: 'A playable URL: the processed variant if one exists, otherwise the original. Short-lived and signed. Required.' },
	{ field: 'durationMs', type: 'integer?', note: 'The processed duration once trim has run; otherwise the record value.' },
	{ field: 'waveform', type: 'integer[]?', note: 'Server-computed peaks once the waveform stage is ready; otherwise the client peaks.' },
	{ field: 'alt', type: 'string?', note: 'Copied from the record, never processed.' },
	{ field: 'transcript', type: 'ref?', note: 'Lifted from the transcript record at read time. Absent until transcription finishes.' },
];

export const transcriptFields = [
	{ field: 'subject', type: 'strongRef', note: 'The post whose audio this transcribes. Required.' },
	{ field: 'transcript', type: 'ref', note: 'A #timedTranscript: segments plus an optional text rollup. Required.' },
	{ field: 'lang', type: 'string?', note: 'BCP-47 tag of the transcript.' },
	{ field: 'model', type: 'string?', note: 'The model or provider that produced it.' },
	{ field: 'createdAt', type: 'datetime', note: 'Required.' },
];
