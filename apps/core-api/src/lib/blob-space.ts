import type { SpaceKey } from 'shared/types/spaces';

/**
 * The space a stored blob belongs to, recorded in the object's own metadata
 * (specs/spaces.md, Phase 2, open question 3).
 *
 * Why metadata rather than a separate path prefix: every path that names a blob
 * (`blobs/{originAppId}/{cid}`) stays exactly as it is, so renditions, the
 * processing pipeline and the separately deployed transcode container need no
 * change, and the audio proxy learns a blob's visibility from the object it was
 * already fetching, with no database read on the playback path.
 *
 * Absent ⇒ public, which is every blob stored before spaces existed. The value
 * is `{type}/{skey}`: neither an NSID nor a record key can contain `/`, so it
 * splits unambiguously. Set by the FIRST upload of a blob's bytes and never
 * changed after (see audio-upload.ts), so re-uploading identical bytes can
 * neither expose private audio nor hide public audio.
 */
export const BLOB_SPACE_METADATA_KEY = 'antiphony-space';

export function blobSpaceMetadata(space: SpaceKey): Record<string, string> {
    return { [BLOB_SPACE_METADATA_KEY]: `${space.type}/${space.skey}` };
}

/** The space recorded on a blob, or null for a public one. */
export function blobSpaceOf(metadata: Record<string, string> | undefined): SpaceKey | null {
    const raw = metadata?.[BLOB_SPACE_METADATA_KEY];
    if (!raw) return null;
    const slash = raw.indexOf('/');
    if (slash <= 0 || slash === raw.length - 1) {
        // Unreadable means we can't say which space it's in, not that it's public.
        // Fail closed: treat it as private to a space nobody can name.
        return { type: 'invalid.antiphony.space', skey: 'unreadable' };
    }
    return { type: raw.slice(0, slash), skey: raw.slice(slash + 1) };
}
