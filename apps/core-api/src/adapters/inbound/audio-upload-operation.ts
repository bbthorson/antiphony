import { ScopedSpaceKeySchema, type ScopedSpaceKey } from 'shared/types/spaces';
import type { RemoteSpace } from 'shared/types/remote-posts';
import type { UploadAudioResult } from 'shared/api-codecs';
import { NotFoundError, ServiceError } from 'shared/errors';
import { parseRemoteSpaceUri } from '@antiphony/core/services/remote-posts';
import type { servicesFor } from '../../composition.js';
import { cidForBytes } from '../../lib/cid.js';
import { blobObjectPath } from '../../lib/blob-path.js';
import { blobSpaceMetadata, blobSpaceOf } from '../../lib/blob-space.js';
import { getAppDid } from '../../lib/app-did.js';

/**
 * Shared audio-upload operation called by both REST (`POST /api/v1/audio/upload`,
 * multipart) and XRPC (`POST /xrpc/dev.antiphony.audio.uploadAudio`, raw body).
 *
 * Validation and domain refusals throw `ServiceError` so each inbound adapter's
 * error handler renders them in its own dialect (REST envelope vs. XRPC
 * `{ error, message }`).
 */

export const ALLOWED_AUDIO_UPLOAD_TYPES = new Set([
    'audio/m4a',
    'audio/x-m4a',
    'audio/mp4',
    'audio/mpeg',
    'audio/webm',
    'audio/ogg',
    'audio/wav',
]);

export const MAX_AUDIO_UPLOAD_SIZE = 25 * 1024 * 1024; // 25 MB

/** Strip any `; codecs=…` media-type parameters and normalise case. */
export function normalizeAudioMimeType(raw: string | undefined): string {
    if (!raw) return '';
    return raw.split(';', 1)[0].trim().toLowerCase();
}

export interface StoreUploadedAudioInput {
    originAppId: string;
    bytes: Buffer;
    mimeType: string;
    spaceType?: string | null;
    skey?: string | null;
    spaceAuthority?: string | null;
    remoteSpace?: string | null;
    services: ReturnType<typeof servicesFor>;
}

/** Whether `did` is the tenant's app DID or a DID it registered: its spaces are hosted here. */
async function isHostedAuthority(
    originAppId: string,
    did: string,
    services: ReturnType<typeof servicesFor>,
): Promise<boolean> {
    if (did === getAppDid(originAppId)) return true;
    try {
        await services.didRegistryService.get(originAppId, did);
        return true;
    } catch (err) {
        if (err instanceof NotFoundError) return false;
        throw err;
    }
}

export async function storeUploadedAudio(input: StoreUploadedAudioInput): Promise<UploadAudioResult> {
    const { originAppId, bytes, mimeType, services } = input;
    const spaceType = input.spaceType ?? null;
    const skey = input.skey ?? null;
    const spaceAuthority = input.spaceAuthority ?? null;
    const remoteSpace = input.remoteSpace ?? null;

    if (bytes.byteLength > MAX_AUDIO_UPLOAD_SIZE) {
        throw new ServiceError('File too large (max 25MB)', 400);
    }

    if (!ALLOWED_AUDIO_UPLOAD_TYPES.has(mimeType)) {
        throw new ServiceError(`Unsupported audio type: ${mimeType}`, 400);
    }

    // Both or neither: half a space names nothing. An authority alone names nothing either.
    let requested: ScopedSpaceKey | undefined;
    if (remoteSpace !== null) {
        if (spaceType !== null || skey !== null || spaceAuthority !== null) {
            throw new ServiceError('Send "remoteSpace" or "spaceType" + "skey", not both', 400);
        }
        const space: RemoteSpace = parseRemoteSpaceUri(remoteSpace);
        if (await isHostedAuthority(originAppId, space.authority, services)) {
            throw new ServiceError(
                'That space is under a DID this tenant hosts here; upload with "spaceType", "skey" and "spaceAuthority"',
                400,
            );
        }
        // Recorded with its authority always: it is never the app DID.
        requested = space;
    } else if (spaceType !== null || skey !== null || spaceAuthority !== null) {
        const parsed = ScopedSpaceKeySchema.safeParse({
            type: spaceType,
            skey,
            ...(spaceAuthority !== null ? { authority: spaceAuthority } : {}),
        });
        if (!parsed.success) {
            throw new ServiceError(
                'Invalid space: send both "spaceType" and "skey", and "spaceAuthority" only as a DID',
                400,
                { issues: parsed.error.issues },
            );
        }
        // Throws 404 for a space this tenant doesn't have under that authority.
        await services.spaceService.getSpace(originAppId, parsed.data);
        // Recorded as the services store it: no authority for the app DID.
        const { authority, ...key } = parsed.data;
        requested = authority !== undefined && authority !== getAppDid(originAppId) ? { ...key, authority } : key;
    }

    const cid = await cidForBytes(bytes);
    const path = blobObjectPath(originAppId, cid);
    if (!path) {
        // Only reachable with a misconfigured origin app id — surface loudly.
        throw new ServiceError('Blob path could not be derived', 400);
    }

    // First upload wins: an object already there keeps its bytes and its
    // visibility. Two concurrent first uploads race to the same bytes, and the
    // later marker wins; both callers then see `space` on a re-read, and a
    // post's placement check refuses the mismatch either way.
    const existing = await services.storage.stat(path);
    let space: ScopedSpaceKey | null;
    if (existing) {
        space = blobSpaceOf(existing.metadata);
    } else {
        await services.storage.uploadFile(
            bytes,
            path,
            mimeType,
            requested ? { metadata: blobSpaceMetadata(requested) } : undefined,
        );
        space = requested ?? null;
    }

    return {
        blob: {
            $type: 'blob' as const,
            ref: { $link: cid },
            mimeType,
            size: bytes.byteLength,
        },
        ...(space
            ? {
                  space: {
                      type: space.type,
                      skey: space.skey,
                      ...(space.authority !== undefined ? { authority: space.authority } : {}),
                  },
              }
            : {}),
    };
}
