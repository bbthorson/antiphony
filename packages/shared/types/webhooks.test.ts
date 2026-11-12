import { describe, it, expect } from 'vitest';
import {
    PostDeletedWebhookSchema,
    RemoteChangedWebhookSchema,
    RemoteGoneWebhookSchema,
    RemoteRecheckRequestedWebhookSchema,
    StageSettledWebhookSchema,
    WEBHOOK_EVENT_ID_HEADER,
    WEBHOOK_EVENT_TYPES,
    WEBHOOK_SIGNATURE_HEADER,
    WEBHOOK_TIMESTAMP_HEADER,
    WebhookEventSchema,
} from './webhooks';

const AT = '2026-11-12T10:00:00.000Z';
const HOSTED = 'at://did:web:voxpop.example/dev.antiphony.audio.post/3kb2hosted';
const REMOTE = 'at://did:plc:abcdefghijklmnopqrstuvwx/dev.antiphony.audio.post/3kremote00001';
const SPACE = 'at://did:plc:groupaaaaaaaaaaaaaaaaaaa/space/game.bardcast.space.campaign/thornwood';

const SETTLED_MIN = { type: 'stage.settled', uri: REMOTE, originAppId: 'vox-pop', stage: 'waveform', status: 'skipped', occurredAt: AT };
const SETTLED_FULL = { ...SETTLED_MIN, uri: HOSTED, postId: '3kb2hosted', stage: 'transcribe', status: 'ready' };
const DELETED = { type: 'post.deleted', originAppId: 'vox-pop', postId: 'p1', uri: HOSTED, kind: 'reply', occurredAt: AT };
const GONE = { type: 'remote.gone', originAppId: 'vox-pop', uri: REMOTE, occurredAt: AT };
const CHANGED_MIN = { type: 'remote.changed', originAppId: 'vox-pop', uri: REMOTE, occurredAt: AT };
const CHANGED_FULL = { ...CHANGED_MIN, cid: 'bafyreinew' };
const RECHECK_MIN = { type: 'remote.recheck_requested', originAppId: 'vox-pop', uri: SPACE, occurredAt: AT };
const RECHECK_FULL = { ...RECHECK_MIN, space: SPACE };

const ALL = [SETTLED_MIN, SETTLED_FULL, DELETED, GONE, CHANGED_MIN, CHANGED_FULL, RECHECK_MIN, RECHECK_FULL];

describe('webhook payload schemas', () => {
    it.each([
        ['stage.settled (remote, minimal)', StageSettledWebhookSchema, SETTLED_MIN],
        ['stage.settled (hosted, full)', StageSettledWebhookSchema, SETTLED_FULL],
        ['post.deleted', PostDeletedWebhookSchema, DELETED],
        ['remote.gone', RemoteGoneWebhookSchema, GONE],
        ['remote.changed (minimal)', RemoteChangedWebhookSchema, CHANGED_MIN],
        ['remote.changed (full)', RemoteChangedWebhookSchema, CHANGED_FULL],
        ['remote.recheck_requested (minimal)', RemoteRecheckRequestedWebhookSchema, RECHECK_MIN],
        ['remote.recheck_requested (full)', RemoteRecheckRequestedWebhookSchema, RECHECK_FULL],
    ])('accepts %s and returns it unchanged', (_name, schema, body) => {
        expect(schema.parse(body)).toEqual(body);
    });

    it('accepts every body through the union, and each lands on its own type', () => {
        for (const body of ALL) {
            const parsed = WebhookEventSchema.parse(body);
            expect(parsed.type).toBe(body.type);
        }
    });

    it('leaves postId absent for a remote post settling, rather than inventing one', () => {
        const parsed = StageSettledWebhookSchema.parse(SETTLED_MIN);
        expect(parsed).not.toHaveProperty('postId');
    });

    it('refuses pending: it is not a settle and never fires', () => {
        expect(StageSettledWebhookSchema.safeParse({ ...SETTLED_FULL, status: 'pending' }).success).toBe(false);
        expect(WebhookEventSchema.safeParse({ ...SETTLED_FULL, status: 'pending' }).success).toBe(false);
    });

    it.each(['ready', 'failed', 'skipped'])('accepts the terminal status %s', (status) => {
        expect(StageSettledWebhookSchema.safeParse({ ...SETTLED_FULL, status }).success).toBe(true);
    });

    it('refuses an unknown stage and a non-datetime occurredAt', () => {
        expect(StageSettledWebhookSchema.safeParse({ ...SETTLED_FULL, stage: 'mix' }).success).toBe(false);
        expect(StageSettledWebhookSchema.safeParse({ ...SETTLED_FULL, occurredAt: 'yesterday' }).success).toBe(false);
    });

    it('refuses a missing required field on each event', () => {
        expect(StageSettledWebhookSchema.safeParse({ ...SETTLED_FULL, uri: undefined }).success).toBe(false);
        expect(PostDeletedWebhookSchema.safeParse({ ...DELETED, kind: 'comment' }).success).toBe(false);
        expect(PostDeletedWebhookSchema.safeParse({ ...DELETED, postId: undefined }).success).toBe(false);
        expect(RemoteGoneWebhookSchema.safeParse({ ...GONE, originAppId: undefined }).success).toBe(false);
    });

    it('requires the space URI shape for a recheck request, not a record URI', () => {
        expect(RemoteRecheckRequestedWebhookSchema.safeParse({ ...RECHECK_FULL, uri: REMOTE }).success).toBe(false);
        expect(RemoteRecheckRequestedWebhookSchema.safeParse({ ...RECHECK_FULL, space: REMOTE }).success).toBe(false);
    });

    it('tolerates a field added later: parsing succeeds and the known fields survive', () => {
        for (const body of ALL) {
            const parsed = WebhookEventSchema.parse({ ...body, addedInTheFuture: { nested: true } });
            expect(parsed).toMatchObject(body);
        }
    });

    it('does not parse a body of an unknown type, so a receiver must check the type first', () => {
        const future = { ...GONE, type: 'post.moved' };
        expect(WebhookEventSchema.safeParse(future).success).toBe(false);
        expect(WEBHOOK_EVENT_TYPES).not.toContain(future.type);
    });

    it('lists exactly the five event types the union accepts', () => {
        expect([...WEBHOOK_EVENT_TYPES].sort()).toEqual(
            ['post.deleted', 'remote.changed', 'remote.gone', 'remote.recheck_requested', 'stage.settled'],
        );
    });

    it('names the three headers as the sender writes them', () => {
        expect(WEBHOOK_SIGNATURE_HEADER).toBe('X-Antiphony-Signature');
        expect(WEBHOOK_TIMESTAMP_HEADER).toBe('X-Antiphony-Timestamp');
        expect(WEBHOOK_EVENT_ID_HEADER).toBe('X-Antiphony-Event-Id');
    });
});
