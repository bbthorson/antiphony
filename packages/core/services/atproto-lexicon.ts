import { NSID } from 'shared/nsid';
import type { PromptRecord, UserRecord } from 'shared/types/records';
import type { BlobRef } from 'shared/types/blob';

/**
 * AT Protocol blob, in the JSON wire shape that `Agent.com.atproto.repo.putRecord`
 * accepts. Note `ref: { $link: string }` — the canonical CID-link envelope —
 * which differs from how `BlobRefSchema` stores the value internally
 * (`ref: string`). The wire format is the source of truth at publish time;
 * this module is the boundary that converts.
 */
export interface LexiconBlob {
    $type: 'blob';
    ref: { $link: string };
    mimeType: string;
    size: number;
}

/**
 * `com.voxpop.audio.prompt` lexicon record shape. Mirrors
 * `lexicons/com/voxpop/audio/prompt.json`.
 */
export interface PromptLexiconRecord {
    $type: typeof NSID.Prompt;
    title: string;
    description?: string;
    /**
     * Omitted when the record has no `BlobRef` yet — see TODO in
     * `blobRefToLexicon`. AT Protocol lexicons treat optional fields as
     * absent vs. present; `null` is not a valid lexicon value.
     */
    audio?: LexiconBlob;
    createdAt: string;
    status: 'live' | 'archived';
}

/**
 * `com.voxpop.actor.profile` lexicon record shape. Mirrors
 * `lexicons/com/voxpop/actor/profile.json`.
 */
export interface ProfileLexiconRecord {
    $type: typeof NSID.Profile;
    handle?: string;
    usageIntent?: string;
    // rssFeed is declared in the lexicon JSON but intentionally absent from
    // the transformation today — see TODO in `profileRecordToLexicon`.
}

/**
 * Convert a `BlobRef` (storage shape) into the lexicon wire shape, or
 * `undefined` when the record carries no blob (so the caller can omit the
 * field entirely — AT Protocol lexicons don't model `null` as a value).
 *
 * TODO(blob-cid-migration): During the `audioUrl` → `audio: BlobRef` migration,
 * `BlobRef.ref` may transiently hold a Firebase Storage URL instead of a real
 * CID. Apps/web's publisher must call `repo.uploadBlob` to obtain a CID and
 * augment the record before invoking `promptRecordToLexicon` — this function
 * passes whatever `ref` is present straight through.
 */
function blobRefToLexicon(blob: BlobRef | undefined): LexiconBlob | undefined {
    if (!blob) return undefined;
    return {
        $type: 'blob',
        ref: { $link: blob.ref },
        mimeType: blob.mimeType,
        size: blob.size,
    };
}

function toIsoString(value: Date | string | number): string {
    if (value instanceof Date) return value.toISOString();
    return new Date(value).toISOString();
}

/**
 * Convert a stored `PromptRecord` into the AT Protocol lexicon shape ready
 * for `repo.putRecord`. Pure — no I/O, no auth, no SDK dependency.
 *
 * Callers should filter out `status === 'deleted'` records before publishing;
 * this function defensively maps `'deleted'` → `'archived'` so a misuse can't
 * crash, but a deleted prompt should not appear on the user's PDS.
 */
export function promptRecordToLexicon(record: PromptRecord): PromptLexiconRecord {
    const status: 'live' | 'archived' = record.status === 'live' ? 'live' : 'archived';

    const out: PromptLexiconRecord = {
        $type: NSID.Prompt,
        title: record.title,
        createdAt: toIsoString(record.createdAt),
        status,
    };

    if (record.description) {
        out.description = record.description;
    }

    const audio = blobRefToLexicon(record.audio);
    if (audio) {
        out.audio = audio;
    }

    return out;
}

/**
 * Convert a stored `UserRecord` into the AT Protocol lexicon shape ready
 * for `repo.putRecord` against the user's PDS at the `self` rkey.
 *
 * TODO(profile-rssfeed): The lexicon declares `rssFeed`, but the value lives
 * on `OrganizationRecord.rssFeedUrl`, not `UserRecord`. Apps/web's publisher
 * needs to load the user's primary org and merge the feed URL in before
 * publishing if it should appear on the profile record.
 */
export function profileRecordToLexicon(record: UserRecord): ProfileLexiconRecord {
    const out: ProfileLexiconRecord = {
        $type: NSID.Profile,
    };

    if (record.handle) {
        out.handle = record.handle;
    }
    if (record.usageIntent) {
        out.usageIntent = record.usageIntent;
    }

    return out;
}
